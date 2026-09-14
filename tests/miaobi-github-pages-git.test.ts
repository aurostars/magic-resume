import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createGitCommandRunner, type GitCommandRunner } from "../scripts/miaobi/git-runner";
import {
  createGitHubPagesAdmin,
  publishGitHubPages,
  type GitHubPagesAdmin,
} from "../scripts/miaobi/publish-github-pages";

const SOURCE_COMMIT = "d26c16fcfcec3cb7b73d3d6002aebdf212422f21";
const RELEASE_ID = "d26c16fcfcec-20260914142200";
const EXPECTED_FORK = "https://github.com/aurostars/magic-resume.git";

type Fixture = {
  root: string;
  repository: string;
  remote: string;
  client: string;
  runner: RecordingLocalForkRunner;
  admin: FakeAdmin;
};

async function command(executable: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`command failed: ${executable}`), { ...result, exitCode: code }));
    });
  });
}

class RecordingLocalForkRunner implements GitCommandRunner {
  readonly calls: Array<{ args: string[]; cwd?: string }> = [];
  fail?: (args: string[], options?: { cwd?: string }) => Error | undefined;
  before?: (args: string[], options?: { cwd?: string }) => Promise<void>;

  constructor(readonly remote: string) {}

  async run(args: string[], options?: { cwd?: string }) {
    assert.ok(Array.isArray(args));
    assert.equal(args.every((argument) => typeof argument === "string"), true);
    this.calls.push({ args: [...args], cwd: options?.cwd });
    const failure = this.fail?.(args, options);
    if (failure) throw failure;
    await this.before?.(args, options);
    if (args[0] === "remote" && args[1] === "get-url" && args.at(-1) === "fork") {
      return { stdout: `${EXPECTED_FORK}\n`, stderr: "" };
    }
    try {
      return await command("git", args, options?.cwd);
    } catch (error) {
      if (args[0] === "push" && /non-fast-forward|fetch first|stale info/i.test((error as { stderr?: string }).stderr ?? "")) {
        Object.assign(error as object, { kind: "non-fast-forward" });
      }
      throw error;
    }
  }
}

class FakeAdmin implements GitHubPagesAdmin {
  readonly calls: Array<{ owner: string; repo: string; branch: string; path: string }> = [];
  async ensureBranchSource(input: { owner: "aurostars"; repo: "magic-resume"; branch: "gh-pages"; path: "/" }) {
    this.calls.push(input);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "miaobi-pages-git-")));
  const remote = join(root, "fork.git");
  const repository = join(root, "repository");
  const client = join(root, "client");
  await command("git", ["init", "--bare", remote]);
  await command("git", ["init", repository]);
  await command("git", ["config", "user.name", "Pages Test"], repository);
  await command("git", ["config", "user.email", "pages@example.test"], repository);
  await writeFile(join(repository, "README.md"), "source\n");
  await command("git", ["add", "README.md"], repository);
  await command("git", ["commit", "-m", "source"], repository);
  await command("git", ["remote", "add", "origin", join(root, "origin-must-not-be-used.git")], repository);
  await command("git", ["remote", "add", "fork", remote], repository);
  await mkdir(client);
  await writeFile(join(client, "app.js"), "console.log('safe')\n");
  return { root, remote, repository, client, runner: new RecordingLocalForkRunner(remote), admin: new FakeAdmin() };
}

function publicationInput(value: Fixture) {
  return {
    repositoryDirectory: value.repository,
    clientDirectory: value.client,
    sourceCommit: SOURCE_COMMIT,
    releaseId: RELEASE_ID,
    runner: value.runner,
    admin: value.admin,
  };
}

async function worktreePaths(repository: string): Promise<string[]> {
  const output = await command("git", ["worktree", "list", "--porcelain"], repository);
  return output.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
}

async function seedPages(remote: string, root: string, content = "preserved\n"): Promise<string> {
  const seed = join(root, `seed-${Math.random().toString(16).slice(2)}`);
  await command("git", ["clone", remote, seed]);
  await command("git", ["config", "user.name", "Seed"], seed);
  await command("git", ["config", "user.email", "seed@example.test"], seed);
  await command("git", ["switch", "--orphan", "gh-pages"], seed);
  await writeFile(join(seed, "existing.txt"), content);
  await command("git", ["add", "existing.txt"], seed);
  await command("git", ["commit", "-m", "seed pages"], seed);
  await command("git", ["push", "origin", "HEAD:gh-pages"], seed);
  return (await command("git", ["rev-parse", "HEAD"], seed)).stdout.trim();
}

async function remoteFile(remote: string, path: string): Promise<string> {
  return (await command("git", ["--git-dir", remote, "show", `gh-pages:${path}`])).stdout;
}

async function publish(value: Fixture) {
  return publishGitHubPages(publicationInput(value));
}

test("rejects a missing or wrong fork before creating worktrees or changing refs", async () => {
  for (const remoteUrl of [undefined, "https://github.com/attacker/magic-resume.git"]) {
    const value = await fixture();
    try {
      value.runner.run = async (args, options) => {
        value.runner.calls.push({ args: [...args], cwd: options?.cwd });
        if (args[0] === "remote" && args[1] === "get-url") {
          if (remoteUrl === undefined) throw new Error("missing remote");
          return { stdout: `${remoteUrl}\n`, stderr: "" };
        }
        return command("git", args, options?.cwd);
      };
      await assert.rejects(publish(value), { message: "MIAOBI_INVALID_FORK" });
      assert.deepEqual(await worktreePaths(value.repository), [value.repository]);
      assert.equal(await exists(join(value.remote, "refs", "heads", "gh-pages")), false);
      assert.deepEqual(value.admin.calls, []);
      assert.equal(value.runner.calls.some(({ args }) => args.includes("push")), false);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("accepts normalized GitHub HTTPS and SSH fork URLs only for the exact repository", async () => {
  const accepted = [
    "https://github.com/aurostars/magic-resume",
    "https://github.com/aurostars/magic-resume.git/",
    "git" + "@github.com:aurostars/magic-resume.git",
    "ssh://git" + "@github.com/aurostars/magic-resume.git",
  ];
  for (const remoteUrl of accepted) {
    const value = await fixture();
    try {
      const original = value.runner.run.bind(value.runner);
      value.runner.run = async (args, options) =>
        args[0] === "remote" && args[1] === "get-url"
          ? { stdout: `${remoteUrl}\n`, stderr: "" }
          : original(args, options);
      const result = await publish(value);
      assert.equal(result.pagesBaseUrl, "https://aurostars.github.io/magic-resume/");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("first publication creates an orphan gh-pages root, materializes assets, and never pushes origin or force", async () => {
  const value = await fixture();
  try {
    const sourceRoot = (await command("git", ["rev-list", "--max-parents=0", "HEAD"], value.repository)).stdout.trim();
    const result = await publish(value);
    const pagesRoot = (await command("git", ["--git-dir", value.remote, "rev-list", "--max-parents=0", "gh-pages"])).stdout.trim();
    assert.notEqual(pagesRoot, sourceRoot);
    assert.equal(await remoteFile(value.remote, ".nojekyll"), "");
    assert.equal(await remoteFile(value.remote, result.manifest.files["app.js"].objectPath), "console.log('safe')\n");
    assert.deepEqual(JSON.parse(await remoteFile(value.remote, `releases/${SOURCE_COMMIT}/manifest.json`)), result.manifest);
    assert.match(result.pagesCommit, /^[0-9a-f]{40}$/);
    assert.equal(result.releaseManifestUrl, `https://aurostars.github.io/magic-resume/releases/${SOURCE_COMMIT}/manifest.json`);
    assert.deepEqual(value.admin.calls, [{ owner: "aurostars", repo: "magic-resume", branch: "gh-pages", path: "/" }]);
    const pushes = value.runner.calls.filter(({ args }) => args[0] === "push").map(({ args }) => args);
    assert.deepEqual(pushes, [["push", "fork", "HEAD:gh-pages"]]);
    assert.equal(pushes.flat().some((argument) => argument === "origin" || argument.includes("force")), false);
    assert.equal(value.runner.calls.flatMap(({ args }) => args).some((argument) =>
      argument === "-f" || argument === "--force" || /^-[^-]*f/.test(argument) || argument.includes("force")
    ), false);
    assert.deepEqual(await worktreePaths(value.repository), [value.repository]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("publishes from existing fork/gh-pages and a deduplicated rerun creates no commit", async () => {
  const value = await fixture();
  try {
    const seed = await seedPages(value.remote, value.root);
    const first = await publish(value);
    assert.equal(await remoteFile(value.remote, "existing.txt"), "preserved\n");
    const second = await publish(value);
    assert.notEqual(first.pagesCommit, seed);
    assert.equal(second.pagesCommit, first.pagesCommit);
    assert.equal((await command("git", ["--git-dir", value.remote, "rev-list", "--count", "gh-pages"])).stdout.trim(), "2");
    assert.deepEqual(await worktreePaths(value.repository), [value.repository]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retries a non-fast-forward in a fresh worktree and preserves the competing commit", async () => {
  const value = await fixture();
  try {
    await seedPages(value.remote, value.root);
    let injected = false;
    value.runner.before = async (args) => {
      if (args[0] !== "push" || injected) return;
      injected = true;
      const competitor = join(value.root, "competitor");
      await command("git", ["clone", "--branch", "gh-pages", value.remote, competitor]);
      await command("git", ["config", "user.name", "Competitor"], competitor);
      await command("git", ["config", "user.email", "competitor@example.test"], competitor);
      await writeFile(join(competitor, "competitor.txt"), "wins race\n");
      await command("git", ["add", "competitor.txt"], competitor);
      await command("git", ["commit", "-m", "competing pages"], competitor);
      await command("git", ["push", "origin", "HEAD:gh-pages"], competitor);
    };
    const result = await publish(value);
    assert.equal(injected, true);
    assert.equal(await remoteFile(value.remote, "competitor.txt"), "wins race\n");
    assert.equal(JSON.parse(await remoteFile(value.remote, `releases/${SOURCE_COMMIT}/manifest.json`)).releaseId, RELEASE_ID);
    assert.equal(value.runner.calls.filter(({ args }) => args[0] === "push").length, 2);
    assert.match(result.pagesCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(await worktreePaths(value.repository), [value.repository]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("exhausts only non-fast-forward retries and cleans every temporary worktree", async () => {
  const value = await fixture();
  try {
    await seedPages(value.remote, value.root);
    let sequence = 0;
    value.runner.before = async (args) => {
      if (args[0] !== "push") return;
      sequence += 1;
      const competitor = join(value.root, `competitor-${sequence}`);
      await command("git", ["clone", "--branch", "gh-pages", value.remote, competitor]);
      await command("git", ["config", "user.name", "Competitor"], competitor);
      await command("git", ["config", "user.email", "competitor@example.test"], competitor);
      await writeFile(join(competitor, `race-${sequence}.txt`), `${sequence}\n`);
      await command("git", ["add", "."], competitor);
      await command("git", ["commit", "-m", `race ${sequence}`], competitor);
      await command("git", ["push", "origin", "HEAD:gh-pages"], competitor);
    };
    await assert.rejects(publishGitHubPages({ ...publicationInput(value), maxPushAttempts: 3 }), {
      message: "MIAOBI_PAGES_PUSH_CONFLICT",
    });
    assert.equal(sequence, 3);
    assert.deepEqual(value.admin.calls, []);
    assert.deepEqual(await worktreePaths(value.repository), [value.repository]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("worktree-add, materialization, commit, and push failures clean up without touching existing Pages", async () => {
  const cases = ["worktree", "materialize", "commit", "push"] as const;
  for (const failureCase of cases) {
    const value = await fixture();
    try {
      await seedPages(value.remote, value.root);
      if (failureCase === "materialize") await writeFile(join(value.client, "credentials.json"), "{}\n");
      if (failureCase === "worktree") {
        const original = value.runner.run.bind(value.runner);
        value.runner.run = async (args, options) => {
          const result = await original(args, options);
          if (args[0] === "worktree" && args[1] === "add") throw new Error("worktree failed after side effect");
          return result;
        };
      } else value.runner.fail = (args) => {
        if (failureCase === "commit" && args[0] === "commit") return new Error("commit failed");
        if (failureCase === "push" && args[0] === "push") return new Error("authentication failed");
        return undefined;
      };
      await assert.rejects(publish(value));
      assert.equal(await remoteFile(value.remote, "existing.txt"), "preserved\n");
      assert.equal(await exists(join(value.remote, "refs", "heads", "origin")), false);
      assert.deepEqual(value.admin.calls, []);
      assert.deepEqual(await worktreePaths(value.repository), [value.repository], failureCase);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("the production git runner treats metacharacters as literal arguments and redacts command output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "miaobi-git-runner-")));
  const marker = join(root, "injected");
  try {
    const runner = createGitCommandRunner();
    await assert.rejects(runner.run(["rev-parse", `HEAD;touch ${marker}`], { cwd: root }), (error: unknown) => {
      assert.equal((error as Error).message.includes(marker), false);
      assert.equal((error as Error).message.includes("HEAD;touch"), false);
      return true;
    });
    assert.equal(await exists(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pages admin GETs configuration and POSTs or PUTs only when required using argument arrays", async () => {
  const scenarios = [
    { get: new Error("MIAOBI_GITHUB_PAGES_NOT_FOUND"), mutation: "POST" },
    { get: { stdout: JSON.stringify({ build_type: "legacy", source: { branch: "main", path: "/docs" } }), stderr: "" }, mutation: "PUT" },
    { get: { stdout: JSON.stringify({ build_type: "legacy", source: { branch: "gh-pages", path: "/" } }), stderr: "" }, mutation: undefined },
  ];
  for (const scenario of scenarios) {
    const calls: string[][] = [];
    const runner: GitCommandRunner = {
      async run(args) {
        calls.push([...args]);
        assert.ok(Array.isArray(args));
        if (args.includes("GET") && scenario.get instanceof Error) throw scenario.get;
        if (args.includes("GET")) return scenario.get as { stdout: string; stderr: string };
        return { stdout: "{}", stderr: "" };
      },
    };
    const admin = createGitHubPagesAdmin(runner);
    await admin.ensureBranchSource({ owner: "aurostars", repo: "magic-resume", branch: "gh-pages", path: "/" });
    assert.equal(calls[0].includes("GET"), true);
    const mutations = calls.slice(1).flat();
    if (scenario.mutation) assert.equal(mutations.includes(scenario.mutation), true);
    else assert.equal(calls.length, 1);
    assert.equal(mutations.includes("--force"), false);
  }
});

test("Pages admin rejects malformed GET JSON without mutating configuration or exposing the body", async () => {
  const secretBody = "{token:KNOWN_TEST_SECRET";
  const calls: string[][] = [];
  const runner: GitCommandRunner = {
    async run(args) {
      calls.push([...args]);
      return { stdout: secretBody, stderr: "" };
    },
  };
  const admin = createGitHubPagesAdmin(runner);
  await assert.rejects(
    admin.ensureBranchSource({ owner: "aurostars", repo: "magic-resume", branch: "gh-pages", path: "/" }),
    (error: unknown) => {
      assert.equal((error as Error).message, "MIAOBI_INVALID_PAGES_RESPONSE");
      assert.equal((error as Error).message.includes(secretBody), false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("the production git runner classifies an absent fetched branch without exposing remote diagnostics", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "miaobi-git-missing-ref-")));
  const remote = join(root, "fork.git");
  const repository = join(root, "repository");
  try {
    await command("git", ["init", "--bare", remote]);
    await command("git", ["init", repository]);
    await command("git", ["remote", "add", "fork", remote], repository);
    const runner = createGitCommandRunner();
    await assert.rejects(
      runner.run(["fetch", "--no-tags", "fork", "refs/heads/gh-pages:refs/remotes/fork/gh-pages"], { cwd: repository }),
      (error: unknown) => {
        assert.equal((error as { kind?: string }).kind, "not-found");
        assert.equal((error as Error).message, "GIT_COMMAND_FAILED");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked temporary parent before creating directories outside the repository", async () => {
  const value = await fixture();
  const outside = join(value.root, "outside");
  try {
    await mkdir(outside);
    await symlink(outside, join(value.repository, ".miaobi"));
    await assert.rejects(publish(value), { message: "MIAOBI_INVALID_WORKTREE_PARENT" });
    assert.equal(await exists(join(outside, "pages-worktrees")), false);
    assert.deepEqual(value.admin.calls, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});


test("rejects multiple configured fork push destinations before fetch or worktree writes", async () => {
  const value = await fixture();
  try {
    await command("git", ["remote", "set-url", "fork", EXPECTED_FORK], value.repository);
    await command("git", ["remote", "set-url", "--add", "--push", "fork", EXPECTED_FORK], value.repository);
    await command("git", ["remote", "set-url", "--add", "--push", "fork", join(value.root, "attacker.git")], value.repository);
    const base = createGitCommandRunner();
    const calls: string[][] = [];
    const validationRunner: GitCommandRunner = {
      async run(args, options) {
        calls.push([...args]);
        if (args[0] !== "remote") throw new Error("MIAOBI_UNEXPECTED_WRITE_AFTER_FORK_VALIDATION");
        return base.run(args, options);
      },
    };
    await assert.rejects(publishGitHubPages({
      ...publicationInput(value),
      runner: validationRunner,
    }), { message: "MIAOBI_INVALID_FORK" });
    assert.deepEqual(calls, [["remote", "get-url", "--push", "--all", "fork"]]);
    assert.equal(await exists(join(value.remote, "refs", "heads", "gh-pages")), false);
    assert.deepEqual(await worktreePaths(value.repository), [value.repository]);
    await assert.rejects(command("git", ["show-ref", "--verify", "refs/remotes/fork/gh-pages"], value.repository));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a failed first orphan push leaves no local branch and the next publication succeeds", async () => {
  const value = await fixture();
  try {
    let failed = false;
    value.runner.fail = (args) => {
      if (args[0] === "push" && !failed) {
        failed = true;
        return Object.assign(new Error("GIT_COMMAND_FAILED"), { kind: "other" });
      }
      return undefined;
    };
    await assert.rejects(publish(value), { message: "GIT_COMMAND_FAILED" });
    await assert.rejects(command("git", ["show-ref", "--verify", "refs/heads/gh-pages"], value.repository));
    assert.equal((await command("git", ["for-each-ref", "--format=%(refname)", "refs/heads/miaobi-pages-"], value.repository)).stdout, "");
    value.runner.fail = undefined;
    const result = await publish(value);
    assert.match(result.pagesCommit, /^[0-9a-f]{40}$/);
    assert.equal(JSON.parse(await remoteFile(value.remote, `releases/${SOURCE_COMMIT}/manifest.json`)).releaseId, RELEASE_ID);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a real rejected push is classified as other and protected-branch text is never retried", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "miaobi-rejected-push-")));
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  try {
    await command("git", ["init", "--bare", remote]);
    await command("git", ["init", repository]);
    await command("git", ["config", "user.name", "Hook Test"], repository);
    await command("git", ["config", "user.email", "hook@example.test"], repository);
    await writeFile(join(repository, "file.txt"), "content\n");
    await command("git", ["add", "file.txt"], repository);
    await command("git", ["commit", "-m", "content"], repository);
    await command("git", ["config", "core.hooksPath", "hooks"], remote);
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nprintf '%s\\n' 'protected branch KNOWN_TEST_SECRET' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const runner = createGitCommandRunner();
    await assert.rejects(runner.run(["push", remote, "HEAD:gh-pages"], { cwd: repository }), (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, "other");
      assert.equal((error as Error).message, "GIT_COMMAND_FAILED");
      assert.equal((error as Error).message.includes("KNOWN_TEST_SECRET"), false);
      return true;
    });

    const value = await fixture();
    try {
      let pushes = 0;
      value.runner.fail = (args) => {
        if (args[0] !== "push") return undefined;
        pushes += 1;
        return Object.assign(new Error("GIT_COMMAND_FAILED"), {
          stderr: "remote: protected branch\nerror: failed to push some refs\n",
          kind: "other",
        });
      };
      await assert.rejects(publish(value), { message: "GIT_COMMAND_FAILED" });
      assert.equal(pushes, 1);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pages admin converts workflow and source-less configurations to explicit legacy branch source", async () => {
  for (const body of [
    { build_type: "workflow", source: { branch: "gh-pages", path: "/" } },
    { build_type: "workflow" },
  ]) {
    const calls: string[][] = [];
    const runner: GitCommandRunner = {
      async run(args) {
        calls.push([...args]);
        return args.includes("GET")
          ? { stdout: JSON.stringify(body), stderr: "" }
          : { stdout: "{}", stderr: "" };
      },
    };
    await createGitHubPagesAdmin(runner).ensureBranchSource({
      owner: "aurostars", repo: "magic-resume", branch: "gh-pages", path: "/",
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].includes("PUT"), true);
    assert.equal(calls[1].includes("build_type=legacy"), true);
    assert.equal(calls[1].includes("source[branch]=gh-pages"), true);
    assert.equal(calls[1].includes("source[path]=/"), true);
  }
});

test("Pages admin rejects legacy responses without a complete source", async () => {
  const calls: string[][] = [];
  const runner: GitCommandRunner = {
    async run(args) {
      calls.push([...args]);
      return { stdout: JSON.stringify({ build_type: "legacy" }), stderr: "" };
    },
  };
  await assert.rejects(
    createGitHubPagesAdmin(runner).ensureBranchSource({
      owner: "aurostars", repo: "magic-resume", branch: "gh-pages", path: "/",
    }),
    { message: "MIAOBI_INVALID_PAGES_RESPONSE" },
  );
  assert.equal(calls.length, 1);
});

test("cleanup attempts remove, filesystem removal, and prune then reports a sanitized failure", async () => {
  const value = await fixture();
  const parent = join(value.repository, ".miaobi", "pages-worktrees");
  try {
    const original = value.runner.run.bind(value.runner);
    value.runner.run = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        value.runner.calls.push({ args: [...args], cwd: options?.cwd });
        await chmod(parent, 0o500);
        throw new Error("remove KNOWN_TEST_SECRET");
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        value.runner.calls.push({ args: [...args], cwd: options?.cwd });
        throw new Error("prune KNOWN_TEST_SECRET");
      }
      return original(args, options);
    };
    await assert.rejects(publish(value), (error: unknown) => {
      assert.equal((error as Error).message, "MIAOBI_WORKTREE_CLEANUP_FAILED");
      assert.equal((error as Error).message.includes("KNOWN_TEST_SECRET"), false);
      return true;
    });
    assert.equal(value.runner.calls.some(({ args }) => args[0] === "worktree" && args[1] === "remove"), true);
    assert.equal(value.runner.calls.some(({ args }) => args[0] === "worktree" && args[1] === "prune"), true);
    assert.ok((await readdir(parent)).some((name) => name.startsWith("publish-")), "filesystem rm must have been attempted and failed");
  } finally {
    await chmod(parent, 0o700).catch(() => undefined);
    await command("git", ["worktree", "prune"], value.repository).catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an original publication error is preserved and safely marked when cleanup is incomplete", async () => {
  const value = await fixture();
  const originalFailure = new Error("MIAOBI_COMMIT_FAILED");
  try {
    value.runner.fail = (args) => {
      if (args[0] === "commit") return originalFailure;
      if (args[0] === "worktree" && ["remove", "prune"].includes(args[1])) {
        return new Error("cleanup KNOWN_TEST_SECRET");
      }
      return undefined;
    };
    await assert.rejects(publish(value), (error: unknown) => {
      assert.equal(error, originalFailure);
      assert.equal((error as { cleanupIncomplete?: boolean }).cleanupIncomplete, true);
      assert.equal((error as Error).message.includes("KNOWN_TEST_SECRET"), false);
      return true;
    });
    assert.equal(value.runner.calls.some(({ args }) => args[0] === "worktree" && args[1] === "prune"), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("SIGTERM to a real publisher process waits for worktree cleanup before exit", async () => {
  const value = await fixture();
  const ready = join(value.root, "ready");
  const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "miaobi", "publish-github-pages.ts")).href;
  const runnerUrl = pathToFileURL(join(process.cwd(), "scripts", "miaobi", "git-runner.ts")).href;
  const childScript = `
    import { writeFile } from "node:fs/promises";
    import { runGitHubPagesPublisherWithSignals } from ${JSON.stringify(moduleUrl)};
    import { createGitCommandRunner } from ${JSON.stringify(runnerUrl)};
    const [repositoryDirectory, clientDirectory, ready] = process.argv.slice(1);
    const base = createGitCommandRunner();
    const runner = {
      async run(args, options) {
        if (args[0] === "remote" && args[1] === "get-url") {
          return { stdout: "https://github.com/aurostars/magic-resume.git\\n", stderr: "" };
        }
        if (args[0] === "commit") {
          const result = await base.run(args, options);
          const keepAlive = setInterval(() => undefined, 1_000);
          const interrupted = new Promise((_, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("blocked command interrupted")), { once: true }));
          await writeFile(ready, "ready");
          try {
            await interrupted;
          } finally {
            clearInterval(keepAlive);
          }
          return result;
        }
        return base.run(args, options);
      }
    };
    try {
      await runGitHubPagesPublisherWithSignals({
        repositoryDirectory,
        clientDirectory,
        sourceCommit: ${JSON.stringify(SOURCE_COMMIT)},
        releaseId: ${JSON.stringify(RELEASE_ID)},
        runner,
        admin: { async ensureBranchSource() {} },
      });
      process.exitCode = 2;
    } catch (error) {
      process.exitCode = error?.message === "MIAOBI_PUBLISH_INTERRUPTED" ? 143 : 3;
    }
  `;
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", childScript,
    value.repository, value.client, ready,
  ], { cwd: process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [];
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  try {
    const deadline = Date.now() + 30_000;
    while (!await exists(ready)) {
      if (Date.now() > deadline) throw new Error(`publisher did not become ready: ${Buffer.concat(output).toString("utf8")}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    child.kill("SIGTERM");
    const outcome = await exit;
    assert.deepEqual(outcome, { code: 143, signal: null }, Buffer.concat(output).toString("utf8"));
    assert.deepEqual(await worktreePaths(value.repository), [value.repository]);
    await assert.rejects(command("git", ["show-ref", "--verify", "refs/heads/gh-pages"], value.repository));
  } finally {
    child.kill("SIGKILL");
    await rm(value.root, { recursive: true, force: true });
  }
});


test("does not retry a non-fast-forward when that attempt's cleanup is incomplete", async () => {
  const value = await fixture();
  const conflict = Object.assign(new Error("GIT_COMMAND_FAILED"), { kind: "non-fast-forward" });
  let pushes = 0;
  try {
    await seedPages(value.remote, value.root);
    value.runner.fail = (args) => {
      if (args[0] === "push") {
        pushes += 1;
        return conflict;
      }
      if (args[0] === "worktree" && ["remove", "prune"].includes(args[1])) {
        return new Error("cleanup failed");
      }
      return undefined;
    };
    await assert.rejects(publish(value), (error: unknown) => {
      assert.equal(error, conflict);
      assert.equal((error as { cleanupIncomplete?: boolean }).cleanupIncomplete, true);
      return true;
    });
    assert.equal(pushes, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

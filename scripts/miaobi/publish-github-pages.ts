import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { materializeGitHubPagesRelease } from "./github-pages-assets";
import { createGitHubCliRunner, type GitCommandRunner } from "./git-runner";
import type { GitHubPagesManifest } from "./types";

const OWNER = "aurostars" as const;
const REPOSITORY = "magic-resume" as const;
const BRANCH = "gh-pages" as const;
const PAGES_ORIGIN = "https://aurostars.github.io" as const;
const PAGES_BASE_PATH = "/magic-resume/" as const;
const DEFAULT_PUSH_ATTEMPTS = 3;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_ID_PATTERN = /^[0-9a-f]{12}-\d{14}$/;

export interface GitHubPagesAdmin {
  ensureBranchSource(input: {
    owner: "aurostars";
    repo: "magic-resume";
    branch: "gh-pages";
    path: "/";
  }): Promise<void>;
}

export interface GitHubPagesPublication {
  manifest: GitHubPagesManifest;
  pagesCommit: string;
  pagesBaseUrl: string;
  releaseManifestUrl: string;
}

type CommandError = Error & {
  stderr?: string;
  kind?: "not-found" | "non-fast-forward" | "other";
};

function invalidFork(): never {
  throw new Error("MIAOBI_INVALID_FORK");
}

function parseGitHubRepository(remoteUrl: string): { owner: string; repo: string } | undefined {
  const value = remoteUrl.trim();
  const scpMatch = /^(?:git)@github\.com:([^/]+)\/([^/]+?)\/?$/.exec(value);
  if (scpMatch) {
    return { owner: scpMatch[1], repo: scpMatch[2].replace(/\.git$/, "") };
  }
  try {
    const parsed = new URL(value);
    if (
      !["https:", "ssh:"].includes(parsed.protocol) ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.password ||
      (parsed.protocol === "https:" && parsed.username) ||
      (parsed.protocol === "ssh:" && parsed.username !== "git") ||
      parsed.port || parsed.search || parsed.hash
    ) return undefined;
    const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (segments.length !== 2) return undefined;
    return { owner: segments[0], repo: segments[1].replace(/\.git$/, "") };
  } catch {
    return undefined;
  }
}

async function validateFork(repositoryDirectory: string, runner: GitCommandRunner): Promise<void> {
  let output: { stdout: string };
  try {
    output = await runner.run(["remote", "get-url", "--push", "fork"], { cwd: repositoryDirectory });
  } catch {
    invalidFork();
  }
  const repository = parseGitHubRepository(output.stdout);
  if (repository?.owner !== OWNER || repository.repo !== REPOSITORY) invalidFork();
}

function errorText(error: unknown): string {
  const candidate = error as CommandError;
  return typeof candidate?.stderr === "string" ? candidate.stderr : "";
}

function isMissingRemoteBranch(error: unknown): boolean {
  return (error as CommandError)?.kind === "not-found" ||
    /couldn't find remote ref|remote branch .* not found|no such ref/i.test(errorText(error));
}

function isPushConflict(error: unknown): boolean {
  return (error as CommandError)?.kind === "non-fast-forward" ||
    /non-fast-forward|fetch first|failed to push some refs|stale info/i.test(errorText(error));
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("MIAOBI_INVALID_WORKTREE_PARENT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function prepareTemporaryParent(repositoryDirectory: string): Promise<string> {
  const repositoryRoot = await realpath(repositoryDirectory);
  const container = resolve(repositoryRoot, ".miaobi");
  const parent = resolve(container, "pages-worktrees");
  if (!parent.startsWith(`${repositoryRoot}${sep}`)) throw new Error("MIAOBI_INVALID_WORKTREE_PARENT");
  await rejectSymlinkIfPresent(container);
  await rejectSymlinkIfPresent(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const [resolvedParent, metadata] = await Promise.all([realpath(parent), lstat(parent)]);
  if (
    resolvedParent !== parent || !metadata.isDirectory() || metadata.isSymbolicLink() ||
    !resolvedParent.startsWith(`${repositoryRoot}${sep}`)
  ) throw new Error("MIAOBI_INVALID_WORKTREE_PARENT");
  return parent;
}

async function fetchPages(repositoryDirectory: string, runner: GitCommandRunner): Promise<boolean> {
  try {
    await runner.run([
      "fetch",
      "--no-tags",
      "fork",
      "refs/heads/gh-pages:refs/remotes/fork/gh-pages",
    ], { cwd: repositoryDirectory });
    return true;
  } catch (error) {
    if (isMissingRemoteBranch(error)) return false;
    throw error;
  }
}

async function removeWorktree(
  repositoryDirectory: string,
  worktreeDirectory: string,
  runner: GitCommandRunner,
): Promise<void> {
  await runner.run(["worktree", "remove", worktreeDirectory], {
    cwd: repositoryDirectory,
  }).catch(() => undefined);
  await rm(worktreeDirectory, { recursive: true, force: true }).catch(() => undefined);
  await runner.run(["worktree", "prune"], { cwd: repositoryDirectory }).catch(() => undefined);
}

async function createPublicationAttempt(input: {
  repositoryDirectory: string;
  clientDirectory: string;
  sourceCommit: string;
  releaseId: string;
  runner: GitCommandRunner;
}): Promise<{ manifest: GitHubPagesManifest; pagesCommit: string }> {
  const branchExists = await fetchPages(input.repositoryDirectory, input.runner);
  const parent = await prepareTemporaryParent(input.repositoryDirectory);
  const worktreeDirectory = await mkdtemp(join(parent, "publish-"));
  try {
    if (branchExists) {
      await input.runner.run(["worktree", "add", "--detach", worktreeDirectory, "fork/gh-pages"], {
        cwd: input.repositoryDirectory,
      });
    } else {
      await input.runner.run(["worktree", "add", "--detach", worktreeDirectory, "HEAD"], {
        cwd: input.repositoryDirectory,
      });
    }
    if (!branchExists) {
      await input.runner.run(["switch", "--orphan", "gh-pages"], { cwd: worktreeDirectory });
    }
    await writeFile(join(worktreeDirectory, ".nojekyll"), "", { flag: "a", mode: 0o644 });

    const materialized = await materializeGitHubPagesRelease({
      clientDirectory: input.clientDirectory,
      pagesDirectory: worktreeDirectory,
      sourceCommit: input.sourceCommit,
      releaseId: input.releaseId,
      pagesOrigin: PAGES_ORIGIN,
      pagesBasePath: PAGES_BASE_PATH,
    });
    await input.runner.run(["add", "--", ".nojekyll", "objects", "releases"], {
      cwd: worktreeDirectory,
    });
    const status = await input.runner.run([
      "status", "--porcelain", "--untracked-files=normal", "--", ".nojekyll", "objects", "releases",
    ], { cwd: worktreeDirectory });
    if (status.stdout.trim()) {
      await input.runner.run(["commit", "-m", `deploy pages: ${input.releaseId}`], {
        cwd: worktreeDirectory,
      });
    }
    const pagesCommit = (await input.runner.run(["rev-parse", "HEAD"], {
      cwd: worktreeDirectory,
    })).stdout.trim();
    await input.runner.run(["push", "fork", "HEAD:gh-pages"], { cwd: worktreeDirectory });
    return { manifest: materialized.manifest, pagesCommit };
  } finally {
    await removeWorktree(input.repositoryDirectory, worktreeDirectory, input.runner);
  }
}

function pagesResponse(stdout: string): { source: { branch: string; path: string } } {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as { source?: unknown }).source !== "object" ||
      (parsed as { source?: unknown }).source === null
    ) throw new Error("invalid");
    const source = (parsed as { source: { branch?: unknown; path?: unknown } }).source;
    if (typeof source.branch !== "string" || typeof source.path !== "string") throw new Error("invalid");
    return { source: { branch: source.branch, path: source.path } };
  } catch {
    throw new Error("MIAOBI_INVALID_PAGES_RESPONSE");
  }
}

export function createGitHubPagesAdmin(runner: GitCommandRunner = createGitHubCliRunner()): GitHubPagesAdmin {
  return {
    async ensureBranchSource(input) {
      const endpoint = `repos/${input.owner}/${input.repo}/pages`;
      let current: { source: { branch: string; path: string } } | undefined;
      try {
        const response = await runner.run(["api", "-X", "GET", endpoint]);
        current = pagesResponse(response.stdout);
      } catch (error) {
        const notFound = (error as CommandError)?.kind === "not-found" ||
          (error as Error)?.message === "MIAOBI_GITHUB_PAGES_NOT_FOUND";
        if (!notFound) throw error;
      }
      if (current?.source.branch === input.branch && current.source.path === input.path) return;
      await runner.run([
        "api",
        "-X", current ? "PUT" : "POST",
        endpoint,
        "-f", `source[branch]=${input.branch}`,
        "-f", `source[path]=${input.path}`,
      ]);
    },
  };
}

export async function publishGitHubPages(input: {
  repositoryDirectory: string;
  clientDirectory: string;
  sourceCommit: string;
  releaseId: string;
  runner: GitCommandRunner;
  admin?: GitHubPagesAdmin;
  maxPushAttempts?: number;
}): Promise<GitHubPagesPublication> {
  if (
    !SOURCE_COMMIT_PATTERN.test(input.sourceCommit) ||
    !RELEASE_ID_PATTERN.test(input.releaseId)
  ) throw new Error("MIAOBI_INVALID_PUBLICATION_INPUT");
  const maxPushAttempts = input.maxPushAttempts ?? DEFAULT_PUSH_ATTEMPTS;
  if (!Number.isSafeInteger(maxPushAttempts) || maxPushAttempts < 1 || maxPushAttempts > 10) {
    throw new Error("MIAOBI_INVALID_PUBLICATION_INPUT");
  }
  const repositoryDirectory = await realpath(input.repositoryDirectory);
  await validateFork(repositoryDirectory, input.runner);

  let published: { manifest: GitHubPagesManifest; pagesCommit: string } | undefined;
  for (let attempt = 1; attempt <= maxPushAttempts; attempt += 1) {
    try {
      published = await createPublicationAttempt({ ...input, repositoryDirectory });
      break;
    } catch (error) {
      if (!isPushConflict(error)) throw error;
      if (attempt === maxPushAttempts) throw new Error("MIAOBI_PAGES_PUSH_CONFLICT");
    }
  }
  if (!published) throw new Error("MIAOBI_PAGES_PUSH_CONFLICT");

  await (input.admin ?? createGitHubPagesAdmin()).ensureBranchSource({
    owner: OWNER,
    repo: REPOSITORY,
    branch: BRANCH,
    path: "/",
  });
  const pagesBaseUrl = `${PAGES_ORIGIN}${PAGES_BASE_PATH}`;
  return {
    ...published,
    pagesBaseUrl,
    releaseManifestUrl: `${pagesBaseUrl}releases/${input.sourceCommit}/manifest.json`,
  };
}

export { type GitCommandRunner } from "./git-runner";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { materializeGitHubPagesRelease } from "../scripts/miaobi/github-pages-assets";

const SOURCE_COMMIT = "d26c16fcfcec3cb7b73d3d6002aebdf212422f21";
const RELEASE_ID = "d26c16fcfcec-20260914142200";
const PLACEHOLDER = "https://miaobi.invalid/__ASSET_BASE__/";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(): Promise<{ root: string; clientDirectory: string; pagesDirectory: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "miaobi-pages-")));
  const clientDirectory = join(root, "client");
  const pagesDirectory = join(root, "pages");
  await mkdir(clientDirectory);
  return { root, clientDirectory, pagesDirectory };
}

function input(clientDirectory: string, pagesDirectory: string) {
  return {
    clientDirectory,
    pagesDirectory,
    sourceCommit: SOURCE_COMMIT,
    releaseId: RELEASE_ID,
    pagesOrigin: "https://aurostars.github.io" as const,
    pagesBasePath: "/magic-resume/" as const,
  };
}

test("materializes the complete allowed tree while filtering private, map, server, test and unsupported files", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  await mkdir(join(clientDirectory, "assets"));
  await mkdir(join(clientDirectory, "fonts"));
  await mkdir(join(clientDirectory, "template-snapshots"));
  await mkdir(join(clientDirectory, "server"));
  await mkdir(join(clientDirectory, "tests"));
  await writeFile(join(clientDirectory, "assets", "app.js"), `import "${PLACEHOLDER}assets/style.css";`);
  await writeFile(join(clientDirectory, "assets", "style.css"), "body { color: black }\n");
  await writeFile(join(clientDirectory, "fonts", "default.woff2"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(clientDirectory, "template-snapshots", "default.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(clientDirectory, ".env"), "KNOWN_TEST_SECRET=leak");
  await writeFile(join(clientDirectory, "assets", "app.js.map"), "sources");
  await writeFile(join(clientDirectory, "server", "entry.js"), "server");
  await writeFile(join(clientDirectory, "tests", "fixture.svg"), "<svg/>");
  await writeFile(join(clientDirectory, "entry.server.js"), "server");
  await writeFile(join(clientDirectory, "unit.test.js"), "test");
  await writeFile(join(clientDirectory, "notes.md"), "unsupported");

  try {
    const result = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.deepEqual(Object.keys(result.manifest.files).sort(), [
      "assets/app.js",
      "assets/style.css",
      "fonts/default.woff2",
      "template-snapshots/default.png",
    ]);
    assert.equal(result.releaseDirectory, join(pagesDirectory, "releases", SOURCE_COMMIT));
    assert.equal(result.manifest.provider, "github-pages");
    assert.equal(result.manifest.sourceCommit, SOURCE_COMMIT);
    assert.equal(result.manifest.baseUrl, "https://aurostars.github.io/magic-resume/");
    assert.equal(await exists(join(pagesDirectory, ".env")), false);
    assert.equal(await exists(join(result.releaseDirectory, "manifest.json")), true);
    assert.equal(await exists(join(pagesDirectory, "releases", "index.json")), true);
    const persistedManifest = JSON.parse(
      await readFile(join(result.releaseDirectory, "manifest.json"), "utf8"),
    );
    assert.deepEqual(persistedManifest, result.manifest);
    assert.equal((await stat(join(result.releaseDirectory, "manifest.json"))).isFile(), true);
    const persistedIndex = JSON.parse(
      await readFile(join(pagesDirectory, "releases", "index.json"), "utf8"),
    );
    assert.deepEqual(persistedIndex, {
      schemaVersion: 1,
      releases: {
        [SOURCE_COMMIT]: {
          releaseId: RELEASE_ID,
          manifest: `releases/${SOURCE_COMMIT}/manifest.json`,
        },
      },
    });

    const app = result.manifest.files["assets/app.js"];
    assert.match(app.objectPath, /^objects\/[0-9a-f]{64}\/assets\/app\.js$/);
    assert.equal(app.key, app.objectPath);
    assert.equal(app.url, `https://aurostars.github.io/magic-resume/${app.objectPath}`);
    const appBytes = await readFile(join(pagesDirectory, app.objectPath));
    assert.equal((await stat(join(pagesDirectory, app.objectPath))).mode & 0o222, 0);
    const graphHash = app.objectPath.split("/")[1];
    assert.equal(
      appBytes.toString("utf8"),
      `import "https://aurostars.github.io/magic-resume/objects/${graphHash}/assets/style.css";`,
    );
    assert.equal(app.contentHash, createHash("sha256").update(appBytes).digest("hex"));
    assert.equal(app.size, appBytes.length);
    assert.deepEqual(
      await readFile(join(pagesDirectory, result.manifest.files["fonts/default.woff2"].objectPath)),
      Buffer.from([0, 1, 2, 255]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks without publishing objects or release metadata", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  const outside = join(root, "outside.js");
  await writeFile(outside, "secret");
  await symlink(outside, join(clientDirectory, "escape.js"));
  try {
    await assert.rejects(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)), {
      code: "MIAOBI_INVALID_PATH",
    });
    assert.equal(await exists(pagesDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlink escapes even when their names would otherwise be filtered", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  const outside = join(root, "outside.js");
  await writeFile(outside, "secret");
  await symlink(outside, join(clientDirectory, ".hidden.js"));
  try {
    await assert.rejects(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)), {
      code: "MIAOBI_INVALID_PATH",
    });
    assert.equal(await exists(pagesDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicates equal bytes and a rerun creates no object duplicates", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  await writeFile(join(clientDirectory, "a.js"), "same bytes");
  await writeFile(join(clientDirectory, "z.js"), "same bytes");
  try {
    const first = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.notEqual(first.manifest.files["a.js"].objectPath, first.manifest.files["z.js"].objectPath);
    assert.equal(
      (await stat(join(pagesDirectory, first.manifest.files["a.js"].objectPath))).ino,
      (await stat(join(pagesDirectory, first.manifest.files["z.js"].objectPath))).ino,
    );
    assert.equal(first.createdObjectPaths.length, 2);
    const second = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.deepEqual(second.createdObjectPaths, []);
    assert.deepEqual(second.manifest.files, first.manifest.files);
    const graphDirectory = dirname(join(pagesDirectory, first.manifest.files["a.js"].objectPath));
    assert.deepEqual((await readdir(graphDirectory)).sort(), ["a.js", "z.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on conflicting object bytes before exposing release metadata", async () => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(join(first.clientDirectory, "app.js"), "expected");
  await writeFile(join(second.clientDirectory, "app.js"), "expected");
  try {
    const seeded = await materializeGitHubPagesRelease(input(first.clientDirectory, first.pagesDirectory));
    const objectPath = seeded.manifest.files["app.js"].objectPath;
    await mkdir(dirname(join(second.pagesDirectory, objectPath)), { recursive: true });
    await writeFile(join(second.pagesDirectory, objectPath), "conflict");

    await assert.rejects(
      materializeGitHubPagesRelease(input(second.clientDirectory, second.pagesDirectory)),
      { code: "MIAOBI_OBJECT_CONFLICT" },
    );
    assert.equal(await exists(join(second.pagesDirectory, "releases", SOURCE_COMMIT, "manifest.json")), false);
    assert.equal(await exists(join(second.pagesDirectory, "releases", "index.json")), false);
    assert.equal(await readFile(join(second.pagesDirectory, objectPath), "utf8"), "conflict");
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("computes the same graph and objects independent of file creation order", async () => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(join(first.clientDirectory, "z.js"), "z");
  await writeFile(join(first.clientDirectory, "a.css"), "a");
  await writeFile(join(second.clientDirectory, "a.css"), "a");
  await writeFile(join(second.clientDirectory, "z.js"), "z");
  try {
    const left = await materializeGitHubPagesRelease(input(first.clientDirectory, first.pagesDirectory));
    const right = await materializeGitHubPagesRelease(input(second.clientDirectory, second.pagesDirectory));
    assert.deepEqual(left.manifest, right.manifest);
    assert.equal(left.manifest.createdAt, "2026-09-14T14:22:00.000Z");
    assert.deepEqual(
      Object.fromEntries(Object.entries(left.manifest.files).map(([path, record]) => [path, record.objectPath])),
      Object.fromEntries(Object.entries(right.manifest.files).map(([path, record]) => [path, record.objectPath])),
    );
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("rejects unsafe final text and leaves no release metadata", async () => {
  const unsafeValues = [
    "https://legacy.workers.dev/asset.js",
    "https://bucket.tos-cn.example.com/asset.js",
    "/Users/private/project/file.js",
    "/workspace/project/file.js",
    "file:///tmp/asset.js",
    "//# sourceMappingURL=app.js.map",
    "KNOWN_TEST_SECRET",
  ];
  for (const value of unsafeValues) {
    const { root, clientDirectory, pagesDirectory } = await fixture();
    await writeFile(join(clientDirectory, "app.js"), value);
    try {
      await assert.rejects(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)), {
        code: "MIAOBI_UNSAFE_ASSET",
      });
      assert.equal(await exists(join(pagesDirectory, "releases", SOURCE_COMMIT)), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects non-canonical commits and unsafe release IDs before writing", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  await writeFile(join(clientDirectory, "app.js"), "safe");
  try {
    await assert.rejects(
      materializeGitHubPagesRelease({ ...input(clientDirectory, pagesDirectory), sourceCommit: "../escape" }),
      { code: "MIAOBI_INVALID_PATH" },
    );
    await assert.rejects(
      materializeGitHubPagesRelease({ ...input(clientDirectory, pagesDirectory), releaseId: "../escape" }),
      { code: "MIAOBI_INVALID_PATH" },
    );
    assert.equal(await exists(pagesDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("materializes every referenced duplicate path as a MIME-preserving immutable alias", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  await writeFile(join(clientDirectory, "a.js"), "shared");
  await writeFile(join(clientDirectory, "z.css"), "shared");
  await writeFile(join(clientDirectory, "index.html"), `<link href="${PLACEHOLDER}z.css">`);
  try {
    const result = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    const js = result.manifest.files["a.js"];
    const css = result.manifest.files["z.css"];
    assert.match(js.objectPath, /\/a\.js$/);
    assert.match(css.objectPath, /\/z\.css$/);
    assert.equal(js.contentType, "application/javascript; charset=utf-8");
    assert.equal(css.contentType, "text/css; charset=utf-8");
    assert.equal(await exists(join(pagesDirectory, js.objectPath)), true);
    assert.equal(await exists(join(pagesDirectory, css.objectPath)), true);
    assert.equal((await stat(join(pagesDirectory, js.objectPath))).ino,
      (await stat(join(pagesDirectory, css.objectPath))).ino);
    const html = await readFile(
      join(pagesDirectory, result.manifest.files["index.html"].objectPath),
      "utf8",
    );
    assert.equal(html.includes(`/z.css`), true);
    assert.equal(await exists(new URL(html.match(/href="([^"]+)/)?.[1] ?? "").pathname
      .replace("/magic-resume/", `${pagesDirectory}/`)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects credential, resume, session and local-state JSON instead of publishing user data", async () => {
  const forbiddenNames = [
    "credentials.json",
    "webdav-credentials.json",
    "resume.json",
    "local-state.json",
    "session.json",
  ];
  for (const forbiddenName of forbiddenNames) {
    const { root, clientDirectory, pagesDirectory } = await fixture();
    await writeFile(join(clientDirectory, "app.js"), "safe");
    await writeFile(join(clientDirectory, forbiddenName), "{\"secret\":true}");
    try {
      await assert.rejects(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)), {
        code: "MIAOBI_UNSAFE_ASSET",
      });
      assert.equal(await exists(pagesDirectory), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects forbidden asset-service URLs by decoded hostname", async () => {
  const forbiddenUrls = [
    "https://raw.githubusercontent.com/owner/repo/main/app.js",
    "//cdn.jsdelivr.net/npm/package/app.js",
    String.raw`https:\/\/tenant.pages.dev/app.js`,
    String.raw`https:\u002f\u002ftenant.workers.dev/app.js`,
    "https://cdnjs.cloudflare.com/ajax/libs/app.js",
    "https://bucket.tos-cn-beijing.volces.com/app.js",
    "https://tos-s3-cn-beijing.volces.com/bucket/app.js",
  ];
  for (const forbiddenUrl of forbiddenUrls) {
    const { root, clientDirectory, pagesDirectory } = await fixture();
    await writeFile(join(clientDirectory, "app.js"), `const url = "${forbiddenUrl}";`);
    try {
      await assert.rejects(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)), {
        code: "MIAOBI_UNSAFE_ASSET",
      });
      assert.equal(await exists(join(pagesDirectory, "releases")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("minified operators and regex syntax are not mistaken for provider URLs", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  await writeFile(join(clientDirectory, "app.js"), "const ratio=a//b;const protocol=/https?:\\/\\//;const label='tos-example.com';");
  try {
    await assert.doesNotReject(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates the fixed Pages origin and base path at runtime", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  await writeFile(join(clientDirectory, "app.js"), "safe");
  try {
    await assert.rejects(materializeGitHubPagesRelease({
      ...input(clientDirectory, pagesDirectory),
      pagesOrigin: "https://evil.example" as "https://aurostars.github.io",
    }), { code: "MIAOBI_INVALID_PATH" });
    await assert.rejects(materializeGitHubPagesRelease({
      ...input(clientDirectory, pagesDirectory),
      pagesBasePath: "/other/" as "/magic-resume/",
    }), { code: "MIAOBI_INVALID_PATH" });
    assert.equal(await exists(pagesDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hashes the canonical tree in globally sorted relative-path order", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  await mkdir(join(clientDirectory, "a"));
  await writeFile(join(clientDirectory, "a", "z.js"), "nested");
  await writeFile(join(clientDirectory, "a.js"), "root");
  try {
    const result = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.equal(
      result.manifest.files["a.js"].objectPath.split("/")[1],
      "37527448201997df662b54623670842f9a460abeabb24be965c9a8db0d723022",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("rejects a source file modified through the same inode while it is being snapshotted", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  const source = join(clientDirectory, "large.js");
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 97));
  let stopped = false;
  const mutator = (async () => {
    while (!stopped) {
      await appendFile(source, "x");
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  try {
    await assert.rejects(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)), {
      code: "MIAOBI_INVALID_PATH",
    });
    assert.equal(await exists(pagesDirectory), false);
  } finally {
    stopped = true;
    await mutator;
    await rm(root, { recursive: true, force: true });
  }
});

test("allows only one concurrent manifest for the same source commit", async () => {
  const first = await fixture();
  const second = await fixture();
  const pagesDirectory = first.pagesDirectory;
  await writeFile(join(first.clientDirectory, "app.js"), "first");
  await writeFile(join(second.clientDirectory, "app.js"), "second");
  try {
    const outcomes = await Promise.allSettled([
      materializeGitHubPagesRelease(input(first.clientDirectory, pagesDirectory)),
      materializeGitHubPagesRelease({
        ...input(second.clientDirectory, pagesDirectory),
        releaseId: "d26c16fcfcec-20260914142300",
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) =>
      outcome.status === "rejected" && outcome.reason?.code === "MIAOBI_RELEASE_CONFLICT"
    ).length, 1);
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("merges concurrent releases into the index without losing entries", async () => {
  const sharedRoot = await realpath(await mkdtemp(join(tmpdir(), "miaobi-pages-index-")));
  const pagesDirectory = join(sharedRoot, "pages");
  const fixtures: Array<{ clientDirectory: string; sourceCommit: string; releaseId: string }> = [];
  for (let index = 0; index < 8; index += 1) {
    const clientDirectory = join(sharedRoot, `client-${index}`);
    await mkdir(clientDirectory);
    await writeFile(join(clientDirectory, "app.js"), `app-${index}`);
    fixtures.push({
      clientDirectory,
      sourceCommit: index.toString(16).padStart(40, "0"),
      releaseId: `${index.toString(16).padStart(12, "0")}-20260914142${index}00`,
    });
  }
  try {
    await Promise.all(fixtures.map((entry) => materializeGitHubPagesRelease({
      ...input(entry.clientDirectory, pagesDirectory),
      sourceCommit: entry.sourceCommit,
      releaseId: entry.releaseId,
    })));
    const index = JSON.parse(await readFile(join(pagesDirectory, "releases", "index.json"), "utf8"));
    assert.deepEqual(Object.keys(index.releases).sort(), fixtures.map((entry) => entry.sourceCommit).sort());
  } finally {
    await rm(sharedRoot, { recursive: true, force: true });
  }
});



test("installs the complete graph at one directory commit point visible to an independent process", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  const assetCount = 2000;
  for (let index = 0; index < assetCount; index += 1) {
    await writeFile(join(clientDirectory, `${String(index).padStart(4, "0")}.js`), `asset-${index}`);
  }
  const readyPath = join(root, "observer-ready");
  const resultPath = join(root, "observer-result");
  const observerScript = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const [pages, sourceCommit, expected, ready, result] = process.argv.slice(1);
    fs.writeFileSync(ready, "ready");
    const countFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
      .reduce((count, entry) => count + (entry.isDirectory()
        ? countFiles(path.join(directory, entry.name))
        : entry.isFile() ? 1 : 0), 0);
    const deadline = Date.now() + 120000;
    for (;;) {
      const objects = path.join(pages, "objects");
      if (fs.existsSync(objects)) {
        for (const name of fs.readdirSync(objects)) {
          if (/^[0-9a-f]{64}$/.test(name)) {
            const count = countFiles(path.join(objects, name));
            if (count !== Number(expected)) {
              fs.writeFileSync(result, JSON.stringify({ partial: count }));
              process.exit(0);
            }
          }
        }
      }
      if (fs.existsSync(path.join(pages, "releases", sourceCommit, "manifest.json"))) {
        fs.writeFileSync(result, JSON.stringify({ complete: true }));
        process.exit(0);
      }
      if (Date.now() > deadline) process.exit(2);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  `;
  const observer = spawn(process.execPath, [
    "-e", observerScript, pagesDirectory, SOURCE_COMMIT, String(assetCount), readyPath, resultPath,
  ], { stdio: "inherit" });
  const observerExit = new Promise<number | null>((resolveExit, rejectExit) => {
    observer.once("error", rejectExit);
    observer.once("exit", resolveExit);
  });
  try {
    while (!await exists(readyPath)) await new Promise((resolveWait) => setImmediate(resolveWait));
    const result = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.equal(await observerExit, 0);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), { complete: true });
    assert.equal(Object.keys(result.manifest.files).length, assetCount);
  } finally {
    observer.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("takes over a crashed stale lock with a dead owner and completes publication", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  const lockDirectory = join(pagesDirectory, ".github-pages-assets.lock");
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    ownerToken: "00000000000000000000000000000001",
    pid: 2_147_483_647,
    heartbeatAt: "2000-01-01T00:00:00.000Z",
  })}\n`);
  await writeFile(join(clientDirectory, "app.js"), "safe");
  try {
    const result = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.equal(result.manifest.sourceCommit, SOURCE_COMMIT);
    assert.equal(await exists(lockDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not take over a live owner while concurrent publication is active", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(clientDirectory, `${String(index).padStart(3, "0")}.js`), String(index));
  }
  const lockDirectory = join(pagesDirectory, ".github-pages-assets.lock");
  const first = materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
  try {
    while (!await exists(lockDirectory)) await new Promise((resolve) => setImmediate(resolve));
    const before = await stat(lockDirectory);
    const second = materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const during = await stat(lockDirectory);
    assert.equal(during.dev, before.dev);
    assert.equal(during.ino, before.ino);
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status === "fulfilled" || outcomes[1].reason?.code === "MIAOBI_RELEASE_CONFLICT", true);
  } finally {
    await first.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an old owner never removes a successor lock it does not own", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(clientDirectory, `${String(index).padStart(3, "0")}.js`), String(index));
  }
  const lockDirectory = join(pagesDirectory, ".github-pages-assets.lock");
  const displacedDirectory = join(pagesDirectory, ".displaced-lock");
  const publication = materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
  const publicationFinished = publication.catch(() => undefined);
  try {
    for (;;) {
      try {
        const [graphName] = await readdir(join(pagesDirectory, "objects"));
        if (graphName && (await readdir(join(pagesDirectory, "objects", graphName))).length > 0) break;
      } catch {
        // The owner has not entered object publication yet.
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await rename(lockDirectory, displacedDirectory);
    await mkdir(lockDirectory);
    await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
      schemaVersion: 1,
      ownerToken: "ffffffffffffffffffffffffffffffff",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
    })}\n`);
    await publicationFinished;
    assert.equal(await exists(lockDirectory), true);
    const successor = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
    assert.equal(successor.ownerToken, "ffffffffffffffffffffffffffffffff");
  } finally {
    await publicationFinished;
    await rm(root, { recursive: true, force: true });
  }
});


test("treats a far-future heartbeat as corrupt instead of waiting forever", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  const lockDirectory = join(pagesDirectory, ".github-pages-assets.lock");
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    ownerToken: "00000000000000000000000000000002",
    pid: 2_147_483_647,
    heartbeatAt: "2999-01-01T00:00:00.000Z",
  })}\n`);
  await writeFile(join(clientDirectory, "app.js"), "safe");
  try {
    const result = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.equal(result.manifest.sourceCommit, SOURCE_COMMIT);
    assert.equal(await exists(lockDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds active-lock waiting through small clock rollback without taking over its owner", async () => {
  const { root, clientDirectory, pagesDirectory } = await fixture();
  const lockDirectory = join(pagesDirectory, ".github-pages-assets.lock");
  const ownerToken = "00000000000000000000000000000003";
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    ownerToken,
    pid: process.pid,
    heartbeatAt: new Date(Date.now() + 4_000).toISOString(),
  })}\n`);
  await writeFile(join(clientDirectory, "app.js"), "safe");
  const startedAt = Date.now();
  try {
    await assert.rejects(materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory)), {
      code: "MIAOBI_RELEASE_CONFLICT",
    });
    assert.ok(Date.now() - startedAt < 5_000, "lock acquisition must have a deterministic bound");
    assert.equal(JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8")).ownerToken,
      ownerToken);
    assert.equal(await exists(join(pagesDirectory, "releases", SOURCE_COMMIT, "manifest.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

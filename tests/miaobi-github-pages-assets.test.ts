import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    assert.equal(first.manifest.files["a.js"].objectPath, first.manifest.files["z.js"].objectPath);
    assert.equal(first.createdObjectPaths.length, 1);
    const second = await materializeGitHubPagesRelease(input(clientDirectory, pagesDirectory));
    assert.deepEqual(second.createdObjectPaths, []);
    assert.deepEqual(second.manifest.files, first.manifest.files);
    const graphDirectory = dirname(join(pagesDirectory, first.manifest.files["a.js"].objectPath));
    assert.deepEqual(await readdir(graphDirectory), ["a.js"]);
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

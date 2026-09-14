import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createMagicBuilderRunner } from "../scripts/miaobi/magic-builder";
import {
  createReleaseId,
  publishAssets,
} from "../scripts/miaobi/publish-assets";
import type { MagicBuilderRunner } from "../scripts/miaobi/types";

const RELEASE_ID = "caa88a95d5f9-20260913155100";
const PLACEHOLDER = "https://miaobi.invalid/__ASSET_BASE__/";
const RELEASE_BASE = `https://assets.example.test/magic-resume/releases/${RELEASE_ID}/`;

type Upload = {
  args: string[];
  key: string;
  contentType: string;
  content: Buffer;
};

function fakeRunner(options: { failAt?: number } = {}): {
  runner: MagicBuilderRunner;
  uploads: Upload[];
} {
  const uploads: Upload[] = [];
  return {
    uploads,
    runner: {
      async run(args) {
        const keyIndex = args.indexOf("--key");
        const typeIndex = args.indexOf("--content-type");
        assert.deepEqual(args.slice(0, 2), ["file", "upload"]);
        assert.notEqual(keyIndex, -1);
        assert.notEqual(typeIndex, -1);
        const key = args[keyIndex + 1];
        const contentType = args[typeIndex + 1];
        const content = await readFile(args[2]);
        uploads.push({ args, key, contentType, content });
        if (uploads.length === options.failAt) throw new Error("token=do-not-leak");
        return {
          stdout: JSON.stringify({
            id: `upload-${uploads.length}`,
            url: `https://assets.example.test/${key}`,
          }),
          stderr: "uploaded",
        };
      },
    },
  };
}

async function fixture(): Promise<{ root: string; directory: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "miaobi-assets-")));
  const directory = join(root, "dist", "miaobi", "client");
  await mkdir(directory, { recursive: true });
  return { root, directory };
}

test("publishes through the built-in subprocess runner", async () => {
  const { root, directory } = await fixture();
  const command = join(root, "fake-magic-builder");
  const callLog = join(root, "calls.log");
  await writeFile(
    command,
    `#!/bin/sh
key=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--key' ]; then key="$2"; shift 2; else shift; fi
done
printf '%s\\n' "$key" >> '${callLog}'
printf '{"id":"upload","url":"https://assets.example.test/%s"}' "$key"
`,
  );
  await chmod(command, 0o700);
  await writeFile(join(directory, "app.js"), "app");

  try {
    const manifest = await publishAssets({
      directory,
      releaseId: RELEASE_ID,
      runner: createMagicBuilderRunner({ command }),
    });
    assert.deepEqual((await readFile(callLog, "utf8")).trim().split("\n"), [
      `magic-resume/releases/${RELEASE_ID}/release.json`,
      `magic-resume/releases/${RELEASE_ID}/app.js`,
    ]);
    assert.equal(manifest.files["app.js"].url,
      `https://assets.example.test/magic-resume/releases/${RELEASE_ID}/app.js`);
    await assert.rejects(
      publishAssets({
        directory,
        releaseId: RELEASE_ID,
        runner: createMagicBuilderRunner({ command }),
      }),
      { code: "MIAOBI_RELEASE_RESERVED" },
    );
    assert.equal((await readFile(callLog, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the documented magic-builder 1.3.0 file upload argument contract", async () => {
  const { root, directory } = await fixture();
  const calls: string[][] = [];
  const runner: MagicBuilderRunner = {
    async run(args) {
      calls.push(args);
      const key = args[args.indexOf("--key") + 1];
      return {
        stdout: JSON.stringify({
          id: `upload-${calls.length}`,
          url: `https://assets.example.test/${key}`,
        }),
        stderr: "",
      };
    },
  };
  await writeFile(join(directory, "app.js"), "app");
  try {
    await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    assert.deepEqual(calls[0].slice(0, 3), ["file", "upload", calls[0][2]]);
    assert.equal(calls[0][2].endsWith("release.json"), true);
    assert.deepEqual(calls[0].slice(3), [
      "--key",
      `magic-resume/releases/${RELEASE_ID}/release.json`,
      "--content-type",
      "application/json; charset=utf-8",
      "--format",
      "json",
      "--quiet",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked local state directory before upload", async () => {
  const { root, directory } = await fixture();
  const outside = join(root, "outside-state");
  const { runner, uploads } = fakeRunner();
  await mkdir(outside);
  await symlink(outside, join(root, ".miaobi"));
  await writeFile(join(directory, "app.js"), "app");
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      { code: "MIAOBI_INVALID_PATH" },
    );
    assert.equal(uploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reserves a release ID locally so a retry cannot upload again", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  await writeFile(join(directory, "app.js"), "app");
  try {
    await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    const uploadCount = uploads.length;
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      { code: "MIAOBI_RELEASE_RESERVED" },
    );
    assert.equal(uploads.length, uploadCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomically rejects a concurrent publication with the same release ID", async () => {
  const { root, directory } = await fixture();
  await writeFile(join(directory, "app.js"), "app");
  let releaseFirstUpload!: () => void;
  let markFirstUploadStarted!: () => void;
  const firstUploadStarted = new Promise<void>((resolve) => {
    markFirstUploadStarted = resolve;
  });
  const firstUploadGate = new Promise<void>((resolve) => {
    releaseFirstUpload = resolve;
  });
  let calls = 0;
  const runner: MagicBuilderRunner = {
    async run(args) {
      calls += 1;
      if (calls === 1) {
        markFirstUploadStarted();
        await firstUploadGate;
      }
      const key = args[args.indexOf("--key") + 1];
      return {
        stdout: JSON.stringify({
          id: `upload-${calls}`,
          url: `https://assets.example.test/${key}`,
        }),
        stderr: "",
      };
    },
  };

  const first = publishAssets({ directory, releaseId: RELEASE_ID, runner });
  try {
    await firstUploadStarted;
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      { code: "MIAOBI_RELEASE_RESERVED" },
    );
  } finally {
    releaseFirstUpload();
    await first;
    await rm(root, { recursive: true, force: true });
  }
});

test("builds a release ID from 12 hexadecimal commit characters and UTC time", () => {
  assert.equal(
    createReleaseId(
      "CAA88A95D5F9114827F53705B9261C90CA9317E0",
      new Date("2026-09-13T15:51:00.999Z"),
    ),
    RELEASE_ID,
  );
  assert.throws(() => createReleaseId("not-a-commit", new Date()), {
    code: "MIAOBI_INVALID_RELEASE",
  });
});

test("rejects a traversal release ID before uploading", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  await writeFile(join(directory, "index.html"), "safe");
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: "../escape", runner }),
      (error: unknown) =>
        (error as { code?: string }).code === "MIAOBI_INVALID_PATH",
    );
    assert.equal(uploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlink whose target is outside the publication root", async () => {
  const { root, directory } = await fixture();
  const outside = join(root, "secret.txt");
  const { runner, uploads } = fakeRunner();
  await writeFile(outside, "secret");
  await symlink(outside, join(directory, "escape.txt"));
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      (error: unknown) =>
        (error as { code?: string }).code === "MIAOBI_INVALID_PATH",
    );
    assert.equal(uploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlink in an ancestor of the publication root", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "miaobi-ancestor-")));
  const actualParent = join(root, "actual-project");
  const linkedParent = join(root, "linked-project");
  const directory = join(actualParent, "dist", "miaobi", "client");
  const { runner, uploads } = fakeRunner();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "app.js"), "safe");
  await symlink(actualParent, linkedParent);
  try {
    await assert.rejects(
      publishAssets({
        directory: join(linkedParent, "dist", "miaobi", "client"),
        releaseId: RELEASE_ID,
        runner,
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "MIAOBI_INVALID_PATH",
    );
    assert.equal(uploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a publication root that is itself a symlink", async () => {
  const { root, directory } = await fixture();
  const linkedDirectory = join(root, "linked-client");
  const { runner, uploads } = fakeRunner();
  await writeFile(join(directory, "app.js"), "app");
  await symlink(directory, linkedDirectory);
  try {
    await assert.rejects(
      publishAssets({ directory: linkedDirectory, releaseId: RELEASE_ID, runner }),
      (error: unknown) =>
        (error as { code?: string }).code === "MIAOBI_INVALID_PATH",
    );
    assert.equal(uploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks even when their target stays inside the root", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  const target = join(directory, "target.js");
  await writeFile(target, "safe");
  await symlink(target, join(directory, "alias.js"));
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      (error: unknown) =>
        (error as { code?: string }).code === "MIAOBI_INVALID_PATH",
    );
    assert.equal(uploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not let a symlink expose an excluded dotfile", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  const hidden = join(directory, ".secret.js");
  await writeFile(hidden, "secret");
  await symlink(hidden, join(directory, "public.js"));
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      (error: unknown) =>
        (error as { code?: string }).code === "MIAOBI_INVALID_PATH",
    );
    assert.equal(uploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a trusted pre-upload snapshot when a directory is replaced during marker upload", async () => {
  const { root, directory } = await fixture();
  const assetDirectory = join(directory, "assets");
  const replacementDirectory = join(root, "replacement-assets");
  const movedDirectory = join(root, "moved-assets");
  const uploads: Upload[] = [];
  await mkdir(assetDirectory);
  await mkdir(replacementDirectory);
  await writeFile(join(assetDirectory, "app.js"), "public-bytes");
  await writeFile(join(replacementDirectory, "app.js"), "root-secret");
  const runner: MagicBuilderRunner = {
    async run(args) {
      const key = args[args.indexOf("--key") + 1];
      const contentType = args[args.indexOf("--content-type") + 1];
      const content = await readFile(args[2]);
      uploads.push({ args, key, contentType, content });
      if (uploads.length === 1) {
        await rename(assetDirectory, movedDirectory);
        await rename(replacementDirectory, assetDirectory);
      }
      return {
        stdout: JSON.stringify({
          id: `upload-${uploads.length}`,
          url: `https://assets.example.test/${key}`,
        }),
        stderr: "",
      };
    },
  };

  try {
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    assert.equal(uploads.length, 2, "marker and snapshotted asset reach the runner");
    const assetUpload = uploads.find((upload) => upload.key.endsWith("/assets/app.js"));
    assert.ok(assetUpload);
    assert.equal(assetUpload.content.toString("utf8"), "public-bytes");
    assert.equal(manifest.files["assets/app.js"].contentHash,
      createHash("sha256").update("public-bytes").digest("hex"));
    assert.equal(
      uploads.some((upload) => upload.content.includes(Buffer.from("root-secret"))),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes dotfiles, source maps, and server bundles", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  await mkdir(join(directory, ".private"));
  await mkdir(join(directory, "server"));
  await writeFile(join(directory, "app.js"), "app");
  await writeFile(join(directory, ".env"), "secret");
  await writeFile(join(directory, ".private", "hidden.js"), "secret");
  await writeFile(join(directory, "app.js.map"), "sources");
  await writeFile(join(directory, "server", "entry.js"), "server");
  await writeFile(join(directory, "entry.server.js"), "server");
  try {
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    assert.deepEqual(Object.keys(manifest.files), ["app.js"]);
    assert.equal(uploads.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploads supported assets with explicit MIME types and normalized keys", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  const expected = {
    "app.js": "application/javascript; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "data.json": "application/json; charset=utf-8",
    "image.svg": "image/svg+xml",
    "image.png": "image/png",
    "photo.jpg": "image/jpeg",
    "font.ttf": "font/ttf",
    "font.otf": "font/otf",
    "font.woff": "font/woff",
    "font.woff2": "font/woff2",
  } as const;
  for (const file of Object.keys(expected)) {
    await writeFile(join(directory, file), file);
  }
  try {
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    for (const [relativePath, contentType] of Object.entries(expected)) {
      assert.equal(manifest.files[relativePath].contentType, contentType);
      assert.equal(
        manifest.files[relativePath].key,
        `magic-resume/releases/${RELEASE_ID}/${relativePath}`,
      );
    }
    for (const upload of uploads) {
      assert.ok(upload.contentType.length > 0);
      assert.equal(upload.key.includes("\\"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploads duplicate final content once and maps it to a deterministic key", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  await writeFile(join(directory, "z.js"), "same");
  await writeFile(join(directory, "a.js"), "same");
  try {
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    assert.equal(uploads.length, 2, "release marker plus one unique asset");
    const canonicalKey = `magic-resume/releases/${RELEASE_ID}/a.js`;
    assert.equal(manifest.files["a.js"].key, canonicalKey);
    assert.equal(manifest.files["z.js"].key, canonicalKey);
    assert.equal(manifest.files["a.js"].url, manifest.files["z.js"].url);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commits an owner-scoped immutable manifest before exposing the compatibility manifest", async () => {
  const { root, directory } = await fixture();
  const { runner } = fakeRunner();
  await writeFile(join(directory, "app.js"), "app");
  try {
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    const names = await readdir(join(root, ".miaobi", "manifests"));
    assert.equal(names.length, 1);
    assert.match(names[0], new RegExp(`^${RELEASE_ID}-[0-9a-f]{32}\\.json$`));
    assert.deepEqual(
      JSON.parse(await readFile(join(root, ".miaobi", "manifests", names[0]), "utf8")),
      manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("releases an uncommitted reservation after upload failure so the same release can recover", { concurrency: false }, async () => {
  const { root, directory } = await fixture();
  await writeFile(join(directory, "app.js"), "app");
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner: fakeRunner({ failAt: 2 }).runner }),
      { code: "MIAOBI_CLI_FAILED" },
    );
    const retry = fakeRunner();
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner: retry.runner });
    assert.equal(manifest.releaseId, RELEASE_ID);
    assert.equal(retry.uploads.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not create a manifest when an asset upload fails", async () => {
  const { root, directory } = await fixture();
  const { runner } = fakeRunner({ failAt: 2 });
  await writeFile(join(directory, "app.js"), "app");
  const manifestPath = join(dirname(directory), "asset-manifest.json");
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "MIAOBI_CLI_FAILED");
        assert.doesNotMatch(String(error), /do-not-leak|token/i);
        return true;
      },
    );
    await assert.rejects(access(manifestPath), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not commit the manifest when final state preparation fails", async () => {
  const { root, directory } = await fixture();
  const statePath = join(root, ".miaobi", "state.json");
  let calls = 0;
  const runner: MagicBuilderRunner = {
    async run(args) {
      calls += 1;
      const key = args[args.indexOf("--key") + 1];
      if (calls === 2) await writeFile(statePath, "not-json");
      return {
        stdout: JSON.stringify({
          id: `upload-${calls}`,
          url: `https://assets.example.test/${key}`,
        }),
        stderr: "",
      };
    },
  };
  await writeFile(join(directory, "app.js"), "app");
  const manifestPath = join(dirname(directory), "asset-manifest.json");
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      { code: "MIAOBI_STATE_FAILED" },
    );
    await assert.rejects(access(manifestPath), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves state staged when the final manifest rename fails", async () => {
  const { root, directory } = await fixture();
  const { runner } = fakeRunner();
  await writeFile(join(directory, "app.js"), "app");
  const manifestPath = join(dirname(directory), "asset-manifest.json");
  const oldContentPath = join(manifestPath, "old-manifest.json");
  await mkdir(manifestPath);
  await writeFile(oldContentPath, "old-manifest");

  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      (error: unknown) =>
        ["EISDIR", "ENOTDIR", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ),
    );
    assert.equal((await stat(manifestPath)).isDirectory(), true);
    assert.equal(await readFile(oldContentPath, "utf8"), "old-manifest");
    const state = JSON.parse(
      await readFile(join(root, ".miaobi", "state.json"), "utf8"),
    ) as { releases: Record<string, { status: string }> };
    assert.equal(state.releases[RELEASE_ID].status, "manifest-staged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects marker URLs that are not the exact clean requested key", async () => {
  const invalidUrls = [
    `https://assets.example.test/extra/magic-resume/releases/${RELEASE_ID}/release.json`,
    `https://assets.example.test/magic-resume/releases/${RELEASE_ID}/release.json?token=secret`,
    `https://assets.example.test/magic-resume/releases/${RELEASE_ID}/release.json#fragment`,
    `https://user:password@assets.example.test/magic-resume/releases/${RELEASE_ID}/release.json`,
  ];

  for (const markerUrl of invalidUrls) {
    const { root, directory } = await fixture();
    const runner: MagicBuilderRunner = {
      async run() {
        return {
          stdout: JSON.stringify({ id: "marker", url: markerUrl }),
          stderr: "",
        };
      },
    };
    try {
      await assert.rejects(
        publishAssets({ directory, releaseId: RELEASE_ID, runner }),
        { code: "MIAOBI_INVALID_RESPONSE" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects asset URLs outside the exact marker origin and requested key", async () => {
  const invalidAssetUrls = [
    `https://other.example.test/magic-resume/releases/${RELEASE_ID}/app.js`,
    `https://assets.example.test/extra/magic-resume/releases/${RELEASE_ID}/app.js`,
    `https://assets.example.test/magic-resume/releases/${RELEASE_ID}/other.js`,
    `https://user:password@assets.example.test/magic-resume/releases/${RELEASE_ID}/app.js`,
    `https://assets.example.test/magic-resume/releases/${RELEASE_ID}/app.js?token=secret`,
    `https://assets.example.test/magic-resume/releases/${RELEASE_ID}/app.js#fragment`,
  ];

  for (const assetUrl of invalidAssetUrls) {
    const { root, directory } = await fixture();
    let calls = 0;
    const runner: MagicBuilderRunner = {
      async run(args) {
        calls += 1;
        const key = args[args.indexOf("--key") + 1];
        return {
          stdout: JSON.stringify({
            id: `upload-${calls}`,
            url: calls === 1
              ? `https://assets.example.test/${key}`
              : assetUrl,
          }),
          stderr: "",
        };
      },
    };
    await writeFile(join(directory, "app.js"), "app");
    try {
      await assert.rejects(
        publishAssets({ directory, releaseId: RELEASE_ID, runner }),
        { code: "MIAOBI_INVALID_RESPONSE" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects a non-HTTPS asset URL instead of persisting it", async () => {
  const { root, directory } = await fixture();
  let calls = 0;
  const runner: MagicBuilderRunner = {
    async run(args) {
      calls += 1;
      const key = args[args.indexOf("--key") + 1];
      return {
        stdout: JSON.stringify({
          id: `upload-${calls}`,
          url: calls === 1
            ? `https://assets.example.test/${key}`
            : "file:///Users/private/asset.js",
        }),
        stderr: "",
      };
    },
  };
  await writeFile(join(directory, "app.js"), "app");
  try {
    await assert.rejects(
      publishAssets({ directory, releaseId: RELEASE_ID, runner }),
      (error: unknown) =>
        (error as { code?: string }).code === "MIAOBI_INVALID_RESPONSE",
    );
    await assert.rejects(access(join(dirname(directory), "asset-manifest.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewrites placeholders only in text assets and hashes the final bytes", async () => {
  const { root, directory } = await fixture();
  const { runner, uploads } = fakeRunner();
  const binary = Buffer.concat([
    Buffer.from([0, 255, 1, 2]),
    Buffer.from(PLACEHOLDER),
  ]);
  await writeFile(join(directory, "index.html"), `<script src="${PLACEHOLDER}app.js"></script>`);
  await writeFile(join(directory, "app.js"), `const base = "${PLACEHOLDER}";`);
  await writeFile(join(directory, "style.css"), `url(${PLACEHOLDER}font.woff2)`);
  await writeFile(join(directory, "image.png"), binary);
  try {
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    for (const relativePath of ["index.html", "app.js", "style.css"]) {
      const upload = uploads.find((entry) => basename(entry.key) === basename(relativePath));
      assert.ok(upload);
      assert.equal(upload.content.includes(Buffer.from(PLACEHOLDER)), false);
      assert.equal(upload.content.includes(Buffer.from(RELEASE_BASE)), true);
      assert.equal(
        manifest.files[relativePath].contentHash,
        createHash("sha256").update(upload.content).digest("hex"),
      );
    }
    const pngUpload = uploads.find((entry) => entry.key.endsWith("/image.png"));
    assert.ok(pngUpload);
    assert.deepEqual(pngUpload.content, binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes a manifest without local absolute paths after every upload succeeds", async () => {
  const { root, directory } = await fixture();
  const { runner } = fakeRunner();
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "assets", "app.js"), "app");
  const manifestPath = join(dirname(directory), "asset-manifest.json");
  try {
    const manifest = await publishAssets({ directory, releaseId: RELEASE_ID, runner });
    const persisted = await readFile(manifestPath, "utf8");
    assert.deepEqual(JSON.parse(persisted), manifest);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.releaseId, RELEASE_ID);
    assert.equal(manifest.baseUrl, RELEASE_BASE);
    assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(persisted.includes(root), false);
    assert.equal(persisted.includes("/Users/"), false);
    assert.equal(persisted.includes("/workspace/"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
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
        const fileIndex = args.indexOf("--file");
        assert.notEqual(keyIndex, -1);
        assert.notEqual(typeIndex, -1);
        assert.notEqual(fileIndex, -1);
        const key = args[keyIndex + 1];
        const contentType = args[typeIndex + 1];
        const content = await readFile(args[fileIndex + 1]);
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
  const root = await mkdtemp(join(tmpdir(), "miaobi-assets-"));
  const directory = join(root, "dist", "miaobi", "client");
  await mkdir(directory, { recursive: true });
  return { root, directory };
}

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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  isForbiddenAssetHostname,
  materializeGitHubPagesRelease,
} from "../scripts/miaobi/github-pages-assets";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const distDirectory = join(root, "dist");
const miaobiDirectory = join(distDirectory, "miaobi");
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt", ".xml"]);
const assetPlaceholderPrefix = "https://miaobi.invalid/__ASSET_BASE__/";
const exactRuntimeOrigins = new Set([
  "https://aistudio.google.com",
  "https://api.anthropic.com",
  "https://api.deepseek.com",
  "https://api.github.com",
  "https://api.magicv.art",
  "https://api.openai.com",
  "https://aurostars.github.io",
  "https://ark.cn-beijing.volces.com",
  "https://bailian.console.aliyun.com",
  "https://console.anthropic.com",
  "https://console.volcengine.com",
  "https://dashscope.aliyuncs.com",
  "https://fonts.googleapis.com",
  "https://generativelanguage.googleapis.com",
  "https://github.com",
  "https://magicv.art",
  "https://platform.deepseek.com",
  "https://platform.openai.com",
  "https://prosemirror.net",
  "https://radix-ui.com",
  "https://reactjs.org",
  "https://tanstack.com",
  "https://www.google.cn",
]);
const exactEmbeddedDataOrigins = new Set([
  "http://example.com",
  "http://jspdf.default.namespaceuri",
  "http://localhost",
  "http://ns.adobe.com",
  "http://www.apache.org",
  "http://www.ibm.com",
  "http://www.sitemaps.org",
  "http://www.w3.org",
  "http://www.xfa.org",
  "https://a",
  "https://example.com",
  "https://foo.bar",
  "https://openai.example.org",
  "https://x",
  "https://xn--e1aybc",
  "https://zhangsan.dev",
]);
const exactEmbeddedDataUrls = new Set(["https://a@b"]);
const knownTestSecrets = [
  "sk-test-miaobi-secret",
  "token=do-not-leak",
  "credential=asset-secret",
  "password=secret",
  "api-secret",
];

async function runScript(script: "build" | "build:miaobi"): Promise<void> {
  await execFileAsync("corepack", ["pnpm", script], {
    cwd: root,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function filesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    assert.equal(metadata.isSymbolicLink(), false, `generated artifact must not be a symlink: ${path}`);
    if (metadata.isDirectory()) files.push(...await filesRecursively(path));
    else {
      assert.equal(metadata.isFile(), true, `generated artifact must be a regular file: ${path}`);
      files.push(path);
    }
  }
  return files;
}

async function removeGeneratedDirectory(directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      await rm(directory, { force: true });
    } else {
      await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function withIsolatedDirectory<T>(
  directory: string,
  run: () => Promise<T>,
  operations: { removeDirectory?: (path: string) => Promise<void> } = {},
): Promise<T> {
  const parent = dirname(directory);
  const name = directory.slice(parent.length + 1);
  const backup = join(parent, `${name}.backup-${process.pid}-${randomUUID()}`);
  const removeDirectory = operations.removeDirectory ?? removeGeneratedDirectory;
  let hasBackup = false;
  let prepared = false;

  try {
    try {
      const metadata = await lstat(directory);
      assert.equal(metadata.isSymbolicLink(), false, `${directory} must not be a symlink`);
      assert.equal(metadata.isDirectory(), true, `${directory} must be a directory`);
      await rename(directory, backup);
      hasBackup = true;
      prepared = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      prepared = true;
    }

    return await run();
  } finally {
    if (prepared) {
      let cleanupError: unknown;
      try {
        await removeDirectory(directory);
      } catch (error) {
        cleanupError = error;
      }

      if (hasBackup) {
        if (await pathExists(directory)) {
          const quarantine = join(parent, `${name}.quarantine-${process.pid}-${randomUUID()}`);
          await rename(directory, quarantine);
        }
        await rename(backup, directory);
      }

      if (cleanupError) throw cleanupError;
    }
  }
}

function normalizeEscapedUrlSyntax(text: string): string {
  return text.replace(
    /(?<!\\)\\(?:\/|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2}))/g,
    (escaped, unicodeHex: string | undefined, shortHex: string | undefined) => {
      if (escaped === String.raw`\/`) return "/";
      const codePoint = Number.parseInt(unicodeHex ?? shortHex, 16);
      return codePoint >= 0x20 && codePoint <= 0x7e
        ? String.fromCharCode(codePoint)
        : escaped;
    },
  );
}

function extractAbsoluteHttpUrls(text: string): string[] {
  const normalized = normalizeEscapedUrlSyntax(text);
  const matches = normalized.match(/https?:\/\/(?!\$\{)[^\s"'`<>\\]+/gi) ?? [];
  return matches
    .map((value) => value.replace(/[),.;\]}]+$/g, ""))
    .filter((value) => URL.canParse(value));
}

function assertAllowedGeneratedUrl(value: string, assetOrigins: ReadonlySet<string>): void {
  const url = new URL(value);
  assert.ok(url.protocol === "http:" || url.protocol === "https:");
  assert.equal(isForbiddenAssetHostname(url.hostname), false, `forbidden generated URL provider: ${url.hostname}`);
  if (exactEmbeddedDataUrls.has(value)) return;
  assert.equal(url.username, "", `generated URL must not contain a username: ${value}`);
  assert.equal(url.password, "", `generated URL must not contain a password: ${value}`);
  if (url.origin === "https://miaobi.invalid") {
    assert.ok(value.startsWith(assetPlaceholderPrefix), `unexpected Miaobi placeholder URL: ${value}`);
    return;
  }
  assert.ok(
    url.origin === "https://magic.solutionsuite.cn" ||
      exactRuntimeOrigins.has(url.origin) ||
      exactEmbeddedDataOrigins.has(url.origin) ||
      assetOrigins.has(url.origin),
    `unexpected generated URL origin: ${url.origin} (${value})`,
  );
}

async function generatedViolations(paths: string[], assetOrigins: ReadonlySet<string>): Promise<string[]> {
  const violations: string[] = [];
  for (const path of paths.filter((candidate) => textExtensions.has(extname(candidate).toLowerCase()))) {
    const text = await readFile(path, "utf8");
    const artifact = relative(root, path);
    for (const forbidden of ["/Users/", "/workspace/", "file://"] as const) {
      if (text.toLowerCase().includes(forbidden.toLowerCase())) violations.push(`${artifact} contains ${forbidden}`);
    }
    if (/sourceMappingURL=(?:file:|\/Users\/|\/workspace\/)/i.test(text)) {
      violations.push(`${artifact} contains an absolute sourceMappingURL`);
    }
    for (const secret of knownTestSecrets) {
      if (text.includes(secret)) violations.push(`${artifact} contains a known test secret`);
    }
    for (const url of extractAbsoluteHttpUrls(text)) {
      try {
        assertAllowedGeneratedUrl(url, assetOrigins);
      } catch (error) {
        violations.push(`${artifact}: ${(error as Error).message}`);
      }
    }
  }
  return violations;
}

test("production provider rules reject exact Cloudflare and TOS hostnames without substring false positives", () => {
  for (const hostname of [
    "cloudflare.com",
    "cdnjs.cloudflare.com",
    "tenant.cloudflareworkers.com",
    "tenant.workers.dev",
    "bucket.tos-cn-beijing.volces.com",
    "tos-s3-cn-beijing.volces.com",
    "tos-cn-beijing.ivolces.com",
    "tos-s3-cn-beijing.ivolces.com",
    "bucket.tos-s3-cn-beijing.ivolces.com",
    "bucket.tos-cn-beijing.volces.com.",
  ]) assert.equal(isForbiddenAssetHostname(hostname), true, hostname);

  for (const hostname of [
    "notcloudflare.com",
    "workers.dev.example.com",
    "tos-example.com",
    "bucket.tos-cn.example.com",
    "bucket.tos-s3-cn-beijing.volces.com.example",
    "nested.bucket.tos-cn-beijing.ivolces.com",
    "example.com",
  ]) assert.equal(isForbiddenAssetHostname(hostname), false, hostname);

  assert.deepEqual(extractAbsoluteHttpUrls("const ratio=a//b;const re=/https?:\\/\\//;"), []);
});

test("production scanning rejects forbidden providers in both Miaobi and Pages trees", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "miaobi-provider-contract-"));
  try {
    const miaobi = join(fixture, "dist/miaobi/client");
    const pages = join(fixture, "dist/gh-pages-staging/objects/hash");
    await mkdir(miaobi, { recursive: true });
    await mkdir(pages, { recursive: true });
    await writeFile(
      join(miaobi, "runtime.js"),
      'fetch("https://tos-cn-beijing.ivolces.com/app.js");fetch("https://bucket.tos-cn.example.com/app.js")',
    );
    await writeFile(
      join(pages, "asset.js"),
      'fetch("https://bucket.tos-s3-cn-beijing.volces.com/app.js");fetch("https://bucket.tos-cn-beijing.volces.com.example/app.js")',
    );
    const violations = await generatedViolations([
      ...await filesRecursively(miaobi),
      ...await filesRecursively(pages),
    ], new Set([
      "https://aurostars.github.io",
      "https://bucket.tos-cn.example.com",
      "https://bucket.tos-cn-beijing.volces.com.example",
    ]));
    assert.equal(violations.length, 2);
    const details = violations.join("\n");
    assert.match(details, /tos-cn-beijing\.ivolces\.com/);
    assert.match(details, /bucket\.tos-s3-cn-beijing\.volces\.com/);
    assert.doesNotMatch(details, /bucket\.tos-cn\.example\.com/);
    assert.doesNotMatch(details, /volces\.com\.example/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("one-layer lowercase JS escapes cannot hide a disallowed absolute URL", () => {
  const rejected = [
    String.raw`\x68\u0074\x74\u0070\x73\x3a\/\u002fevil.example/path`,
    String.raw`\u0068ttps\u003a\/\/evil.example/path`,
    String.raw`http\u003a\/\/evil.example/path`,
  ];
  for (const fixture of rejected) {
    const urls = extractAbsoluteHttpUrls(fixture);
    assert.equal(urls.length, 1, `escaped URL was not extracted: ${fixture}`);
    assert.throws(() => assertAllowedGeneratedUrl(urls[0], new Set()), /unexpected generated URL origin/);
  }
});

test("one-layer lowercase JS escapes preserve exact allowed origins", () => {
  for (const [fixture, expected] of [
    [
      String.raw`\x68\u0074\x74\u0070\x73\x3A\x2F\/magic.solutionsuite.cn/path`,
      "https://magic.solutionsuite.cn/path",
    ],
    [
      String.raw`https\x3a\/\/miaobi.invalid\/__ASSET_BASE__\/chunk.js`,
      "https://miaobi.invalid/__ASSET_BASE__/chunk.js",
    ],
  ] as const) {
    const urls = extractAbsoluteHttpUrls(fixture);
    assert.deepEqual(urls, [expected]);
    assert.doesNotThrow(() => assertAllowedGeneratedUrl(urls[0], new Set()));
  }
});

test("invalid uppercase, double escapes, and ordinary source text do not become URL candidates", () => {
  for (const fixture of [
    String.raw`https\X3A\U002F\X2Fevil.example/path`,
    String.raw`\\x68\\x74\\x74\\x70\\x73\\x3a\\x2f\\x2fevil.example/path`,
    String.raw`const first = "\x68"; const second = "\u0074";`,
  ]) {
    assert.deepEqual(extractAbsoluteHttpUrls(fixture), [], `unexpected URL candidate: ${fixture}`);
  }
});

test("build isolation restores an existing dist sentinel and rejects unsafe inputs", { concurrency: false }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "magic-resume-production-contract-"));
  const directory = join(fixture, "dist");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "sentinel.txt"), "caller-owned");
    await withIsolatedDirectory(directory, async () => {
      await assert.rejects(access(join(directory, "sentinel.txt")));
      await mkdir(directory);
      await writeFile(join(directory, "generated.txt"), "generated");
    });
    assert.equal(await readFile(join(directory, "sentinel.txt"), "utf8"), "caller-owned");
    await assert.rejects(access(join(directory, "generated.txt")));

    await rm(directory, { recursive: true });
    await writeFile(directory, "not-a-directory");
    await assert.rejects(withIsolatedDirectory(directory, async () => undefined), /must be a directory/);

    await rm(directory);
    await mkdir(join(fixture, "target"));
    await symlink(join(fixture, "target"), directory, "dir");
    await assert.rejects(withIsolatedDirectory(directory, async () => undefined), /must not be a symlink/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("build isolation restores an existing dist sentinel when generated-dist cleanup fails", { concurrency: false }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "magic-resume-production-contract-cleanup-"));
  const directory = join(fixture, "dist");
  try {
    await mkdir(directory);
    await writeFile(join(directory, "sentinel.txt"), "caller-owned");

    await assert.rejects(
      withIsolatedDirectory(
        directory,
        async () => {
          await mkdir(directory);
          await writeFile(join(directory, "generated.txt"), "generated");
        },
        {
          removeDirectory: async () => {
            const error = new Error("simulated cleanup failure") as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          },
        },
      ),
      /simulated cleanup failure/,
    );

    assert.equal(await readFile(join(directory, "sentinel.txt"), "utf8"), "caller-owned");
    await assert.rejects(access(join(directory, "generated.txt")));
    const quarantines = (await readdir(fixture)).filter((entry) => entry.startsWith("dist.quarantine-"));
    assert.equal(quarantines.length, 1);
    assert.equal(await readFile(join(fixture, quarantines[0], "generated.txt"), "utf8"), "generated");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("production builds emit isolated complete artifacts with only audited URLs and no local leaks", { concurrency: false, timeout: 180_000 }, async () => {
  await withIsolatedDirectory(distDirectory, async () => {
    await runScript("build:miaobi");

    for (const artifact of [
      "api-faas.cjs",
      "api-faas.meta.json",
      "web-faas.cjs",
      "page.html",
      "manifest.json",
      "client/index.html",
    ]) await access(join(miaobiDirectory, artifact));

    const assets = await filesRecursively(join(miaobiDirectory, "client/assets"));
    assert.ok(assets.length > 0, "Miaobi client assets must not be empty");

    const manifest = JSON.parse(await readFile(join(miaobiDirectory, "manifest.json"), "utf8")) as {
      schemaVersion: number;
      assetProvider: string;
      pagesBaseUrl: string;
      platformOrigin: string;
      pageUrl: string;
      artifacts: Record<string, string>;
    };
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.assetProvider, "github-pages");
    assert.equal(manifest.pagesBaseUrl, "https://aurostars.github.io/magic-resume/");
    assert.deepEqual(manifest.artifacts, {
      apiFaas: "api-faas.cjs",
      apiMetadata: "api-faas.meta.json",
      client: "client",
      page: "page.html",
      webFaas: "web-faas.cjs",
    });

    const assetOrigins = new Set([
      "https://aurostars.github.io",
      "https://dav.jianguoyun.com",
    ]);
    const pagesDirectory = join(distDirectory, "gh-pages-staging");
    await materializeGitHubPagesRelease({
      clientDirectory: join(miaobiDirectory, "client"),
      pagesDirectory,
      sourceCommit: "59a06b5c2c127d287d01016e5be4d781e310fe2e",
      releaseId: "59a06b5c2c12-20260914100000",
      pagesOrigin: "https://aurostars.github.io",
      pagesBasePath: "/magic-resume/",
    });
    const generatedFiles = [
      ...await filesRecursively(miaobiDirectory),
      ...await filesRecursively(pagesDirectory),
    ];
    const violations = await generatedViolations(generatedFiles, assetOrigins);
    assert.deepEqual(violations, []);

    await runScript("build");
    assert.equal((await stat(join(distDirectory, "client"))).isDirectory(), true);
    assert.equal((await stat(join(distDirectory, "server/server.js"))).isFile(), true);
  });
});

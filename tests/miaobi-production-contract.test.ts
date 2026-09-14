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
  "https://ark.cn-beijing.volces.com",
  "https://bailian.console.aliyun.com",
  "https://cdnjs.cloudflare.com",
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

async function withIsolatedDirectory<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const parent = dirname(directory);
  const backup = join(parent, `${directory.slice(parent.length + 1)}.backup-${process.pid}-${randomUUID()}`);
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
      if (hasBackup) await rename(backup, directory);
    }
  }
}

function extractAbsoluteHttpUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/(?!\$\{)[^\s"'`<>\\]+/g) ?? [];
  return matches
    .map((value) => value.replace(/[),.;\]}]+$/g, ""))
    .filter((value) => URL.canParse(value));
}

async function manifestTosOrigins(): Promise<Set<string>> {
  const path = join(miaobiDirectory, "asset-manifest.json");
  try {
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      baseUrl?: unknown;
      files?: Record<string, { url?: unknown }>;
    };
    assert.equal(typeof manifest.baseUrl, "string");
    const base = new URL(manifest.baseUrl as string);
    assert.equal(base.protocol, "https:");
    assert.equal(base.username, "");
    assert.equal(base.password, "");
    assert.ok(manifest.files && typeof manifest.files === "object");
    for (const record of Object.values(manifest.files)) {
      assert.equal(typeof record.url, "string");
      const url = new URL(record.url as string);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username, "");
      assert.equal(url.password, "");
      assert.equal(url.origin, base.origin);
    }
    return new Set([base.origin]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

function assertAllowedGeneratedUrl(value: string, tosOrigins: ReadonlySet<string>): void {
  const url = new URL(value);
  assert.ok(url.protocol === "http:" || url.protocol === "https:");
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
      tosOrigins.has(url.origin),
    `unexpected generated URL origin: ${url.origin} (${value})`,
  );
}

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
      platformOrigin: string;
      pageUrl: string;
      artifacts: Record<string, string>;
    };
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.artifacts, {
      apiFaas: "api-faas.cjs",
      apiMetadata: "api-faas.meta.json",
      client: "client",
      page: "page.html",
      webFaas: "web-faas.cjs",
    });

    const tosOrigins = await manifestTosOrigins();
    const generatedFiles = await filesRecursively(miaobiDirectory);
    const violations: string[] = [];
    for (const path of generatedFiles.filter((candidate) => textExtensions.has(extname(candidate).toLowerCase()))) {
      const text = await readFile(path, "utf8");
      const artifact = relative(root, path);
      for (const forbidden of ["workers.dev", "/Users/", "/workspace/", "file://"] as const) {
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
          assertAllowedGeneratedUrl(url, tosOrigins);
        } catch (error) {
          violations.push(`${artifact}: ${(error as Error).message}`);
        }
      }
    }
    assert.deepEqual(violations, []);

    await runScript("build");
    assert.equal((await stat(join(distDirectory, "client"))).isDirectory(), true);
    assert.equal((await stat(join(distDirectory, "server/server.js"))).isFile(), true);
  });
});

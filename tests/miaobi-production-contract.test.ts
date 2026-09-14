import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const miaobiDirectory = join(root, "dist/miaobi");
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt", ".xml"]);
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
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(path) : [path];
  }))).flat();
}

function extension(path: string): string {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0].toLowerCase() ?? "";
}

function assertAllowedProductionUrl(value: string): void {
  const url = new URL(value);
  assert.equal(url.protocol, "https:");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.ok(
    url.origin === "https://magic.solutionsuite.cn" || url.hostname.toLowerCase().includes("tos"),
    `unexpected production URL host: ${url.origin}`,
  );
}

test("production builds emit complete Miaobi artifacts without forbidden hosts or test secrets", { timeout: 180_000 }, async () => {
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
  assertAllowedProductionUrl(manifest.platformOrigin);
  assertAllowedProductionUrl(manifest.pageUrl);
  assert.deepEqual(manifest.artifacts, {
    apiFaas: "api-faas.cjs",
    apiMetadata: "api-faas.meta.json",
    client: "client",
    page: "page.html",
    webFaas: "web-faas.cjs",
  });

  const page = await readFile(join(miaobiDirectory, "page.html"), "utf8");
  const pageUrls = [...page.matchAll(/https:\/\/[^"'<>\s]+/g)].map((match) => match[0]);
  assert.ok(pageUrls.length > 0, "page artifact must expose its canonical HTTPS URL");
  pageUrls.forEach(assertAllowedProductionUrl);

  const generatedFiles = await filesRecursively(miaobiDirectory);
  for (const path of generatedFiles.filter((candidate) => textExtensions.has(extension(candidate)))) {
    const text = await readFile(path, "utf8");
    assert.equal(text.toLowerCase().includes("workers.dev"), false, `${relative(root, path)} contains workers.dev`);
    for (const secret of knownTestSecrets) {
      assert.equal(text.includes(secret), false, `${relative(root, path)} contains a known test secret`);
    }
  }

  await runScript("build");
  assert.equal((await stat(join(root, "dist/client"))).isDirectory(), true);
  assert.equal((await stat(join(root, "dist/server/server.js"))).isFile(), true);
});

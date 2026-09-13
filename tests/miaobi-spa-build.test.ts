import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import {
  buildMiaobiSpa,
  injectMiaobiRuntime,
} from "../scripts/miaobi/build-spa";

const ASSET_BASE_PLACEHOLDER = "https://miaobi.invalid/__ASSET_BASE__/";
const cssLoader = `export async function load(url, context, nextLoad) {
  if (url.endsWith("?url")) {
    return { format: "module", shortCircuit: true, source: "export default 'test-asset-url';" };
  }
  if (/\\.(?:css|scss|svg)(?:$|\\?)/.test(url)) {
    return { format: "module", shortCircuit: true, source: "export default {};" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(cssLoader)}`, import.meta.url);

async function snapshotPath(path: string): Promise<string> {
  try {
    const metadata = await stat(path);
    if (metadata.isFile()) {
      return createHash("sha256").update(await readFile(path)).digest("hex");
    }

    const entries = await readdir(path, { withFileTypes: true });
    const contents = await Promise.all(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) =>
          `${entry.name}:${await snapshotPath(join(path, entry.name))}`),
    );
    return createHash("sha256").update(contents.join("\n")).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "<missing>";
    throw error;
  }
}

async function readFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? readFilesRecursively(path) : [path];
    }),
  );
  return files.flat();
}

test("runtime injection precedes application scripts and cannot terminate its script", () => {
  const html = '<!doctype html><html><body><script type="module" src="/entry.js"></script></body></html>';
  const injected = injectMiaobiRuntime(html, {
    platform: "miaobi",
    apiFunctionUrl: "https://api.example.test/<script>&value=\u2028",
    assetBaseUrl: "https://assets.example.test/</script>?value=\u2029",
  });

  const assignment =
    '<script>window.__MAGIC_RESUME_RUNTIME__={"platform":"miaobi","apiFunctionUrl":"https://api.example.test/\\u003cscript\\u003e\\u0026value=\\u2028","assetBaseUrl":"https://assets.example.test/\\u003c/script\\u003e?value=\\u2029"}</script>';
  assert.equal(injected.match(/window\.__MAGIC_RESUME_RUNTIME__/g)?.length, 1);
  assert.ok(injected.includes(assignment));
  assert.ok(injected.indexOf(assignment) < injected.indexOf('<script type="module"'));
  assert.doesNotMatch(injected, /<\/script>\?value/);
});

test("the root document and standalone SPA share AppBody without nested documents", async () => {
  const { AppBody, Route } = await import("../src/routes/__root");
  assert.equal(typeof AppBody, "function");
  assert.equal(typeof Route.options.component, "function");

  const directory = await mkdtemp(join(tmpdir(), "magic-resume-spa-shell-"));
  try {
    const { shellPath } = await buildMiaobiSpa({
      outputDirectory: join(directory, "client"),
      assetBasePlaceholder: ASSET_BASE_PLACEHOLDER,
    });
    const shell = await readFile(shellPath, "utf8");

    assert.match(shell, /^<!DOCTYPE html><html/i);
    assert.equal(shell.match(/<html(?:\s|>)/gi)?.length, 1);
    assert.equal(shell.match(/<body(?:\s|>)/gi)?.length, 1);
    assert.doesNotMatch(shell, /<div[^>]*>\s*<html(?:\s|>)/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the isolated Miaobi build emits a placeholder-based hash-history client only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-spa-build-"));
  const outputDirectory = join(directory, "client");
  const protectedPaths = [
    "dist/client",
    "dist/server",
    "src/routeTree.gen.ts",
    "vite.config.ts",
  ];
  const before = await Promise.all(protectedPaths.map(snapshotPath));

  try {
    const result = await buildMiaobiSpa({
      outputDirectory,
      assetBasePlaceholder: ASSET_BASE_PLACEHOLDER,
    });
    assert.deepEqual(result, {
      shellPath: join(outputDirectory, "index.html"),
      assetDirectory: join(outputDirectory, "assets"),
    });

    const shell = await readFile(result.shellPath, "utf8");
    assert.match(
      shell,
      /<script[^>]+type="module"[^>]*>import\("https:\/\/miaobi\.invalid\/__ASSET_BASE__\//,
    );
    assert.match(shell, /<link[^>]+rel="stylesheet"[^>]+href="https:\/\/miaobi\.invalid\/__ASSET_BASE__\//);
    assert.doesNotMatch(shell, /<iframe|html box/i);

    const files = await readFilesRecursively(outputDirectory);
    const javascript = (
      await Promise.all(
        files
          .filter((path) => /\.(?:js|mjs)$/.test(path))
          .map((path) => readFile(path, "utf8")),
      )
    ).join("\n");
    assert.doesNotMatch(
      javascript,
      /workers\.dev|(?:from\s*|import\s*\()["'](?:cloudflare:|wrangler)/i,
    );
    assert.doesNotMatch(javascript, /(?:from\s*|import\s*\()["']node:/);
    assert.match(javascript, /platform\s*===\s*["']miaobi["']/);
    assert.match(javascript, /createHashHistory|hashchange/);
    assert.equal(await snapshotPath(join(dirname(outputDirectory), "server")), "<missing>");
  } finally {
    const after = await Promise.all(protectedPaths.map(snapshotPath));
    assert.deepEqual(after, before);
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  buildMiaobiSpa,
  injectMiaobiRuntime,
  replaceDirectory,
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

test("runtime injection precedes application scripts with canonical production URLs", () => {
  const html = '<!doctype html><html><body><script type="module" src="/entry.js"></script></body></html>';
  const injected = injectMiaobiRuntime(html, {
    platform: "miaobi",
    apiFunctionUrl: "https://magic.solutionsuite.cn/api/faas/api-id",
    assetBaseUrl: "https://aurostars.github.io/magic-resume/",
  });

  const assignment =
    '<script>window.__MAGIC_RESUME_RUNTIME__={"platform":"miaobi","apiFunctionUrl":"https://magic.solutionsuite.cn/api/faas/api-id","assetBaseUrl":"https://aurostars.github.io/magic-resume/"}</script>';
  assert.equal(injected.match(/window\.__MAGIC_RESUME_RUNTIME__/g)?.length, 1);
  assert.ok(injected.includes(assignment));
  assert.ok(injected.indexOf(assignment) < injected.indexOf('<script type="module"'));
});

test("an injected built shell bootstraps getRouter with hash history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-spa-bootstrap-"));
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalSelf = globalThis.self;
  const dom = new JSDOM("", {
    url: "https://magic-resume.test/",
    runScripts: "outside-only",
  });

  try {
    const { shellPath } = await buildMiaobiSpa({
      outputDirectory: join(directory, "client"),
      assetBasePlaceholder: ASSET_BASE_PLACEHOLDER,
    });
    const shell = injectMiaobiRuntime(await readFile(shellPath, "utf8"), {
      platform: "miaobi",
      apiFunctionUrl: "https://magic.solutionsuite.cn/api/faas/api-id",
      assetBaseUrl: "https://aurostars.github.io/magic-resume/",
    });
    const document = new JSDOM(shell).window.document;
    const runtimeScript = [...document.scripts].find((script) =>
      script.textContent.includes("window.__MAGIC_RESUME_RUNTIME__="),
    );
    assert.ok(runtimeScript);

    Object.defineProperties(globalThis, {
      window: { configurable: true, value: dom.window },
      document: { configurable: true, value: dom.window.document },
      self: { configurable: true, value: dom.window },
    });
    dom.window.eval(runtimeScript.textContent);

    const { getRouter } = await import("../src/router");
    const router = getRouter();
    const history = router.options.history;
    assert.ok(history);
    history.push("/app/settings");
    await Promise.resolve();

    assert.equal(history.location.pathname, "/app/settings");
    assert.equal(dom.window.location.pathname, "/");
    assert.equal(dom.window.location.hash, "#/app/settings");
  } finally {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
    if (originalSelf === undefined) {
      Reflect.deleteProperty(globalThis, "self");
    } else {
      Object.defineProperty(globalThis, "self", {
        configurable: true,
        value: originalSelf,
      });
    }
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed directory replacement restores the previous output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-spa-swap-"));
  const outputDirectory = join(directory, "client");
  const missingStagedDirectory = join(directory, "missing-client");

  try {
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, "sentinel.txt"), "previous-output");

    await assert.rejects(
      replaceDirectory(missingStagedDirectory, outputDirectory),
    );
    assert.equal(
      await readFile(join(outputDirectory, "sentinel.txt"), "utf8"),
      "previous-output",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      assetDirectory: outputDirectory,
    });

    const shell = await readFile(result.shellPath, "utf8");
    assert.match(
      shell,
      /<script[^>]+type="module"[^>]*>import\("https:\/\/miaobi\.invalid\/__ASSET_BASE__\//,
    );
    assert.match(shell, /<link[^>]+rel="stylesheet"[^>]+href="https:\/\/miaobi\.invalid\/__ASSET_BASE__\/assets\//);
    assert.match(shell, /https:\/\/miaobi\.invalid\/__ASSET_BASE__\/fonts\/AlibabaPuHuiTi-3-55-Regular\.ttf/);
    assert.match(shell, /https:\/\/miaobi\.invalid\/__ASSET_BASE__\/favicon\.ico\?v=2/);
    assert.doesNotMatch(shell, /<iframe|html box/i);

    const files = await readFilesRecursively(outputDirectory);
    const stylesheets = (
      await Promise.all(
        files
          .filter((path) => path.endsWith(".css"))
          .map((path) => readFile(path, "utf8")),
      )
    ).join("\n");
    assert.doesNotMatch(stylesheets, /\.\.https:\/\//);
    assert.match(
      stylesheets,
      /url\(https:\/\/miaobi\.invalid\/__ASSET_BASE__\/fonts\/AlibabaPuHuiTi-3-55-Regular\.ttf\)/,
    );
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
    assert.doesNotMatch(javascript, /["'`]\/(?:avatar\.png|features\/|fonts\/|icon\.png|logo\.svg|template-snapshots\/|web-shot\.png)/);
    assert.match(javascript, /https:\/\/miaobi\.invalid\/__ASSET_BASE__\/template-snapshots\/zh\/classic\.png/);
    assert.match(javascript, /platform\s*===\s*["']miaobi["']/);
    assert.match(javascript, /createHashHistory|hashchange/);
    assert.equal(await snapshotPath(join(dirname(outputDirectory), "server")), "<missing>");
  } finally {
    const after = await Promise.all(protectedPaths.map(snapshotPath));
    assert.deepEqual(after, before);
    await rm(directory, { recursive: true, force: true });
  }
});

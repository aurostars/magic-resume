import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { build, resolveConfig } from "vite";

async function javascriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return /\.(?:js|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

test("Miaobi dynamic CSS preloads resolve relative to the immutable asset directory", async () => {
  const projectRoot = process.cwd();
  const config = await resolveConfig({
    configFile: resolve(projectRoot, "vite.miaobi.config.ts"),
    logLevel: "silent",
  }, "build");
  assert.equal(config.base, "./");

  const fixtureRoot = await realpath(
    await mkdtemp(join(tmpdir(), "miaobi-relative-preload-")),
  );
  const outputDirectory = join(fixtureRoot, "dist");

  try {
    await writeFile(
      join(fixtureRoot, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    await writeFile(
      join(fixtureRoot, "main.js"),
      'globalThis.loadLazy = () => import("./lazy.js");',
    );
    await writeFile(
      join(fixtureRoot, "lazy.js"),
      'import "./lazy.css"; export const loaded = true;',
    );
    await writeFile(join(fixtureRoot, "lazy.css"), ".lazy { color: green; }");

    await build({
      root: fixtureRoot,
      configFile: false,
      base: config.base,
      logLevel: "silent",
      build: {
        outDir: outputDirectory,
        emptyOutDir: true,
        rollupOptions: {
          output: {
            entryFileNames: "assets/[name].js",
            chunkFileNames: "assets/[name].js",
            assetFileNames: "assets/[name][extname]",
          },
        },
      },
    });

    const bundles = await Promise.all(
      (await javascriptFiles(outputDirectory)).map(async (path) => ({
        path,
        source: await readFile(path, "utf8"),
      })),
    );
    const preloadBundle = bundles.find(({ source }) =>
      source.includes("Unable to preload CSS for") && source.includes("lazy.css"),
    );

    assert.ok(preloadBundle, "fixture output must include the lazy CSS preload");
    assert.doesNotMatch(
      preloadBundle.source,
      /["']modulepreload["'],[\w$]+=function\(([\w$]+)\)\{return["']\/["']\+\1\}/,
      "Vite preload helper must not resolve dynamic dependencies from the page root",
    );

    const cssReference = /["'](\.\/lazy\.css)["']/.exec(preloadBundle.source)?.[1];
    assert.equal(cssReference, "./lazy.css");
    const importingBundlePath = relative(outputDirectory, preloadBundle.path).split(sep).join("/");
    const importingBundleUrl = `https://aurostars.github.io/magic-resume/objects/immutable-graph/${importingBundlePath}`;
    const resolvedCssUrl = new URL(cssReference, importingBundleUrl);
    assert.equal(
      resolvedCssUrl.href,
      "https://aurostars.github.io/magic-resume/objects/immutable-graph/assets/lazy.css",
    );
    await access(resolve(dirname(preloadBundle.path), cssReference));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

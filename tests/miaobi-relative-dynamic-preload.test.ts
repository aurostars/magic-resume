import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMiaobiSpa } from "../scripts/miaobi/build-spa";

const ASSET_BASE_PLACEHOLDER = "https://miaobi.invalid/__ASSET_BASE__/";

async function javascriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return /\.(?:js|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

test("Miaobi dynamic CSS preloads resolve relative to the immutable asset directory", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "miaobi-relative-preload-"));
  const outputDirectory = join(directory, "client");

  try {
    await buildMiaobiSpa({
      outputDirectory,
      assetBasePlaceholder: ASSET_BASE_PLACEHOLDER,
    });

    const bundles = await Promise.all(
      (await javascriptFiles(outputDirectory)).map((path) => readFile(path, "utf8")),
    );
    const preloadBundle = bundles.find((bundle) =>
      bundle.includes("Unable to preload CSS for") && /mermaid-[\w-]+\.css/.test(bundle),
    );

    assert.ok(preloadBundle, "production output must include the workbench Mermaid CSS preload");
    assert.doesNotMatch(
      preloadBundle,
      /["']modulepreload["'],[\w$]+=function\(([\w$]+)\)\{return["']\/["']\+\1\}/,
      "Vite preload helper must not resolve dynamic dependencies from /assets/ at the page origin",
    );
    const mermaidCssReference = /["'](\.\/mermaid-[\w-]+\.css)["']/.exec(preloadBundle)?.[1];
    assert.ok(mermaidCssReference, "Mermaid CSS preload must be relative to its importing asset");
    assert.equal(
      new URL(
        mermaidCssReference,
        "https://aurostars.github.io/magic-resume/objects/immutable-graph/assets/main.js",
      ).href,
      `https://aurostars.github.io/magic-resume/objects/immutable-graph/assets/${mermaidCssReference.slice(2)}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

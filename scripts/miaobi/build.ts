import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import config from "../../miaobi.config.json" with { type: "json" };
import { MIAOBI_ASSET_BASE_PLACEHOLDER } from "../../vite.miaobi.config";
import { injectMiaobiRuntime } from "../../miaobi/runtime-config";
import { buildApiFaas, type FaaSBuildResult } from "./build-faas";
import { buildMiaobiSpa } from "./build-spa";
import { buildWebFaas } from "./build-web-faas";

export async function buildMiaobiArtifacts(options: {
  outputDirectory: string;
  assetBasePlaceholder: string;
}): Promise<FaaSBuildResult & { shellPath: string; assetDirectory: string }> {
  const { shellPath, assetDirectory } = await buildMiaobiSpa({
    outputDirectory: resolve(options.outputDirectory, "client"),
    assetBasePlaceholder: options.assetBasePlaceholder,
  });
  const apiBundlePath = await buildApiFaas(resolve(options.outputDirectory));
  const placeholderShell = injectMiaobiRuntime(
    await readFile(shellPath, "utf8"),
    {
      platform: "miaobi",
      apiFunctionUrl: "https://magic.solutionsuite.cn/api/faas/build-only",
      assetBaseUrl: options.assetBasePlaceholder,
    },
  );
  const webBundlePath = await buildWebFaas(placeholderShell, resolve(options.outputDirectory));
  const platformOrigin = "https://magic.solutionsuite.cn";
  const pageUrl = `${platformOrigin}/html-box/${config.pageId}`;
  await writeFile(
    resolve(options.outputDirectory, "page.html"),
    `<!doctype html><meta charset="utf-8"><a href="${pageUrl}">打开魔方简历</a>`,
    "utf8",
  );
  await writeFile(
    resolve(options.outputDirectory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      platformOrigin,
      pageUrl,
      artifacts: {
        apiFaas: "api-faas.cjs",
        apiMetadata: "api-faas.meta.json",
        client: "client",
        page: "page.html",
        webFaas: "web-faas.cjs",
      },
    }, null, 2)}\n`,
    "utf8",
  );
  return { apiBundlePath, webBundlePath, shellPath, assetDirectory };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  void buildMiaobiArtifacts({
    outputDirectory: "dist/miaobi",
    assetBasePlaceholder: MIAOBI_ASSET_BASE_PLACEHOLDER,
  }).catch((error: unknown) => {
    console.error((error as { code?: string }).code ?? "MIAOBI_BUILD_FAILED");
    process.exitCode = 1;
  });
}

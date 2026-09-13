import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    await (await import("node:fs/promises")).readFile(shellPath, "utf8"),
    {
      platform: "miaobi",
      apiFunctionUrl: "https://miaobi.invalid/__API_FAAS__/",
      assetBaseUrl: options.assetBasePlaceholder,
    },
  );
  const webBundlePath = await buildWebFaas(placeholderShell, resolve(options.outputDirectory));
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

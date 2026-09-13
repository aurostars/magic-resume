import { join } from "node:path";
import { build } from "esbuild";

export interface FaaSBuildResult {
  apiBundlePath: string;
  webBundlePath: string | null;
}

function isDisallowedBareImport(path: string) {
  return !path.startsWith("node:") &&
    !path.startsWith(".") &&
    !path.startsWith("/") &&
    !URL.canParse(path);
}

export async function buildApiFaas(outputDirectory: string): Promise<string> {
  const apiBundlePath = join(outputDirectory, "api-faas.cjs");
  const result = await build({
    entryPoints: ["miaobi/api-entry.ts"],
    outfile: apiBundlePath,
    bundle: true,
    platform: "node",
    format: "iife",
    target: "node20",
    globalName: "MagicResumeApi",
    footer: { js: "module.exports = MagicResumeApi.handleMiaobiApi" },
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
  });

  const bareImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .map((entry) => entry.path)
    .filter(isDisallowedBareImport);
  if (bareImports.length > 0) {
    throw new Error(`FaaS bundle contains bare imports: ${[...new Set(bareImports)].join(", ")}`);
  }

  return apiBundlePath;
}

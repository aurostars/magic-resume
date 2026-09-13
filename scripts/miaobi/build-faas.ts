import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

export interface FaaSBuildResult {
  apiBundlePath: string;
  webBundlePath: string | null;
}

export interface ApiFaasBuildOptions {
  buildMarker?: string;
}

export interface ApiFaasMetadata {
  schemaVersion: 1;
  buildMarker: string;
  bundleSha256: string;
}

function isDisallowedBareImport(path: string) {
  return !path.startsWith("node:") &&
    !path.startsWith(".") &&
    !path.startsWith("/") &&
    !URL.canParse(path);
}

function validatedBuildMarker(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("MIAOBI_BUILD_MARKER_INVALID");
  }
  return value;
}

async function defaultBuildMarker(): Promise<string> {
  if (process.env.MIAOBI_GIT_COMMIT) return process.env.MIAOBI_GIT_COMMIT;
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  return stdout.trim();
}

export async function buildApiFaas(
  outputDirectory: string,
  options: ApiFaasBuildOptions = {},
): Promise<string> {
  const buildMarker = validatedBuildMarker(
    options.buildMarker ?? await defaultBuildMarker(),
  );
  await mkdir(outputDirectory, { recursive: true });
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
    define: {
      "process.env.NODE_ENV": '"production"',
      __MIAOBI_API_BUILD_MARKER__: JSON.stringify(buildMarker),
    },
    metafile: true,
  });

  const bareImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .map((entry) => entry.path)
    .filter(isDisallowedBareImport);
  if (bareImports.length > 0) {
    throw new Error(`FaaS bundle contains bare imports: ${[...new Set(bareImports)].join(", ")}`);
  }

  const metadata: ApiFaasMetadata = {
    schemaVersion: 1,
    buildMarker,
    bundleSha256: createHash("sha256").update(await readFile(apiBundlePath)).digest("hex"),
  };
  await writeFile(join(outputDirectory, "api-faas.meta.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return apiBundlePath;
}

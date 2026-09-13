import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

export interface FaaSBuildResult {
  apiBundlePath: string;
  webBundlePath: string | null;
}

export interface ApiFaasBuildOptions {
  gitCommit?: string;
  nonce?: string;
}

export interface ApiFaasMetadata {
  schemaVersion: 1;
  gitCommit: string;
  buildMarker: string;
  bundleSha256: string;
}

function isDisallowedBareImport(path: string) {
  return !path.startsWith("node:") &&
    !path.startsWith(".") &&
    !path.startsWith("/") &&
    !URL.canParse(path);
}

function validatedGitCommit(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("MIAOBI_GIT_COMMIT_INVALID");
  return value;
}

function validatedNonce(value: string): string {
  if (!/^[0-9a-f]{32,128}$/.test(value)) throw new Error("MIAOBI_BUILD_NONCE_INVALID");
  return value;
}

async function defaultGitCommit(): Promise<string> {
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
  const gitCommit = validatedGitCommit(options.gitCommit ?? await defaultGitCommit());
  const nonce = validatedNonce(options.nonce ?? randomBytes(32).toString("hex"));
  const buildMarker = `${gitCommit}.${nonce}`;
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
    gitCommit,
    buildMarker,
    bundleSha256: createHash("sha256").update(await readFile(apiBundlePath)).digest("hex"),
  };
  await writeFile(join(outputDirectory, "api-faas.meta.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return apiBundlePath;
}

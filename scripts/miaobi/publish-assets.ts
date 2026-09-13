import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { contentTypeFor, isRewritableTextAsset } from "./content-types";
import {
  MagicBuilderError,
  runMagicBuilderJson,
} from "./magic-builder";
import type {
  MagicBuilderRunner,
  MiaobiAssetManifest,
  MiaobiAssetRecord,
} from "./types";

const PLACEHOLDER = "https://miaobi.invalid/__ASSET_BASE__/";
const RELEASE_ID_PATTERN = /^[0-9a-f]{12}-\d{14}$/;
const RELEASE_PREFIX = "magic-resume/releases";

export function createReleaseId(commit: string, now = new Date()): string {
  if (!/^[0-9a-f]{12,}$/i.test(commit) || Number.isNaN(now.getTime())) {
    const error = new Error("MIAOBI_INVALID_RELEASE") as Error & { code: string };
    error.code = "MIAOBI_INVALID_RELEASE";
    throw error;
  }
  const timestamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${commit.slice(0, 12).toLowerCase()}-${timestamp}`;
}

class InvalidPathError extends Error {
  readonly code = "MIAOBI_INVALID_PATH";

  constructor() {
    super("MIAOBI_INVALID_PATH");
    this.name = "InvalidPathError";
  }
}

type SourceAsset = {
  relativePath: string;
  sourcePath: string;
  contentType: string;
};

type FinalAsset = SourceAsset & {
  content: Buffer;
  contentHash: string;
};

function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((segment) => segment.startsWith(".")) ||
    relativePath.endsWith(".map") ||
    segments.includes("server") ||
    segments.some((segment) => /(?:^|[.-])server(?:[.-]|$)/i.test(segment));
}

async function collectAssets(directory: string): Promise<SourceAsset[]> {
  if ((await lstat(directory)).isSymbolicLink()) throw new InvalidPathError();
  const root = await realpath(directory);
  const assets: SourceAsset[] = [];

  async function visit(currentDirectory: string, prefix: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (shouldExclude(relativePath)) continue;
      const entryPath = join(currentDirectory, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new InvalidPathError();
      } else if (metadata.isDirectory()) {
        await visit(entryPath, relativePath);
      } else if (metadata.isFile()) {
        const contentType = contentTypeFor(relativePath);
        if (contentType) assets.push({ relativePath, sourcePath: entryPath, contentType });
      }
    }
  }

  await visit(root, "");
  return assets;
}

function parseHttpsUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  return parsed;
}

function deriveReleaseBaseUrl(markerUrl: string, markerKey: string): string {
  const parsed = parseHttpsUrl(markerUrl);
  if (!parsed.pathname.endsWith(`/${markerKey}`)) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  return new URL(".", parsed).toString();
}

async function upload(
  runner: MagicBuilderRunner,
  filePath: string,
  key: string,
  contentType: string,
): Promise<{ id: string; url: string }> {
  return runMagicBuilderJson(runner, [
    "tos",
    "upload",
    "--file",
    filePath,
    "--key",
    key,
    "--content-type",
    contentType,
    "--json",
  ]);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function publishAssets(input: {
  directory: string;
  releaseId: string;
  runner: MagicBuilderRunner;
}): Promise<MiaobiAssetManifest> {
  if (!RELEASE_ID_PATTERN.test(input.releaseId)) throw new InvalidPathError();

  const assets = await collectAssets(input.directory);
  const workingDirectory = await mkdtemp(join(tmpdir(), "miaobi-publish-"));
  const releasePrefix = `${RELEASE_PREFIX}/${input.releaseId}`;
  const markerKey = `${releasePrefix}/release.json`;
  const manifestPath = resolve(input.directory, "..", "asset-manifest.json");

  try {
    const markerPath = join(workingDirectory, "release.json");
    await writeFile(
      markerPath,
      `${JSON.stringify({ releaseId: input.releaseId })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const marker = await upload(
      input.runner,
      markerPath,
      markerKey,
      "application/json; charset=utf-8",
    );
    const baseUrl = deriveReleaseBaseUrl(marker.url, markerKey);

    const finalAssets: FinalAsset[] = [];
    for (const asset of assets) {
      const source = await readFile(asset.sourcePath);
      const content = isRewritableTextAsset(asset.relativePath)
        ? Buffer.from(source.toString("utf8").replaceAll(PLACEHOLDER, baseUrl), "utf8")
        : source;
      finalAssets.push({
        ...asset,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
      });
    }

    const records: Record<string, MiaobiAssetRecord> = {};
    const uploaded = new Map<string, { key: string; url: string }>();
    for (const asset of finalAssets) {
      const duplicateKey = `${asset.contentType}\0${asset.contentHash}`;
      let destination = uploaded.get(duplicateKey);
      if (!destination) {
        const key = `${releasePrefix}/${asset.relativePath}`;
        const stagedPath = join(workingDirectory, `${randomUUID()}.asset`);
        await writeFile(stagedPath, asset.content, { mode: 0o600 });
        let response: { id: string; url: string };
        try {
          response = await upload(
            input.runner,
            stagedPath,
            key,
            asset.contentType,
          );
        } catch (error) {
          if (error instanceof MagicBuilderError) throw error;
          throw new MagicBuilderError("MIAOBI_CLI_FAILED");
        }
        parseHttpsUrl(response.url);
        destination = { key, url: response.url };
        uploaded.set(duplicateKey, destination);
      }
      records[asset.relativePath] = {
        relativePath: asset.relativePath,
        contentHash: asset.contentHash,
        contentType: asset.contentType,
        key: destination.key,
        url: destination.url,
      };
    }

    const manifest: MiaobiAssetManifest = {
      schemaVersion: 1,
      releaseId: input.releaseId,
      createdAt: new Date().toISOString(),
      baseUrl,
      files: records,
    };
    await writeJsonAtomically(manifestPath, manifest);
    return manifest;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

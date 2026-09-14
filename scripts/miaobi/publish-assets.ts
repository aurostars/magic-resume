import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
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
  sourceDevice: number;
  sourceInode: number;
  contentType: string;
};

type DirectoryIdentity = {
  path: string;
  device: number;
  inode: number;
};

type FinalAsset = {
  relativePath: string;
  contentType: string;
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

async function rejectSymlinkPathComponents(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components = relative(root, absolutePath).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new InvalidPathError();
  }
}

async function collectAssets(directory: string): Promise<{
  assets: SourceAsset[];
  directories: DirectoryIdentity[];
  root: string;
}> {
  const requestedRoot = resolve(directory);
  await rejectSymlinkPathComponents(requestedRoot);
  const root = await realpath(requestedRoot);
  if (root !== requestedRoot) throw new InvalidPathError();
  const assets: SourceAsset[] = [];
  const directories: DirectoryIdentity[] = [];

  async function visit(currentDirectory: string, prefix: string): Promise<void> {
    const directoryMetadata = await lstat(currentDirectory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new InvalidPathError();
    }
    directories.push({
      path: currentDirectory,
      device: directoryMetadata.dev,
      inode: directoryMetadata.ino,
    });
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
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
        if (contentType) {
          assets.push({
            relativePath,
            sourcePath: entryPath,
            sourceDevice: metadata.dev,
            sourceInode: metadata.ino,
            contentType,
          });
        }
      }
    }
  }

  await visit(root, "");
  return { assets, directories, root };
}

async function readTrustedAsset(asset: SourceAsset): Promise<Buffer> {
  let handle;
  try {
    handle = await open(asset.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== asset.sourceDevice ||
      metadata.ino !== asset.sourceInode
    ) {
      throw new InvalidPathError();
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof InvalidPathError) throw error;
    throw new InvalidPathError();
  } finally {
    await handle?.close();
  }
}

async function snapshotAssets(directory: string): Promise<{
  assets: FinalAsset[];
  root: string;
}> {
  const collected = await collectAssets(directory);
  const snapshots: FinalAsset[] = [];
  for (const asset of collected.assets) {
    snapshots.push({
      relativePath: asset.relativePath,
      contentType: asset.contentType,
      content: await readTrustedAsset(asset),
      contentHash: "",
    });
  }
  for (const directoryIdentity of collected.directories) {
    const metadata = await lstat(directoryIdentity.path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.dev !== directoryIdentity.device ||
      metadata.ino !== directoryIdentity.inode
    ) {
      throw new InvalidPathError();
    }
  }
  return { assets: snapshots, root: collected.root };
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

function validateUploadedUrl(
  value: string,
  key: string,
  expectedOrigin?: string,
): URL {
  const parsed = parseHttpsUrl(value);
  const expectedPath = new URL(`/${key}`, parsed.origin).pathname;
  if (
    parsed.pathname !== expectedPath ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (expectedOrigin !== undefined && parsed.origin !== expectedOrigin)
  ) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  return parsed;
}

function deriveReleaseBaseUrl(markerUrl: string, markerKey: string): string {
  return new URL(".", validateUploadedUrl(markerUrl, markerKey)).toString();
}

async function upload(
  runner: MagicBuilderRunner,
  filePath: string,
  key: string,
  contentType: string,
): Promise<{ id: string; url: string }> {
  return runMagicBuilderJson(runner, [
    "file",
    "upload",
    filePath,
    "--key",
    key,
    "--content-type",
    contentType,
    "--format",
    "json",
    "--quiet",
  ]);
}

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

type ReleaseStatus = "reserved" | "manifest-staged" | "manifest-ready";

type ReleaseReservation = {
  ownerToken: string;
  path: string;
  manifests: DirectoryIdentity;
  reservations: DirectoryIdentity;
  stateDirectory: DirectoryIdentity;
};

async function assertDirectoryIdentity(directory: DirectoryIdentity): Promise<void> {
  const metadata = await lstat(directory.path);
  if (
    metadata.isSymbolicLink() || !metadata.isDirectory() ||
    metadata.dev !== directory.device || metadata.ino !== directory.inode
  ) throw new InvalidPathError();
}

async function syncDirectory(directory: DirectoryIdentity): Promise<void> {
  let handle;
  try {
    await assertDirectoryIdentity(directory);
    handle = await open(directory.path, constants.O_RDONLY);
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() || metadata.dev !== directory.device ||
      metadata.ino !== directory.inode
    ) throw new Error();
    await handle.sync();
    await assertDirectoryIdentity(directory);
  } catch {
    throw codedError("MIAOBI_DURABILITY_UNSUPPORTED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function updateReleaseState(
  stateDirectory: DirectoryIdentity,
  releaseId: string,
  ownerToken: string,
  status?: ReleaseStatus,
): Promise<void> {
  const lockPath = join(stateDirectory.path, "state.lock");
  try {
    await mkdir(lockPath, { mode: 0o700 });
    await syncDirectory(stateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw codedError("MIAOBI_STATE_LOCKED");
    }
    throw error;
  }

  try {
    const statePath = join(stateDirectory.path, "state.json");
    let state: {
      schemaVersion: 1;
      releases: Record<string, { ownerToken: string; status: ReleaseStatus }>;
    } = { schemaVersion: 1, releases: {} };
    try {
      state = JSON.parse(await readFile(statePath, "utf8")) as typeof state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const current = state.releases[releaseId];
    if (current && current.ownerToken !== ownerToken) {
      throw codedError("MIAOBI_RELEASE_RESERVED");
    }
    if (status) state.releases[releaseId] = { ownerToken, status };
    else delete state.releases[releaseId];
    await writeJsonAtomically(statePath, state, stateDirectory);
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("MIAOBI_")) throw error;
    throw codedError("MIAOBI_STATE_FAILED");
  } finally {
    await rm(lockPath, { recursive: true, force: true });
    await syncDirectory(stateDirectory);
  }
}

async function ensureLocalDirectory(path: string): Promise<DirectoryIdentity> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new InvalidPathError();
  }
  return { path, device: metadata.dev, inode: metadata.ino };
}

async function reserveRelease(
  trustedRoot: string,
  releaseId: string,
): Promise<ReleaseReservation> {
  const stateDirectory = await ensureLocalDirectory(resolve(trustedRoot, "../../..", ".miaobi"));
  const manifests = await ensureLocalDirectory(join(stateDirectory.path, "manifests"));
  const reservations = await ensureLocalDirectory(join(stateDirectory.path, "reservations"));
  await syncDirectory(stateDirectory);
  await syncDirectory(manifests);
  await syncDirectory(reservations);

  const ownerToken = randomUUID().replaceAll("-", "");
  const reservationPath = join(reservations.path, `${releaseId}.json`);
  const temporaryPath = join(reservations.path, `.${releaseId}.${ownerToken}.tmp`);
  let handle;
  let linked = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, releaseId, ownerToken })}\n`, "utf8");
    await handle.sync();
    const staged = await handle.stat();
    await handle.close();
    handle = undefined;
    await assertDirectoryIdentity(reservations);
    try {
      await link(temporaryPath, reservationPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw codedError("MIAOBI_RELEASE_RESERVED");
      }
      throw error;
    }
    await syncDirectory(reservations);
    const committed = await lstat(reservationPath);
    if (
      !committed.isFile() || committed.isSymbolicLink() ||
      committed.dev !== staged.dev || committed.ino !== staged.ino
    ) throw new InvalidPathError();
    await updateReleaseState(stateDirectory, releaseId, ownerToken, "reserved");
    return { ownerToken, path: reservationPath, manifests, reservations, stateDirectory };
  } catch (error) {
    if (linked) {
      await rm(reservationPath, { force: true }).catch(() => undefined);
      await syncDirectory(reservations).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function releaseReservation(
  reservation: ReleaseReservation,
  releaseId: string,
): Promise<void> {
  try {
    const value = JSON.parse(await readFile(reservation.path, "utf8")) as {
      releaseId?: unknown;
      ownerToken?: unknown;
    };
    if (value.releaseId !== releaseId || value.ownerToken !== reservation.ownerToken) {
      throw codedError("MIAOBI_STATE_FAILED");
    }
    await rm(reservation.path);
    await syncDirectory(reservation.reservations);
    await updateReleaseState(
      reservation.stateDirectory,
      releaseId,
      reservation.ownerToken,
      undefined,
    );
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("MIAOBI_")) throw error;
    throw codedError("MIAOBI_STATE_FAILED");
  }
}

async function stageJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporaryPath;
}

async function commitImmutableManifest(
  reservation: ReleaseReservation,
  releaseId: string,
  manifest: MiaobiAssetManifest,
): Promise<void> {
  const targetPath = join(
    reservation.manifests.path,
    `${releaseId}-${reservation.ownerToken}.json`,
  );
  const temporaryPath = await stageJson(
    join(reservation.manifests.path, `.${releaseId}-${reservation.ownerToken}.tmp`),
    manifest,
  );
  try {
    await assertDirectoryIdentity(reservation.manifests);
    await link(temporaryPath, targetPath);
    await syncDirectory(reservation.manifests);
    const [staged, committed] = await Promise.all([
      lstat(temporaryPath),
      lstat(targetPath),
    ]);
    if (
      !committed.isFile() || committed.isSymbolicLink() ||
      committed.dev !== staged.dev || committed.ino !== staged.ino
    ) throw codedError("MIAOBI_STATE_FAILED");
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("MIAOBI_")) throw error;
    throw codedError("MIAOBI_STATE_FAILED");
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
  parent?: DirectoryIdentity,
): Promise<void> {
  const temporaryPath = await stageJson(path, value);
  try {
    await rename(temporaryPath, path);
    if (parent) await syncDirectory(parent);
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

  const snapshot = await snapshotAssets(input.directory);
  const assets = snapshot.assets;
  const manifestPath = resolve(snapshot.root, "..", "asset-manifest.json");
  const manifestDirectory = await ensureLocalDirectory(dirname(manifestPath));
  await syncDirectory(manifestDirectory);
  const reservation = await reserveRelease(snapshot.root, input.releaseId);
  const workingDirectory = await mkdtemp(join(tmpdir(), "miaobi-publish-"));
  const releasePrefix = `${RELEASE_PREFIX}/${input.releaseId}`;
  const markerKey = `${releasePrefix}/release.json`;
  let manifestStaged = false;

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
      const content = isRewritableTextAsset(asset.relativePath)
        ? Buffer.from(asset.content.toString("utf8").replaceAll(PLACEHOLDER, baseUrl), "utf8")
        : asset.content;
      finalAssets.push({
        relativePath: asset.relativePath,
        contentType: asset.contentType,
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
        validateUploadedUrl(response.url, key, new URL(baseUrl).origin);
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
    const stagedManifestPath = await stageJson(manifestPath, manifest);
    try {
      await updateReleaseState(
        reservation.stateDirectory,
        input.releaseId,
        reservation.ownerToken,
        "manifest-staged",
      );
      manifestStaged = true;
      await commitImmutableManifest(reservation, input.releaseId, manifest);
      await rename(stagedManifestPath, manifestPath);
      await syncDirectory(manifestDirectory);
    } catch (error) {
      await rm(stagedManifestPath, { force: true }).catch(() => undefined);
      throw error;
    }
    // The durable manifest rename is authoritative. State is only a recovery hint,
    // so failed best-effort promotion must not turn a committed release into failure.
    await updateReleaseState(
      reservation.stateDirectory,
      input.releaseId,
      reservation.ownerToken,
      "manifest-ready",
    ).catch(() => undefined);
    return manifest;
  } catch (error) {
    if (!manifestStaged) await releaseReservation(reservation, input.releaseId);
    throw error;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

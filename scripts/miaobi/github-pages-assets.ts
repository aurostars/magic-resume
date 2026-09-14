import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { contentTypeFor, isRewritableTextAsset } from "./content-types";
import type {
  GitHubPagesAssetRecord,
  GitHubPagesManifest,
} from "./types";

const PLACEHOLDER = "https://miaobi.invalid/__ASSET_BASE__/";
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_ID_PATTERN = /^[0-9a-f]{12}-\d{14}$/;
const UNSAFE_TEXT = [
  /\/Users\//,
  /\/workspace\//,
  /file:\/\//i,
  /sourceMappingURL/i,
  /KNOWN_TEST_SECRET/i,
  /do-not-leak/i,
];
const FORBIDDEN_DATA_NAMES = new Set([
  "credentials.json",
  "webdav-credentials.json",
  "resume.json",
  "local-state.json",
  "session.json",
]);
const FORBIDDEN_ASSET_HOSTS = [
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "jsdelivr.net",
  "workers.dev",
  "pages.dev",
  "cloudflareworkers.com",
];

const LOCK_LEASE_MS = 60_000;
const LOCK_RETRY_MS = 10;

class MaterializationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MaterializationError";
    this.code = code;
  }
}

type DirectoryIdentity = {
  path: string;
  device: number;
  inode: number;
};

type SourceAsset = {
  relativePath: string;
  sourcePath: string;
  sourceDevice: number;
  sourceInode: number;
  sourceSize: number;
  sourceMtimeMs: number;
  sourceCtimeMs: number;
  contentType: string;
};

type SnapshotAsset = {
  relativePath: string;
  contentType: string;
  content: Buffer;
};

type FinalAsset = SnapshotAsset & {
  contentHash: string;
};

function invalidPath(): never {
  throw new MaterializationError("MIAOBI_INVALID_PATH");
}

function shouldExclude(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((segment) => segment.startsWith(".")) ||
    relativePath.endsWith(".map") ||
    segments.some((segment) => /^(?:server|tests?|__tests__)$/i.test(segment)) ||
    segments.some((segment) => /(?:^|[.-])(?:server|test|spec)(?:[.-]|$)/i.test(segment));
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeEscapedUrls(text: string): string {
  return text
    .replace(/\\u002f/gi, "/")
    .replace(/\\x2f/gi, "/")
    .replace(/\\\//g, "/");
}

function hasForbiddenAssetUrl(text: string): boolean {
  const normalized = normalizeEscapedUrls(text);
  const candidates = normalized.match(/(?:https?:)?\/\/[^\s"'`<>\\]+/gi) ?? [];
  return candidates.some((candidate) => {
    try {
      const parsed = new URL(candidate.startsWith("//") ? `https:${candidate}` : candidate);
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      return FORBIDDEN_ASSET_HOSTS.some((forbidden) =>
        hostname === forbidden || hostname.endsWith(`.${forbidden}`)
      ) || hostname.split(".").some((label) => label === "tos" || label.startsWith("tos-"));
    } catch {
      return true;
    }
  });
}

async function rejectSymlinkPathComponents(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components = relative(root, absolutePath).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) invalidPath();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function collectAssets(clientDirectory: string): Promise<{
  assets: SourceAsset[];
  directories: DirectoryIdentity[];
}> {
  const requestedRoot = resolve(clientDirectory);
  await rejectSymlinkPathComponents(requestedRoot);
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch {
    invalidPath();
  }
  if (root !== requestedRoot) invalidPath();

  const assets: SourceAsset[] = [];
  const directories: DirectoryIdentity[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidPath();
    directories.push({ path: directory, device: metadata.dev, inode: metadata.ino });

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const sourcePath = join(directory, entry.name);
      const entryMetadata = await lstat(sourcePath);
      if (entryMetadata.isSymbolicLink()) invalidPath();
      if (entryMetadata.isFile() && FORBIDDEN_DATA_NAMES.has(entry.name.toLowerCase())) {
        throw new MaterializationError("MIAOBI_UNSAFE_ASSET");
      }
      if (shouldExclude(relativePath)) continue;
      if (entryMetadata.isDirectory()) {
        await visit(sourcePath, relativePath);
      } else if (entryMetadata.isFile()) {
        const contentType = contentTypeFor(relativePath);
        if (contentType) {
          assets.push({
            relativePath,
            sourcePath,
            sourceDevice: entryMetadata.dev,
            sourceInode: entryMetadata.ino,
            sourceSize: entryMetadata.size,
            sourceMtimeMs: entryMetadata.mtimeMs,
            sourceCtimeMs: entryMetadata.ctimeMs,
            contentType,
          });
        }
      }
    }
  }
  await visit(root, "");
  assets.sort((left, right) => compareNames(left.relativePath, right.relativePath));
  return { assets, directories };
}

async function readTrustedAsset(asset: SourceAsset): Promise<Buffer> {
  let handle;
  try {
    handle = await open(asset.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile() || before.dev !== asset.sourceDevice ||
      before.ino !== asset.sourceInode || before.size !== asset.sourceSize ||
      before.mtimeMs !== asset.sourceMtimeMs || before.ctimeMs !== asset.sourceCtimeMs
    ) invalidPath();
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) invalidPath();
    return content;
  } catch (error) {
    if (error instanceof MaterializationError) throw error;
    invalidPath();
  } finally {
    await handle?.close();
  }
}

async function snapshotAssets(clientDirectory: string): Promise<SnapshotAsset[]> {
  const collected = await collectAssets(clientDirectory);
  const snapshots: SnapshotAsset[] = [];
  for (const asset of collected.assets) {
    snapshots.push({
      relativePath: asset.relativePath,
      contentType: asset.contentType,
      content: await readTrustedAsset(asset),
    });
  }
  for (const directory of collected.directories) {
    const metadata = await lstat(directory.path);
    if (
      !metadata.isDirectory() || metadata.isSymbolicLink() ||
      metadata.dev !== directory.device || metadata.ino !== directory.inode
    ) invalidPath();
  }
  return snapshots;
}

function graphHashFor(assets: SnapshotAsset[]): string {
  const hash = createHash("sha256");
  for (const asset of assets) {
    const pathBytes = Buffer.from(asset.relativePath, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(pathBytes.length));
    hash.update(length).update(pathBytes);
    length.writeBigUInt64BE(BigInt(asset.content.length));
    hash.update(length).update(asset.content);
  }
  return hash.digest("hex");
}

function finalizeAssets(assets: SnapshotAsset[], assetRoot: string): FinalAsset[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return assets.map((asset) => {
    let content = asset.content;
    if (isRewritableTextAsset(asset.relativePath)) {
      let text: string;
      try {
        text = decoder.decode(content);
      } catch {
        throw new MaterializationError("MIAOBI_UNSAFE_ASSET");
      }
      text = text.split(PLACEHOLDER).join(assetRoot);
      if (
        text.includes(PLACEHOLDER) || hasForbiddenAssetUrl(text) ||
        UNSAFE_TEXT.some((pattern) => pattern.test(text))
      ) {
        throw new MaterializationError("MIAOBI_UNSAFE_ASSET");
      }
      content = Buffer.from(text, "utf8");
    }
    return {
      ...asset,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  });
}

async function ensureDirectory(path: string): Promise<void> {
  await rejectSymlinkPathComponents(dirname(path));
  await mkdir(path, { recursive: true, mode: 0o755 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidPath();
}

async function sameBytes(path: string, expected: Buffer): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return false;
    const content = await handle.readFile();
    const after = await handle.stat();
    return before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs && content.equals(expected);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function publishImmutableObject(
  pagesDirectory: string,
  objectPath: string,
  content: Buffer,
): Promise<boolean> {
  const targetPath = join(pagesDirectory, objectPath);
  await ensureDirectory(dirname(targetPath));
  const temporaryPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!await sameBytes(targetPath, content)) {
        throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
      }
      return false;
    }
  } catch (error) {
    if (error instanceof MaterializationError) throw error;
    throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function publishImmutableAlias(
  pagesDirectory: string,
  sourceObjectPath: string,
  objectPath: string,
  content: Buffer,
): Promise<boolean> {
  const targetPath = join(pagesDirectory, objectPath);
  await ensureDirectory(dirname(targetPath));
  try {
    await link(join(pagesDirectory, sourceObjectPath), targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!await sameBytes(targetPath, content)) {
      throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
    }
    return false;
  }
}

async function directoryChain(root: string, targetDirectory: string): Promise<DirectoryIdentity[]> {
  const identities: DirectoryIdentity[] = [];
  let current = root;
  const rootMetadata = await lstat(current);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) invalidPath();
  identities.push({ path: current, device: rootMetadata.dev, inode: rootMetadata.ino });
  for (const component of relative(root, targetDirectory).split(sep).filter(Boolean)) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidPath();
    identities.push({ path: current, device: metadata.dev, inode: metadata.ino });
  }
  return identities;
}

async function assertImmutableObject(
  pagesDirectory: string,
  objectPath: string,
  content: Buffer,
): Promise<void> {
  const targetPath = join(pagesDirectory, objectPath);
  const ancestors = await directoryChain(pagesDirectory, dirname(targetPath));
  let handle;
  try {
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const pathBefore = await lstat(targetPath);
    if (
      !before.isFile() || pathBefore.isSymbolicLink() || before.nlink < 1 ||
      before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
    ) throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
    const actual = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(targetPath);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || !actual.equals(content)
    ) throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
    for (const ancestor of ancestors) {
      const metadata = await lstat(ancestor.path);
      if (
        !metadata.isDirectory() || metadata.isSymbolicLink() ||
        metadata.dev !== ancestor.device || metadata.ino !== ancestor.inode
      ) throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
    }
  } catch (error) {
    if (error instanceof MaterializationError) throw error;
    throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertImmutableObjectSync(
  pagesDirectory: string,
  objectPath: string,
  content: Buffer,
): void {
  const targetPath = join(pagesDirectory, objectPath);
  const ancestors: DirectoryIdentity[] = [];
  let current = pagesDirectory;
  for (const component of relative(pagesDirectory, dirname(targetPath)).split(sep).filter(Boolean)) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
    }
    ancestors.push({ path: current, device: metadata.dev, inode: metadata.ino });
    current = join(current, component);
  }
  const finalDirectory = lstatSync(current);
  ancestors.push({ path: current, device: finalDirectory.dev, inode: finalDirectory.ino });

  let descriptor: number | undefined;
  try {
    descriptor = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const pathBefore = lstatSync(targetPath);
    const actual = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(targetPath);
    if (
      !before.isFile() || pathBefore.isSymbolicLink() || before.nlink < 1 ||
      before.dev !== pathBefore.dev || before.ino !== pathBefore.ino ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || !actual.equals(content)
    ) throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
    for (const ancestor of ancestors) {
      const metadata = lstatSync(ancestor.path);
      if (
        !metadata.isDirectory() || metadata.isSymbolicLink() ||
        metadata.dev !== ancestor.device || metadata.ino !== ancestor.inode
      ) throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
    }
  } catch (error) {
    if (error instanceof MaterializationError) throw error;
    throw new MaterializationError("MIAOBI_OBJECT_CONFLICT");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertAllImmutableObjectsAtCommit(
  pagesDirectory: string,
  assets: FinalAsset[],
  records: Record<string, GitHubPagesAssetRecord>,
): void {
  for (const asset of assets) {
    assertImmutableObjectSync(
      pagesDirectory,
      records[asset.relativePath].objectPath,
      asset.content,
    );
  }
}

type WriterLockOwner = {
  schemaVersion: 1;
  ownerToken: string;
  pid: number;
  heartbeatAt: string;
};

type WriterLock = {
  assertOwned(): Promise<void>;
  assertOwnedSync(): void;
  release(): Promise<void>;
};

async function readLockOwner(lockPath: string): Promise<WriterLockOwner | null> {
  let handle;
  try {
    handle = await open(join(lockPath, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<WriterLockOwner>;
    if (
      parsed.schemaVersion !== 1 || typeof parsed.ownerToken !== "string" ||
      !/^[0-9a-f]{32}$/.test(parsed.ownerToken) || !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.heartbeatAt !== "string" ||
      Number.isNaN(new Date(parsed.heartbeatAt).getTime())
    ) return null;
    return parsed as WriterLockOwner;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function readLockOwnerSync(lockPath: string): WriterLockOwner | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      join(lockPath, "owner.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as Partial<WriterLockOwner>;
    if (
      parsed.schemaVersion !== 1 || typeof parsed.ownerToken !== "string" ||
      !/^[0-9a-f]{32}$/.test(parsed.ownerToken) || !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.heartbeatAt !== "string" ||
      Number.isNaN(new Date(parsed.heartbeatAt).getTime())
    ) return null;
    return parsed as WriterLockOwner;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ownerLeaseExpired(owner: WriterLockOwner | null, lockMtimeMs: number): boolean {
  const heartbeatMs = owner ? new Date(owner.heartbeatAt).getTime() : lockMtimeMs;
  return Date.now() - heartbeatMs > LOCK_LEASE_MS;
}

async function acquireWriterLock(pagesDirectory: string): Promise<WriterLock> {
  await ensureDirectory(pagesDirectory);
  const lockPath = join(pagesDirectory, ".github-pages-assets.lock");
  const ownerPath = join(lockPath, "owner.json");
  const ownerToken = randomUUID().split("-").join("");
  let lockIdentity: DirectoryIdentity | undefined;
  let staleQuarantine: string | undefined;

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const metadata = lstatSync(lockPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidPath();
      lockIdentity = { path: lockPath, device: metadata.dev, inode: metadata.ino };
      writeFileSync(ownerPath, `${JSON.stringify({
        schemaVersion: 1,
        ownerToken,
        pid: process.pid,
        heartbeatAt: new Date().toISOString(),
      } satisfies WriterLockOwner)}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let observedMetadata;
      try {
        observedMetadata = await lstat(lockPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (!observedMetadata.isDirectory() || observedMetadata.isSymbolicLink()) invalidPath();
      const observedOwner = await readLockOwner(lockPath);
      if (!ownerLeaseExpired(observedOwner, observedMetadata.mtimeMs)) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }

      const quarantinePath = join(
        pagesDirectory,
        `.github-pages-assets.stale-${randomUUID()}`,
      );
      try {
        await rename(lockPath, quarantinePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      const movedMetadata = await lstat(quarantinePath);
      const movedOwner = await readLockOwner(quarantinePath);
      if (
        movedMetadata.dev !== observedMetadata.dev || movedMetadata.ino !== observedMetadata.ino ||
        movedOwner?.ownerToken !== observedOwner?.ownerToken ||
        !ownerLeaseExpired(movedOwner, movedMetadata.mtimeMs)
      ) {
        try {
          await rename(quarantinePath, lockPath);
        } catch {
          // A concurrent contender owns the canonical lock path; preserve quarantine fail closed.
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }
      staleQuarantine = quarantinePath;
    }
  }

  let heartbeatFailure: unknown;
  const assertOwnedSync = (): void => {
    if (heartbeatFailure || !lockIdentity) {
      throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
    }
    try {
      const metadata = lstatSync(lockPath);
      const current = readLockOwnerSync(lockPath);
      if (
        metadata.dev !== lockIdentity.device || metadata.ino !== lockIdentity.inode ||
        current?.ownerToken !== ownerToken
      ) throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
    } catch (error) {
      if (error instanceof MaterializationError) throw error;
      throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
    }
  };

  const writeHeartbeat = async (): Promise<void> => {
    await writeJsonAtomically(ownerPath, {
      schemaVersion: 1,
      ownerToken,
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
    } satisfies WriterLockOwner, assertOwnedSync, false);
  };
  await writeHeartbeat();
  if (staleQuarantine) await rm(staleQuarantine, { recursive: true, force: true });

  const heartbeat = setInterval(() => {
    void writeHeartbeat().catch((error) => {
      heartbeatFailure = error;
    });
  }, Math.floor(LOCK_LEASE_MS / 3));
  heartbeat.unref();

  const assertOwned = async (): Promise<void> => {
    if (heartbeatFailure) throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
    if (!lockIdentity) throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
    const [metadata, current] = await Promise.all([
      lstat(lockPath),
      readLockOwner(lockPath),
    ]);
    if (
      metadata.dev !== lockIdentity.device || metadata.ino !== lockIdentity.inode ||
      current?.ownerToken !== ownerToken
    ) throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
  };

  return {
    assertOwned,
    assertOwnedSync,
    async release() {
      clearInterval(heartbeat);
      const cleanupPath = join(pagesDirectory, `.github-pages-assets.release-${ownerToken}`);
      try {
        assertOwnedSync();
        renameSync(lockPath, cleanupPath);
        const moved = lstatSync(cleanupPath);
        const movedOwner = readLockOwnerSync(cleanupPath);
        if (
          moved.dev === lockIdentity?.device && moved.ino === lockIdentity?.inode &&
          movedOwner?.ownerToken === ownerToken
        ) {
          await rm(cleanupPath, { recursive: true, force: true });
        }
      } catch {
        // Ownership changed or cleanup raced; never remove a path not proven to be ours.
      }
    },
  };
}

function sameBytesSync(path: string, expected: Buffer): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const pathMetadata = lstatSync(path);
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    return before.isFile() && !pathMetadata.isSymbolicLink() &&
      before.dev === pathMetadata.dev && before.ino === pathMetadata.ino &&
      before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
      content.equals(expected);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function writeJsonImmutable(
  path: string,
  value: unknown,
  beforeCommit?: () => void,
): Promise<void> {
  await ensureDirectory(dirname(path));
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    beforeCommit?.();
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !sameBytesSync(path, content)) {
        throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
  beforeCommit?: () => void,
  createParent = true,
): Promise<void> {
  if (createParent) await ensureDirectory(dirname(path));
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    beforeCommit?.();
    renameSync(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function createdAtForRelease(releaseId: string): string {
  const timestamp = releaseId.slice(-14);
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}.000Z`;
}

async function existingCreatedAt(path: string, expected: Omit<GitHubPagesManifest, "createdAt">): Promise<string | undefined> {
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as GitHubPagesManifest;
    const { createdAt, ...rest } = current;
    if (JSON.stringify(rest) !== JSON.stringify(expected)) {
      throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
    }
    return createdAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof MaterializationError) throw error;
    throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
  }
}

export async function materializeGitHubPagesRelease(input: {
  clientDirectory: string;
  pagesDirectory: string;
  sourceCommit: string;
  releaseId: string;
  pagesOrigin: "https://aurostars.github.io";
  pagesBasePath: "/magic-resume/";
}): Promise<{
  manifest: GitHubPagesManifest;
  releaseDirectory: string;
  createdObjectPaths: string[];
}> {
  if (
    !SOURCE_COMMIT_PATTERN.test(input.sourceCommit) ||
    !RELEASE_ID_PATTERN.test(input.releaseId) ||
    input.pagesOrigin !== "https://aurostars.github.io" ||
    input.pagesBasePath !== "/magic-resume/"
  ) {
    invalidPath();
  }
  const clientDirectory = resolve(input.clientDirectory);
  const pagesDirectory = resolve(input.pagesDirectory);
  if (pagesDirectory === clientDirectory || pagesDirectory.startsWith(`${clientDirectory}${sep}`)) {
    invalidPath();
  }
  await rejectSymlinkPathComponents(pagesDirectory);

  const snapshots = await snapshotAssets(clientDirectory);
  const graphHash = graphHashFor(snapshots);
  const assetRoot = `${input.pagesOrigin}${input.pagesBasePath}objects/${graphHash}/`;
  const assets = finalizeAssets(snapshots, assetRoot);
  const records: Record<string, GitHubPagesAssetRecord> = {};
  for (const asset of assets) {
    const objectPath = `objects/${graphHash}/${asset.relativePath}` as const;
    records[asset.relativePath] = {
      relativePath: asset.relativePath,
      contentHash: asset.contentHash,
      contentType: asset.contentType,
      key: objectPath,
      url: `${input.pagesOrigin}${input.pagesBasePath}${objectPath}`,
      objectPath,
      size: asset.content.length,
    };
  }

  const releaseDirectory = join(pagesDirectory, "releases", input.sourceCommit);
  const manifestPath = join(releaseDirectory, "manifest.json");
  const manifestWithoutTime: Omit<GitHubPagesManifest, "createdAt"> = {
    schemaVersion: 1,
    provider: "github-pages",
    sourceCommit: input.sourceCommit,
    releaseId: input.releaseId,
    baseUrl: `${input.pagesOrigin}${input.pagesBasePath}`,
    files: records,
  };
  const createdObjectPaths: string[] = [];
  const releaseWriter = await acquireWriterLock(pagesDirectory);
  try {
    const manifest: GitHubPagesManifest = {
      ...manifestWithoutTime,
      createdAt: await existingCreatedAt(manifestPath, manifestWithoutTime) ??
        createdAtForRelease(input.releaseId),
    };

    const canonicalByContent = new Map<string, string>();
    for (const asset of assets) {
      const objectPath = records[asset.relativePath].objectPath;
      const canonicalObjectPath = canonicalByContent.get(asset.contentHash);
      const created = canonicalObjectPath === undefined
        ? await publishImmutableObject(pagesDirectory, objectPath, asset.content)
        : await publishImmutableAlias(
          pagesDirectory,
          canonicalObjectPath,
          objectPath,
          asset.content,
        );
      canonicalByContent.set(asset.contentHash, canonicalObjectPath ?? objectPath);
      if (created) createdObjectPaths.push(objectPath);
    }
    for (const asset of assets) {
      await assertImmutableObject(
        pagesDirectory,
        records[asset.relativePath].objectPath,
        asset.content,
      );
    }

    const indexPath = join(pagesDirectory, "releases", "index.json");
    let releases: Record<string, { releaseId: string; manifest: string }> = {};
    try {
      const current = JSON.parse(await readFile(indexPath, "utf8")) as {
        schemaVersion: 1;
        releases: typeof releases;
      };
      if (current.schemaVersion !== 1 || typeof current.releases !== "object" || !current.releases) {
        throw new Error("invalid index");
      }
      releases = current.releases;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new MaterializationError("MIAOBI_RELEASE_CONFLICT");
      }
    }
    releases = {
      ...releases,
      [input.sourceCommit]: {
        releaseId: input.releaseId,
        manifest: `releases/${input.sourceCommit}/manifest.json`,
      },
    };
    const sortedReleases = Object.fromEntries(
      Object.entries(releases).sort(([left], [right]) => compareNames(left, right)),
    );

    await releaseWriter.assertOwned();
    await writeJsonImmutable(manifestPath, manifest, () => {
      releaseWriter.assertOwnedSync();
      assertAllImmutableObjectsAtCommit(pagesDirectory, assets, records);
      releaseWriter.assertOwnedSync();
    });
    await releaseWriter.assertOwned();
    await writeJsonAtomically(indexPath, { schemaVersion: 1, releases: sortedReleases });
    return { manifest, releaseDirectory, createdObjectPaths };
  } finally {
    await releaseWriter.release();
  }
}

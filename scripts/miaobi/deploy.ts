import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import config from "../../miaobi.config.json" with { type: "json" };
import { injectMiaobiRuntime } from "../../miaobi/runtime-config";
import { MIAOBI_ASSET_BASE_PLACEHOLDER } from "../../vite.miaobi.config";
import { buildWebFaas } from "./build-web-faas";
import {
  createMagicBuilderRunner,
  MagicBuilderError,
  resolveMagicPlatformOrigin,
  runMagicBuilderObject,
} from "./magic-builder";
import { createReleaseId, publishAssets } from "./publish-assets";
import type { MagicBuilderRunner } from "./types";

export interface MiaobiDeployConfig {
  pageId: "vv6BtLE8MTR";
  title: "魔方简历";
  assetKeyPrefix: "magic-resume/releases";
}

/**
 * Crash-recovery state protected by 0700/0600 local storage. Its validation
 * detects corruption and cross-field inconsistencies; it is not an
 * authentication boundary against malicious code running as the same UID.
 */
export interface MiaobiDeploymentState {
  schemaVersion: 2;
  apiBuildMarker: string;
  releaseId: string;
  apiFaasId: string;
  apiFaasUrl: string;
  webFaasId: string;
  webFaasUrl: string;
  pageId: string;
  deployedAt: string;
}

type PendingPhase = "prepared" | "page-inflight" | "page-confirmed";

type PendingDeployment = {
  schemaVersion: 3;
  status: "pending-page-commit";
  phase: PendingPhase;
  platformOrigin: string;
  apiBuildMarker: string;
  deployment: MiaobiDeploymentState;
  page: { id: string; artifactPath: "dist/miaobi/page.html"; sha256: string };
};

type VersionTwoPendingDeployment = Omit<PendingDeployment, "schemaVersion" | "phase"> & {
  schemaVersion: 2;
};

type LegacyDeploymentState = Omit<MiaobiDeploymentState, "schemaVersion" | "apiBuildMarker"> & {
  schemaVersion: 1;
  apiBuildMarker?: string;
};

type LegacyPendingDeployment = {
  schemaVersion: 1;
  status: "pending-page-commit";
  platformOrigin: string;
  deployment: LegacyDeploymentState;
  page: { id: string; artifactPath: "dist/miaobi/page.html"; sha256: string };
};

type TrustedStorage = {
  directory: string;
  device: number;
  inode: number;
};

type TrustedState = TrustedStorage & {
  legacyStatePath: string;
  states: TrustedStorage;
};

type TrustedRecovery = TrustedStorage & {
  legacyExternalPendingPath: string;
  legacyPendingPath: string;
  pending: TrustedStorage;
  pageInflight: TrustedStorage;
  pageConfirmed: TrustedStorage;
  generations: TrustedStorage;
  lockPath: string;
};

type GenerationStateRecord = {
  schemaVersion: 1;
  generation: number;
  ownerToken: string;
  resolvedGeneration: number;
  resolvedOwnerToken: string;
  deployment: MiaobiDeploymentState;
  path: string;
};

type GenerationPendingRecord = {
  schemaVersion: 1;
  generation: number;
  ownerToken: string;
  legacyAnchor: boolean;
  pending: PendingDeployment;
  path: string;
  phaseAmbiguous?: boolean;
};

type PagePhaseRecord = {
  schemaVersion: 1;
  generation: number;
  ownerToken: string;
  resolvedGeneration: number;
  resolvedOwnerToken: string;
  pending: PendingDeployment;
  path: string;
};

type ApiBuildMetadata = {
  schemaVersion: 1;
  gitCommit: string;
  buildMarker: string;
  bundleSha256: string;
};

const deployConfig = config as MiaobiDeployConfig;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BUILD_MARKER_PATTERN = /^([0-9a-f]{40})\.([0-9a-f]{32,128})$/;
const LOCK_GRACE_MS = 30_000;
// A 30 s heartbeat and 120 s lease tolerate three missed ticks plus ordinary
// event-loop stalls before recovery is allowed. A lock is live only while both
// its PID and this token-bound inode heartbeat are live.
const LOCK_HEARTBEAT_MS = 30_000;
const LOCK_LEASE_MS = 120_000;

export type StateLockClock = {
  now: () => number;
  setInterval: (callback: () => void, milliseconds: number) => { unref?: () => void };
  clearInterval: (timer: unknown) => void;
};

const systemLockClock: StateLockClock = {
  now: Date.now,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

function deploymentPaths() {
  return {
    outputDirectory: resolve("dist/miaobi"),
    legacyStatePath: resolve(".miaobi/deployment.json"),
    legacyPendingPath: resolve(".miaobi/deployment.pending.json"),
    legacyExternalPendingPath: resolve(".miaobi-recovery/deployment.pending.json"),
  };
}

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function validateResourceId(value: unknown): string {
  if (typeof value !== "string" || !RESOURCE_ID_PATTERN.test(value)) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  return value;
}

function validatePublishedUrl(value: string, expectedPath: string, platformOrigin: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin !== platformOrigin || url.username || url.password ||
      url.pathname !== expectedPath || url.search || url.hash
    ) throw new Error();
    return url.toString();
  } catch {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = root;
  for (const component of relative(root, absolutePath).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw codedError("MIAOBI_STATE_FAILED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

// Security boundary: crash recovery, accidental corruption, and processes that
// cannot write these 0700/0600 paths. This is deliberately not an authenticity
// claim against malicious same-UID code; a key stored beside pending would not
// create an independent HMAC trust anchor. Node also has no portable dirfd-relative
// open/rename, so identity checks fail closed on detected directory replacement.
async function trustedStorage(directory: string): Promise<TrustedStorage> {
  await rejectSymlinkAncestors(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw codedError("MIAOBI_STATE_FAILED");
  await chmod(directory, 0o700);
  return { directory, device: metadata.dev, inode: metadata.ino };
}

async function trustedState(statePath: string): Promise<TrustedState> {
  const storage = await trustedStorage(dirname(statePath));
  const states = await trustedStorage(join(storage.directory, "states"));
  return {
    ...storage,
    legacyStatePath: statePath,
    states,
  };
}

async function trustedRecovery(recoveryPath: string, legacyPendingPath: string): Promise<TrustedRecovery> {
  const storage = await trustedStorage(dirname(recoveryPath));
  const pending = await trustedStorage(join(storage.directory, "pending"));
  const pageInflight = await trustedStorage(join(storage.directory, "page-inflight"));
  const pageConfirmed = await trustedStorage(join(storage.directory, "page-confirmed"));
  const generations = await trustedStorage(join(storage.directory, "generations"));
  return {
    ...storage,
    legacyExternalPendingPath: recoveryPath,
    legacyPendingPath,
    pending,
    pageInflight,
    pageConfirmed,
    generations,
    lockPath: join(storage.directory, "deployment.lock"),
  };
}

async function assertStorageIdentity(state: TrustedStorage): Promise<void> {
  try {
    const metadata = await lstat(state.directory);
    if (
      metadata.isSymbolicLink() || !metadata.isDirectory() ||
      metadata.dev !== state.device || metadata.ino !== state.inode
    ) throw new Error();
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  }
}

async function refreshLockHeartbeat(
  state: TrustedRecovery,
  token: string,
  claimed: { dev: number; ino: number },
  now: number,
): Promise<void> {
  await assertStorageIdentity(state);
  const current = await readJsonFile(state.lockPath) as { token?: unknown } | undefined;
  const beforeTouch = await lstat(state.lockPath);
  if (
    current?.token !== token || beforeTouch.dev !== claimed.dev || beforeTouch.ino !== claimed.ino ||
    !beforeTouch.isFile() || beforeTouch.isSymbolicLink()
  ) throw codedError("MIAOBI_STATE_LOCKED");
  const heartbeatAt = new Date(now);
  await utimes(state.lockPath, heartbeatAt, heartbeatAt);
  const afterTouch = await lstat(state.lockPath);
  if (afterTouch.dev !== claimed.dev || afterTouch.ino !== claimed.ino) {
    throw codedError("MIAOBI_STATE_LOCKED");
  }
}

async function allocateGeneration(state: TrustedRecovery, committedState: TrustedState): Promise<number> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    await assertStorageIdentity(state.generations);
    await assertStorageIdentity(state.pending);
    await assertStorageIdentity(state.pageInflight);
    await assertStorageIdentity(state.pageConfirmed);
    await assertStorageIdentity(committedState.states);
    const entries = await readdir(state.generations.directory, { withFileTypes: true });
    let maximum = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) {
        throw codedError("MIAOBI_STATE_FAILED");
      }
      const generation = Number(entry.name);
      if (!Number.isSafeInteger(generation)) throw codedError("MIAOBI_STATE_FAILED");
      maximum = Math.max(maximum, generation);
    }
    for (const storage of [state.pending, state.pageInflight, state.pageConfirmed, committedState.states]) {
      for (const entry of await readdir(storage.directory, { withFileTypes: true })) {
        if (GENERATION_TEMP_FILE_PATTERN.test(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw codedError("MIAOBI_STATE_FAILED");
        maximum = Math.max(maximum, parseGenerationFileName(entry.name).generation);
      }
    }
    const generation = maximum + 1;
    if (!Number.isSafeInteger(generation)) throw codedError("MIAOBI_STATE_FAILED");
    try {
      await mkdir(join(state.generations.directory, String(generation)), { mode: 0o700 });
      await assertStorageIdentity(state.generations);
      return generation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw codedError("MIAOBI_STATE_FAILED");
    }
  }
  throw codedError("MIAOBI_STATE_LOCKED");
}

type StateLock = {
  generation: number;
  ownerToken: string;
  assertOwnership: () => Promise<void>;
  release: () => Promise<void>;
};

async function acquireStateLock(
  state: TrustedRecovery,
  committedState: TrustedState,
  clock: StateLockClock,
): Promise<StateLock> {
  await assertStorageIdentity(state);
  const token = randomUUID().replaceAll("-", "");
  const generation = await allocateGeneration(state, committedState);
  const processStartedAt = new Date(clock.now() - process.uptime() * 1000).toISOString();
  const owner = {
    schemaVersion: 1,
    generation,
    pid: process.pid,
    token,
    startedAt: new Date(clock.now()).toISOString(),
    processStartedAt,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stagedLockPath = join(state.directory, `.deployment.lock-${token}`);
    let handle;
    try {
      handle = await open(
        stagedLockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertStorageIdentity(state);
      await link(stagedLockPath, state.lockPath);
      await rm(stagedLockPath);
      const claimed = await lstat(state.lockPath);
      if (!claimed.isFile() || claimed.isSymbolicLink()) throw new Error();
      let ownershipLost = false;
      let heartbeatRunning = false;
      const loseOwnership = (): void => {
        ownershipLost = true;
        clock.clearInterval(heartbeatTimer);
      };
      const verifyOwnership = async (): Promise<void> => {
        if (ownershipLost) throw new MagicBuilderError("MIAOBI_OWNERSHIP_LOST");
        try {
          await refreshLockHeartbeat(state, token, claimed, clock.now());
        } catch {
          loseOwnership();
          throw new MagicBuilderError("MIAOBI_OWNERSHIP_LOST");
        }
      };
      const heartbeatTimer = clock.setInterval(() => {
        if (heartbeatRunning || ownershipLost) return;
        heartbeatRunning = true;
        void verifyOwnership()
          .catch(() => undefined)
          .finally(() => { heartbeatRunning = false; });
      }, LOCK_HEARTBEAT_MS);
      heartbeatTimer.unref?.();
      return {
        generation,
        ownerToken: token,
        assertOwnership: verifyOwnership,
        release: async () => {
          clock.clearInterval(heartbeatTimer);
          try {
            await assertStorageIdentity(state);
            const current = await readJsonFile(state.lockPath) as { token?: unknown } | undefined;
            if (current?.token !== token) return;
            const beforeRemove = await lstat(state.lockPath);
            if (beforeRemove.dev === claimed.dev && beforeRemove.ino === claimed.ino) {
              await rm(state.lockPath, { force: true });
            }
          } catch {
            // Never remove a lock whose directory identity or ownership changed.
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(stagedLockPath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        throw codedError("MIAOBI_STATE_LOCKED");
      }
      let metadata;
      try {
        metadata = await lstat(state.lockPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error();
      } catch {
        throw codedError("MIAOBI_STATE_LOCKED");
      }
      const ageMs = clock.now() - metadata.mtimeMs;
      if (ageMs < LOCK_GRACE_MS) throw codedError("MIAOBI_STATE_LOCKED");
      let stale = false;
      let validOwner = false;
      let staleAfterMs = LOCK_GRACE_MS;
      let existing: {
        schemaVersion?: unknown; pid?: unknown; token?: unknown; startedAt?: unknown; processStartedAt?: unknown;
      } | undefined;
      try {
        existing = await readJsonFile(state.lockPath) as typeof existing;
        if (
          existing?.schemaVersion !== 1 || typeof existing.pid !== "number" || existing.pid <= 0 ||
          typeof existing.token !== "string" || !/^[0-9a-f]{32}$/.test(existing.token) ||
          typeof existing.startedAt !== "string" || typeof existing.processStartedAt !== "string"
        ) throw new Error();
        const startedAt = Date.parse(existing.startedAt);
        const recordedProcessStart = Date.parse(existing.processStartedAt);
        if (
          !Number.isFinite(startedAt) || !Number.isFinite(recordedProcessStart) ||
          recordedProcessStart > startedAt
        ) throw new Error();
        validOwner = true;
        stale = ageMs > LOCK_LEASE_MS;
        if (stale) staleAfterMs = LOCK_LEASE_MS;
      } catch {
        stale = true;
      }
      if (!stale && existing && typeof existing.pid === "number") {
        try { process.kill(existing.pid, 0); } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") stale = true;
          else throw codedError("MIAOBI_STATE_LOCKED");
        }
      }
      if (!stale) throw codedError("MIAOBI_STATE_LOCKED");
      await assertStorageIdentity(state);
      const beforeRemove = await lstat(state.lockPath);
      if (
        beforeRemove.dev !== metadata.dev || beforeRemove.ino !== metadata.ino ||
        clock.now() - beforeRemove.mtimeMs <= staleAfterMs
      ) throw codedError("MIAOBI_STATE_LOCKED");
      if (validOwner) {
        const beforeRemoveOwner = await readJsonFile(state.lockPath) as { token?: unknown } | undefined;
        if (beforeRemoveOwner?.token !== existing?.token) throw codedError("MIAOBI_STATE_LOCKED");
      }
      await rm(state.lockPath);
    }
  }
  throw codedError("MIAOBI_STATE_LOCKED");
}

function fencedRunner(runner: MagicBuilderRunner, lock: StateLock): MagicBuilderRunner {
  return {
    platformOrigin: runner.platformOrigin,
    async run(args) {
      await lock.assertOwnership();
      try {
        const result = await runner.run(args);
        await lock.assertOwnership();
        return result;
      } catch (error) {
        await lock.assertOwnership();
        throw error;
      }
    },
  };
}

function markerCommit(buildMarker: string): string | undefined {
  return BUILD_MARKER_PATTERN.exec(buildMarker)?.[1];
}

function releaseCommitPrefix(releaseId: string): string | undefined {
  return /^([0-9a-f]{12})-\d{14}$/.exec(releaseId)?.[1];
}

function validateDeploymentFields(
  deployment: MiaobiDeploymentState | LegacyDeploymentState,
  platformOrigin: string,
): void {
  try {
    const releasePrefix = releaseCommitPrefix(deployment.releaseId);
    if (!releasePrefix || new Date(deployment.deployedAt).toISOString() !== deployment.deployedAt) throw new Error();
    validatePublishedUrl(
      deployment.apiFaasUrl,
      `/api/faas/${validateResourceId(deployment.apiFaasId)}`,
      platformOrigin,
    );
    validatePublishedUrl(
      deployment.webFaasUrl,
      `/api/faas/${validateResourceId(deployment.webFaasId)}`,
      platformOrigin,
    );
    if (deployment.apiBuildMarker !== undefined) {
      const markerPrefix = markerCommit(deployment.apiBuildMarker)?.slice(0, 12);
      if (!markerPrefix || markerPrefix !== releasePrefix) throw new Error();
    }
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  }
}

function parseDeploymentState(
  value: unknown,
  platformOrigin: string,
): MiaobiDeploymentState | LegacyDeploymentState {
  const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
  const commonKeys = [
    "apiFaasId", "apiFaasUrl", "deployedAt", "pageId", "releaseId",
    "schemaVersion", "webFaasId", "webFaasUrl",
  ];
  const schemaVersion = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  const hasMarker = typeof (value as { apiBuildMarker?: unknown } | null)?.apiBuildMarker === "string";
  const expectedKeys = schemaVersion === 2 || (schemaVersion === 1 && hasMarker)
    ? [...commonKeys, "apiBuildMarker"].sort()
    : commonKeys.sort();
  if (
    typeof value !== "object" || value === null ||
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    (value as { pageId?: unknown }).pageId !== deployConfig.pageId ||
    (hasMarker && !BUILD_MARKER_PATTERN.test((value as { apiBuildMarker: string }).apiBuildMarker)) ||
    (schemaVersion === 2 && !hasMarker) ||
    typeof (value as { releaseId?: unknown }).releaseId !== "string" ||
    typeof (value as { deployedAt?: unknown }).deployedAt !== "string"
  ) throw codedError("MIAOBI_STATE_FAILED");
  const deployment = value as MiaobiDeploymentState | LegacyDeploymentState;
  validateDeploymentFields(deployment, platformOrigin);
  return deployment;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw codedError("MIAOBI_STATE_FAILED");
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error();
    return JSON.parse(await handle.readFile("utf8"));
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  } finally {
    await handle.close();
  }
}

const OWNER_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const GENERATION_FILE_PATTERN = /^([1-9]\d*)-([0-9a-f]{32})\.json$/;
const GENERATION_TEMP_FILE_PATTERN = /^\.[1-9]\d*-[0-9a-f]{32}\.json\.tmp-[0-9a-f]{32}-[0-9a-f-]{36}$/;

function generationFileName(generation: number, ownerToken: string): string {
  if (!Number.isSafeInteger(generation) || generation <= 0 || !OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw codedError("MIAOBI_STATE_FAILED");
  }
  return `${generation}-${ownerToken}.json`;
}

function parseGenerationFileName(name: string): { generation: number; ownerToken: string } {
  const match = GENERATION_FILE_PATTERN.exec(name);
  const generation = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(generation)) throw codedError("MIAOBI_STATE_FAILED");
  return { generation, ownerToken: match[2] };
}

async function immutableJson(
  storage: TrustedStorage,
  targetPath: string,
  ownerToken: string,
  value: unknown,
): Promise<void> {
  await assertStorageIdentity(storage);
  if (dirname(targetPath) !== storage.directory || !targetPath.endsWith(`-${ownerToken}.json`)) {
    throw codedError("MIAOBI_STATE_FAILED");
  }
  const temporaryPath = join(storage.directory, `.${generationFileName(
    parseGenerationFileName(targetPath.slice(storage.directory.length + 1)).generation,
    ownerToken,
  )}.tmp-${ownerToken}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const staged = await handle.stat();
    await handle.close();
    handle = undefined;
    await assertStorageIdentity(storage);
    await link(temporaryPath, targetPath);
    const directoryHandle = await open(storage.directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await assertStorageIdentity(storage);
    const committed = await lstat(targetPath);
    if (
      !committed.isFile() || committed.isSymbolicLink() ||
      committed.dev !== staged.dev || committed.ino !== staged.ino
    ) throw new Error();
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
    await safeRemoveStaged(storage, temporaryPath);
  }
}

async function generationStates(state: TrustedState, platformOrigin: string): Promise<GenerationStateRecord[]> {
  await assertStorageIdentity(state.states);
  const entries = await readdir(state.states.directory, { withFileTypes: true });
  const records: GenerationStateRecord[] = [];
  for (const entry of entries) {
    if (GENERATION_TEMP_FILE_PATTERN.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw codedError("MIAOBI_STATE_FAILED");
    const identity = parseGenerationFileName(entry.name);
    const path = join(state.states.directory, entry.name);
    const value = await readJsonFile(path) as Omit<GenerationStateRecord, "path"> | undefined;
    const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
    if (
      !value || JSON.stringify(keys) !== JSON.stringify([
        "deployment", "generation", "ownerToken", "resolvedGeneration", "resolvedOwnerToken", "schemaVersion",
      ].sort()) ||
      value.schemaVersion !== 1 || value.generation !== identity.generation ||
      value.ownerToken !== identity.ownerToken ||
      !Number.isSafeInteger(value.resolvedGeneration) || value.resolvedGeneration < 0 ||
      value.resolvedGeneration > value.generation || !OWNER_TOKEN_PATTERN.test(value.resolvedOwnerToken)
    ) throw codedError("MIAOBI_STATE_FAILED");
    const deployment = parseDeploymentState(value.deployment, platformOrigin);
    if (deployment.schemaVersion !== 2) throw codedError("MIAOBI_STATE_FAILED");
    records.push({ ...value, deployment, path });
  }
  return records.sort((left, right) => left.generation - right.generation);
}

async function commitGenerationState(
  state: TrustedState,
  lock: StateLock,
  deployment: MiaobiDeploymentState,
  resolved: { generation: number; ownerToken: string } = lock,
): Promise<string> {
  const path = join(state.states.directory, generationFileName(lock.generation, lock.ownerToken));
  await immutableJson(state.states, path, lock.ownerToken, {
    schemaVersion: 1,
    generation: lock.generation,
    ownerToken: lock.ownerToken,
    resolvedGeneration: resolved.generation,
    resolvedOwnerToken: resolved.ownerToken,
    deployment,
  });
  return path;
}

async function priorState(
  state: TrustedState,
  platformOrigin: string,
): Promise<MiaobiDeploymentState | LegacyDeploymentState | undefined> {
  const records = await generationStates(state, platformOrigin);
  if (records.length > 0) return records.at(-1)?.deployment;
  await assertStorageIdentity(state);
  const value = await readJsonFile(state.legacyStatePath);
  return value === undefined ? undefined : parseDeploymentState(value, platformOrigin);
}

function parsePending(value: unknown, platformOrigin: string): PendingDeployment {
  try {
    const raw = value as PendingDeployment | VersionTwoPendingDeployment;
    const schemaVersion = raw?.schemaVersion;
    const phase = schemaVersion === 2 ? "prepared" : (raw as PendingDeployment)?.phase;
    const keys = raw && typeof raw === "object" ? Object.keys(raw).sort() : [];
    const expectedKeys = schemaVersion === 2
      ? ["apiBuildMarker", "deployment", "page", "platformOrigin", "schemaVersion", "status"].sort()
      : ["apiBuildMarker", "deployment", "page", "phase", "platformOrigin", "schemaVersion", "status"].sort();
    const pageKeys = raw?.page && typeof raw.page === "object"
      ? Object.keys(raw.page).sort()
      : [];
    if (
      !raw || typeof raw !== "object" ||
      JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(pageKeys) !== JSON.stringify(["artifactPath", "id", "sha256"].sort()) ||
      (schemaVersion !== 2 && schemaVersion !== 3) ||
      (phase !== "prepared" && phase !== "page-inflight" && phase !== "page-confirmed") ||
      raw.status !== "pending-page-commit" || raw.platformOrigin !== platformOrigin ||
      !BUILD_MARKER_PATTERN.test(raw.apiBuildMarker) ||
      raw.apiBuildMarker !== raw.deployment?.apiBuildMarker ||
      raw.page.id !== deployConfig.pageId ||
      raw.page.artifactPath !== "dist/miaobi/page.html" ||
      !HASH_PATTERN.test(raw.page.sha256)
    ) throw new Error();
    const deployment = parseDeploymentState(raw.deployment, platformOrigin);
    if (deployment.schemaVersion !== 2) throw new Error();
    return { ...raw, schemaVersion: 3, phase };
  } catch {
    throw codedError("MIAOBI_PENDING_INVALID");
  }
}

function migrateLegacyPending(
  value: unknown,
  platformOrigin: string,
  localBuildMarker: string,
): PendingDeployment {
  try {
    const pending = value as LegacyPendingDeployment & { apiBuildMarker?: string };
    const hasMarker = typeof pending?.apiBuildMarker === "string";
    const keys = pending && typeof pending === "object" ? Object.keys(pending).sort() : [];
    const expectedKeys = hasMarker
      ? ["apiBuildMarker", "deployment", "page", "platformOrigin", "schemaVersion", "status"].sort()
      : ["deployment", "page", "platformOrigin", "schemaVersion", "status"].sort();
    const pageKeys = pending?.page && typeof pending.page === "object" ? Object.keys(pending.page).sort() : [];
    if (
      !pending || typeof pending !== "object" ||
      JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(pageKeys) !== JSON.stringify(["artifactPath", "id", "sha256"].sort()) ||
      pending.schemaVersion !== 1 || pending.status !== "pending-page-commit" ||
      pending.platformOrigin !== platformOrigin || pending.page.id !== deployConfig.pageId ||
      pending.page.artifactPath !== "dist/miaobi/page.html" || !HASH_PATTERN.test(pending.page.sha256)
    ) throw new Error();
    const legacyDeployment = parseDeploymentState(pending.deployment, platformOrigin);
    if (legacyDeployment.schemaVersion !== 1) throw new Error();
    const buildMarker = pending.apiBuildMarker ?? legacyDeployment.apiBuildMarker ?? localBuildMarker;
    if (
      !BUILD_MARKER_PATTERN.test(buildMarker) || buildMarker !== localBuildMarker ||
      (pending.apiBuildMarker !== undefined && pending.apiBuildMarker !== buildMarker) ||
      (legacyDeployment.apiBuildMarker !== undefined && legacyDeployment.apiBuildMarker !== buildMarker) ||
      markerCommit(buildMarker)?.slice(0, 12) !== releaseCommitPrefix(legacyDeployment.releaseId)
    ) throw new Error();
    const deployment: MiaobiDeploymentState = {
      ...legacyDeployment,
      schemaVersion: 2,
      apiBuildMarker: buildMarker,
    };
    return {
      schemaVersion: 3,
      status: "pending-page-commit",
      phase: "prepared",
      platformOrigin,
      apiBuildMarker: buildMarker,
      deployment,
      page: pending.page,
    };
  } catch {
    throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
  }
}

function samePendingSemantics(left: PendingDeployment, right: PendingDeployment): boolean {
  return (
    sameDeploymentSemantics(left.deployment, right.deployment) &&
    left.platformOrigin === right.platformOrigin && left.apiBuildMarker === right.apiBuildMarker &&
    left.page.id === right.page.id && left.page.artifactPath === right.page.artifactPath &&
    left.page.sha256 === right.page.sha256
  );
}

function sameDeploymentSemantics(
  left: MiaobiDeploymentState,
  right: MiaobiDeploymentState,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion && left.apiBuildMarker === right.apiBuildMarker &&
    left.releaseId === right.releaseId && left.apiFaasId === right.apiFaasId &&
    left.apiFaasUrl === right.apiFaasUrl && left.webFaasId === right.webFaasId &&
    left.webFaasUrl === right.webFaasUrl && left.pageId === right.pageId &&
    left.deployedAt === right.deployedAt
  );
}

async function generationPendingRecords(
  recovery: TrustedRecovery,
  platformOrigin: string,
): Promise<GenerationPendingRecord[]> {
  await assertStorageIdentity(recovery.pending);
  const entries = await readdir(recovery.pending.directory, { withFileTypes: true });
  const records: GenerationPendingRecord[] = [];
  for (const entry of entries) {
    if (GENERATION_TEMP_FILE_PATTERN.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw codedError("MIAOBI_PENDING_INVALID");
    const identity = parseGenerationFileName(entry.name);
    const path = join(recovery.pending.directory, entry.name);
    const value = await readJsonFile(path) as Omit<GenerationPendingRecord, "path"> | undefined;
    const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
    if (
      !value || JSON.stringify(keys) !== JSON.stringify([
        "generation", "legacyAnchor", "ownerToken", "pending", "schemaVersion",
      ].sort()) || value.schemaVersion !== 1 || value.legacyAnchor !== false ||
      value.generation !== identity.generation || value.ownerToken !== identity.ownerToken
    ) throw codedError("MIAOBI_PENDING_INVALID");
    const pendingSchema = (value.pending as { schemaVersion?: unknown } | undefined)?.schemaVersion;
    const pending = parsePending(value.pending, platformOrigin);
    if (pending.phase !== "prepared") throw codedError("MIAOBI_PENDING_INVALID");
    records.push({ ...value, pending, path, phaseAmbiguous: pendingSchema === 2 });
  }
  return records.sort((left, right) => left.generation - right.generation);
}

async function pagePhaseRecords(
  storage: TrustedStorage,
  phase: "page-inflight" | "page-confirmed",
  platformOrigin: string,
): Promise<PagePhaseRecord[]> {
  await assertStorageIdentity(storage);
  const records: PagePhaseRecord[] = [];
  for (const entry of await readdir(storage.directory, { withFileTypes: true })) {
    if (GENERATION_TEMP_FILE_PATTERN.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw codedError("MIAOBI_PENDING_INVALID");
    const identity = parseGenerationFileName(entry.name);
    const path = join(storage.directory, entry.name);
    const value = await readJsonFile(path) as Omit<PagePhaseRecord, "path"> | undefined;
    const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
    if (
      !value || JSON.stringify(keys) !== JSON.stringify([
        "generation", "ownerToken", "pending", "resolvedGeneration", "resolvedOwnerToken", "schemaVersion",
      ].sort()) || value.schemaVersion !== 1 || value.generation !== identity.generation ||
      value.ownerToken !== identity.ownerToken || !Number.isSafeInteger(value.resolvedGeneration) ||
      value.resolvedGeneration <= 0 || value.resolvedGeneration > value.generation ||
      !OWNER_TOKEN_PATTERN.test(value.resolvedOwnerToken)
    ) throw codedError("MIAOBI_PENDING_INVALID");
    const pending = parsePending(value.pending, platformOrigin);
    if (pending.phase !== phase) throw codedError("MIAOBI_PENDING_INVALID");
    records.push({ ...value, pending, path });
  }
  return records.sort((left, right) => left.generation - right.generation);
}

async function publishPagePhase(
  storage: TrustedStorage,
  phase: "page-inflight" | "page-confirmed",
  lock: StateLock,
  pending: PendingDeployment,
  resolved: { generation: number; ownerToken: string },
): Promise<PagePhaseRecord> {
  const path = join(storage.directory, generationFileName(lock.generation, lock.ownerToken));
  const record: Omit<PagePhaseRecord, "path"> = {
    schemaVersion: 1,
    generation: lock.generation,
    ownerToken: lock.ownerToken,
    resolvedGeneration: resolved.generation,
    resolvedOwnerToken: resolved.ownerToken,
    pending: { ...pending, schemaVersion: 3, phase },
  };
  await lock.assertOwnership();
  await immutableJson(storage, path, lock.ownerToken, record);
  await lock.assertOwnership();
  return { ...record, path };
}

async function pendingState(
  state: TrustedState,
  recovery: TrustedRecovery,
  platformOrigin: string,
  outputDirectory: string,
  gitCommit: string,
  lock: StateLock,
): Promise<GenerationPendingRecord | undefined> {
  const records = await generationPendingRecords(recovery, platformOrigin);
  const committed = await generationStates(state, platformOrigin);
  const authoritativeGeneration = committed.at(-1)?.generation ?? 0;
  const unresolved = records.filter((record) => (
    record.generation > authoritativeGeneration &&
    !committed.some((stateRecord) => (
      stateRecord.resolvedGeneration === record.generation &&
      stateRecord.resolvedOwnerToken === record.ownerToken
    ))
  ));
  if (unresolved.length > 1) throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
  if (unresolved.some((record) => record.phaseAmbiguous)) {
    throw codedError("MIAOBI_PAGE_RESULT_UNCERTAIN");
  }

  await assertStorageIdentity(recovery);
  const external = await readJsonFile(recovery.legacyExternalPendingPath);
  await assertStorageIdentity(state);
  const legacy = await readJsonFile(recovery.legacyPendingPath);
  if (external !== undefined || legacy !== undefined) {
    let metadata: ApiBuildMetadata | undefined;
    const migrate = async (value: unknown): Promise<PendingDeployment> => {
      try {
        metadata ??= await readApiBuildMetadata(outputDirectory, gitCommit);
        return migrateLegacyPending(value, platformOrigin, metadata.buildMarker);
      } catch {
        throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
      }
    };
    const externalSchema = (external as { schemaVersion?: unknown } | undefined)?.schemaVersion;
    const hasAmbiguousLegacyPhase = legacy !== undefined || externalSchema === 1 || externalSchema === 2;
    const externalPending = external === undefined
      ? undefined
      : externalSchema === 2 || externalSchema === 3
        ? parsePending(external, platformOrigin)
        : await migrate(external);
    const legacyPending = legacy === undefined ? undefined : await migrate(legacy);
    if (externalPending?.phase !== undefined && externalPending.phase !== "prepared") {
      throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
    }
    if (externalPending && legacyPending && !samePendingSemantics(externalPending, legacyPending)) {
      throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
    }
    if (hasAmbiguousLegacyPhase) throw codedError("MIAOBI_PAGE_RESULT_UNCERTAIN");
    const pending = externalPending ?? legacyPending;
    if (pending && !committed.some((record) => sameDeploymentSemantics(record.deployment, pending.deployment))) {
      if (unresolved.length > 0) throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
      const path = join(recovery.pending.directory, generationFileName(lock.generation, lock.ownerToken));
      const migrated: Omit<GenerationPendingRecord, "path"> = {
        schemaVersion: 1,
        generation: lock.generation,
        ownerToken: lock.ownerToken,
        legacyAnchor: false,
        pending,
      };
      await lock.assertOwnership();
      await immutableJson(recovery.pending, path, lock.ownerToken, migrated);
      unresolved.push({ ...migrated, path });
    }
  }

  unresolved.sort((left, right) => left.generation - right.generation);
  return unresolved[0];
}

function parseFaasPublishResponse(value: unknown, platformOrigin: string): { id: string; url: string } {
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { faas_url?: unknown }).faas_url !== "string"
  ) throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  const id = validateResourceId((value as { id: unknown }).id);
  return {
    id,
    url: validatePublishedUrl((value as { faas_url: string }).faas_url, `/api/faas/${id}`, platformOrigin),
  };
}

function validatePagePublishResponse(value: unknown, platformOrigin: string): void {
  if (
    typeof value !== "object" || value === null ||
    (value as { id?: unknown }).id !== deployConfig.pageId ||
    typeof (value as { html_box_url?: unknown }).html_box_url !== "string"
  ) throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  validatePublishedUrl(
    (value as { html_box_url: string }).html_box_url,
    `/html-box/${deployConfig.pageId}`,
    platformOrigin,
  );
}

async function publishFaas(
  runner: MagicBuilderRunner,
  bundlePath: string,
  name: string,
  platformOrigin: string,
  existingId?: string,
) {
  const selector = existingId ? ["--name", name, "--id", existingId] : ["--name", name];
  return parseFaasPublishResponse(await runMagicBuilderObject(runner, [
    "faas", "publish", bundlePath, ...selector, "--format", "json", "--quiet",
  ]), platformOrigin);
}

async function readBodyPrefix(response: Response, limit = 4096): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text.slice(0, limit);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type HealthCheck = {
  url: string;
  kind: "api" | "web";
  apiFaasUrl: string;
  assetBaseUrl: string;
  apiBuildMarker: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
};

function webRuntimeFrom(body: string): { platform?: unknown; apiFunctionUrl?: unknown; assetBaseUrl?: unknown } | undefined {
  const match = body.match(/window\.__MAGIC_RESUME_RUNTIME__=(\{[^<]+\})<\/script>/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

async function checkHealth(check: HealthCheck): Promise<void> {
  const target = check.kind === "api" ? new URL("?__path=%2F__miaobi_health__", check.url).toString() : check.url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), check.timeoutMs);
  timeout.unref?.();
  try {
    const response = await check.fetch(target, { method: "GET", redirect: "error", signal: controller.signal });
    const body = await readBodyPrefix(response);
    if (check.kind === "api") {
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw codedError("MIAOBI_HEALTH_FAILED"); }
      if (
        response.status !== 404 ||
        response.headers.get("X-Magic-Resume-Faas") !== "magic-resume-api" ||
        response.headers.get("X-Magic-Resume-Build") !== check.apiBuildMarker ||
        typeof payload !== "object" || payload === null ||
        (payload as { code?: unknown }).code !== "notFound"
      ) throw codedError("MIAOBI_HEALTH_FAILED");
      return;
    }
    const runtime = webRuntimeFrom(body);
    if (
      response.status !== 200 ||
      response.headers.get("X-Magic-Resume-Faas") !== "magic-resume-web" ||
      runtime?.platform !== "miaobi" || runtime.apiFunctionUrl !== check.apiFaasUrl ||
      runtime.assetBaseUrl !== check.assetBaseUrl
    ) throw codedError("MIAOBI_HEALTH_FAILED");
  } catch {
    throw codedError("MIAOBI_HEALTH_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHealthWithOwnership(lock: StateLock, check: HealthCheck): Promise<void> {
  await lock.assertOwnership();
  try {
    await checkHealth(check);
    await lock.assertOwnership();
  } catch (error) {
    await lock.assertOwnership();
    throw error;
  }
}

function pageHtml(webFaasUrl: string, webFaasId: string, platformOrigin: string): string {
  const safeUrl = validatePublishedUrl(webFaasUrl, `/api/faas/${validateResourceId(webFaasId)}`, platformOrigin);
  const scriptUrl = JSON.stringify(safeUrl).replace(/</g, "\\u003c");
  const linkUrl = safeUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><script>location.replace(${scriptUrl})</script><a href="${linkUrl}">打开魔方简历</a>`;
}

async function safeRemoveStaged(state: TrustedStorage, path: string): Promise<void> {
  try {
    await assertStorageIdentity(state);
    if (dirname(path) !== state.directory) return;
    await rm(path, { force: true });
  } catch {
    // Never follow a replaced directory or remove a path outside the captured storage.
  }
}

async function readApiBuildMetadata(outputDirectory: string, gitCommit: string): Promise<ApiBuildMetadata> {
  try {
    const bundle = await readFile(resolve(outputDirectory, "api-faas.cjs"));
    const value = JSON.parse(await readFile(resolve(outputDirectory, "api-faas.meta.json"), "utf8")) as ApiBuildMetadata;
    if (
      value.schemaVersion !== 1 || value.gitCommit !== gitCommit ||
      BUILD_MARKER_PATTERN.exec(value.buildMarker)?.[1] !== gitCommit ||
      !HASH_PATTERN.test(value.bundleSha256) ||
      value.bundleSha256 !== createHash("sha256").update(bundle).digest("hex")
    ) throw new Error();
    return value;
  } catch {
    throw codedError("MIAOBI_BUILD_METADATA_INVALID");
  }
}

async function publishPage(runner: MagicBuilderRunner, pagePath: string, platformOrigin: string): Promise<void> {
  validatePagePublishResponse(await runMagicBuilderObject(runner, [
    "page", "publish", pagePath,
    "--title", deployConfig.title,
    "--id", deployConfig.pageId,
    "--format", "json",
    "--quiet",
  ]), platformOrigin);
}

export type DeploymentTransactionEvent = {
  point: "before-pending-commit" | "before-page-inflight" | "before-page-confirmation" | "before-state-commit" | "before-pending-cleanup";
  generation: number;
  ownerToken: string;
};

type DeploymentTransactionHook = (event: DeploymentTransactionEvent) => Promise<void>;

async function transactionPoint(
  hook: DeploymentTransactionHook | undefined,
  point: DeploymentTransactionEvent["point"],
  lock: StateLock,
): Promise<void> {
  await hook?.({ point, generation: lock.generation, ownerToken: lock.ownerToken });
}

async function recoverConfirmedPage(
  state: TrustedState,
  recovery: TrustedRecovery,
  platformOrigin: string,
  gitCommit: string,
  lock: StateLock,
  hook?: DeploymentTransactionHook,
): Promise<MiaobiDeploymentState | undefined> {
  const inflight = await pagePhaseRecords(recovery.pageInflight, "page-inflight", platformOrigin);
  const confirmed = await pagePhaseRecords(recovery.pageConfirmed, "page-confirmed", platformOrigin);
  for (const record of confirmed) {
    const matchingInflight = inflight.find((candidate) => (
      candidate.generation === record.generation && candidate.ownerToken === record.ownerToken
    ));
    if (!matchingInflight || !samePendingSemantics(matchingInflight.pending, record.pending) ||
      matchingInflight.resolvedGeneration !== record.resolvedGeneration ||
      matchingInflight.resolvedOwnerToken !== record.resolvedOwnerToken) {
      throw codedError("MIAOBI_PENDING_INVALID");
    }
  }
  const uncertain = inflight.filter((record) => !confirmed.some((candidate) => (
    candidate.generation === record.generation && candidate.ownerToken === record.ownerToken
  )));
  if (uncertain.length > 0) throw codedError("MIAOBI_PAGE_RESULT_UNCERTAIN");

  const committed = await generationStates(state, platformOrigin);
  const unresolved = confirmed.filter((record) => !committed.some((candidate) => (
    candidate.resolvedGeneration === record.resolvedGeneration &&
    candidate.resolvedOwnerToken === record.resolvedOwnerToken &&
    sameDeploymentSemantics(candidate.deployment, record.pending.deployment)
  )));
  if (unresolved.length > 1) throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
  const record = unresolved[0];
  if (!record) return undefined;
  if (markerCommit(record.pending.apiBuildMarker) !== gitCommit) throw codedError("MIAOBI_PENDING_INVALID");
  await lock.assertOwnership();
  await transactionPoint(hook, "before-state-commit", lock);
  await lock.assertOwnership();
  await commitGenerationState(state, lock, record.pending.deployment, {
    generation: record.resolvedGeneration,
    ownerToken: record.resolvedOwnerToken,
  });
  return record.pending.deployment;
}

async function reconcilePending(
  record: GenerationPendingRecord,
  state: TrustedState,
  recovery: TrustedRecovery,
  runner: MagicBuilderRunner,
  platformOrigin: string,
  lock: StateLock,
  hook?: DeploymentTransactionHook,
): Promise<MiaobiDeploymentState> {
  const pending = record.pending;
  const canonicalPage = pageHtml(
    pending.deployment.webFaasUrl,
    pending.deployment.webFaasId,
    pending.platformOrigin,
  );
  const canonicalHash = createHash("sha256").update(canonicalPage).digest("hex");
  if (canonicalHash !== pending.page.sha256) throw codedError("MIAOBI_PENDING_INVALID");
  await assertStorageIdentity(recovery);
  const temporaryPage = join(
    recovery.directory,
    `page-${lock.generation}-${lock.ownerToken}-${randomUUID()}.html`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(canonicalPage, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await transactionPoint(hook, "before-page-inflight", lock);
    await publishPagePhase(recovery.pageInflight, "page-inflight", lock, pending, record);
    await publishPage(runner, temporaryPage, platformOrigin);
    await lock.assertOwnership();
    await transactionPoint(hook, "before-page-confirmation", lock);
    await publishPagePhase(recovery.pageConfirmed, "page-confirmed", lock, pending, record);
    await transactionPoint(hook, "before-state-commit", lock);
    await lock.assertOwnership();
    await commitGenerationState(state, lock, pending.deployment, record);
    await transactionPoint(hook, "before-pending-cleanup", lock);
    await lock.assertOwnership();
    if (!record.legacyAnchor && record.generation === lock.generation && record.ownerToken === lock.ownerToken) {
      await safeRemoveStaged(recovery.pending, record.path);
    }
    return pending.deployment;
  } finally {
    await handle?.close().catch(() => undefined);
    await safeRemoveStaged(recovery, temporaryPage);
  }
}

export async function deployMiaobi(options: {
  runner: MagicBuilderRunner;
  gitCommit: string;
  now: Date;
  fetch?: typeof globalThis.fetch;
  healthTimeoutMs?: number;
  lockClock?: StateLockClock;
  transactionHook?: DeploymentTransactionHook;
}): Promise<MiaobiDeploymentState> {
  let stateLock: StateLock | undefined;
  try {
    const platformOrigin = resolveMagicPlatformOrigin(options.runner.platformOrigin);
    const { outputDirectory, legacyStatePath, legacyPendingPath, legacyExternalPendingPath } = deploymentPaths();
    const stateStorage = await trustedState(legacyStatePath);
    const recoveryStorage = await trustedRecovery(legacyExternalPendingPath, legacyPendingPath);
    stateLock = await acquireStateLock(recoveryStorage, stateStorage, options.lockClock ?? systemLockClock);
    const runner = fencedRunner(options.runner, stateLock);

    const recoveredConfirmation = await recoverConfirmedPage(
      stateStorage,
      recoveryStorage,
      platformOrigin,
      options.gitCommit,
      stateLock,
      options.transactionHook,
    );
    if (recoveredConfirmation) return recoveredConfirmation;

    const pendingRecord = await pendingState(
      stateStorage,
      recoveryStorage,
      platformOrigin,
      outputDirectory,
      options.gitCommit,
      stateLock,
    );
    if (pendingRecord) {
      if (markerCommit(pendingRecord.pending.apiBuildMarker) !== options.gitCommit) {
        throw codedError("MIAOBI_PENDING_INVALID");
      }
      return await reconcilePending(
        pendingRecord,
        stateStorage,
        recoveryStorage,
        runner,
        platformOrigin,
        stateLock,
        options.transactionHook,
      );
    }

    const previous = await priorState(stateStorage, platformOrigin);
    const apiMetadata = await readApiBuildMetadata(outputDirectory, options.gitCommit);
    const releaseId = createReleaseId(options.gitCommit, options.now);
    await stateLock.assertOwnership();
    const manifest = await publishAssets({
      directory: resolve(outputDirectory, "client/assets"),
      releaseId,
      runner,
    });
    await stateLock.assertOwnership();
    const api = await publishFaas(
      runner,
      resolve(outputDirectory, "api-faas.cjs"),
      "magic-resume-api",
      platformOrigin,
      previous?.apiFaasId,
    );
    const shell = (await readFile(resolve(outputDirectory, "client/index.html"), "utf8"))
      .replaceAll(MIAOBI_ASSET_BASE_PLACEHOLDER, manifest.baseUrl);
    const html = injectMiaobiRuntime(shell, {
      platform: "miaobi",
      apiFunctionUrl: api.url,
      assetBaseUrl: manifest.baseUrl,
    });
    const webBundlePath = await buildWebFaas(html, outputDirectory);
    const web = await publishFaas(
      runner,
      webBundlePath,
      "magic-resume-web",
      platformOrigin,
      previous?.webFaasId,
    );
    const health = {
      apiFaasUrl: api.url,
      assetBaseUrl: manifest.baseUrl,
      apiBuildMarker: apiMetadata.buildMarker,
      fetch: options.fetch ?? globalThis.fetch,
      timeoutMs: options.healthTimeoutMs ?? 10_000,
    };
    await checkHealthWithOwnership(stateLock, { ...health, url: api.url, kind: "api" });
    await checkHealthWithOwnership(stateLock, { ...health, url: web.url, kind: "web" });

    const pagePath = resolve(outputDirectory, "page.html");
    await writeFile(pagePath, pageHtml(web.url, web.id, platformOrigin), { encoding: "utf8", mode: 0o600 });
    const deployment: MiaobiDeploymentState = {
      schemaVersion: 2,
      apiBuildMarker: apiMetadata.buildMarker,
      releaseId,
      apiFaasId: api.id,
      apiFaasUrl: api.url,
      webFaasId: web.id,
      webFaasUrl: web.url,
      pageId: deployConfig.pageId,
      deployedAt: options.now.toISOString(),
    };
    const pendingDeployment: PendingDeployment = {
      schemaVersion: 3,
      status: "pending-page-commit",
      phase: "prepared",
      platformOrigin,
      apiBuildMarker: apiMetadata.buildMarker,
      deployment,
      page: {
        id: deployConfig.pageId,
        artifactPath: "dist/miaobi/page.html",
        sha256: createHash("sha256").update(await readFile(pagePath)).digest("hex"),
      },
    };
    const pendingPath = join(
      recoveryStorage.pending.directory,
      generationFileName(stateLock.generation, stateLock.ownerToken),
    );
    const ownerPendingRecord: Omit<GenerationPendingRecord, "path"> = {
      schemaVersion: 1,
      generation: stateLock.generation,
      ownerToken: stateLock.ownerToken,
      legacyAnchor: false,
      pending: pendingDeployment,
    };
    await stateLock.assertOwnership();
    await transactionPoint(options.transactionHook, "before-pending-commit", stateLock);
    await immutableJson(recoveryStorage.pending, pendingPath, stateLock.ownerToken, ownerPendingRecord);
    await transactionPoint(options.transactionHook, "before-page-inflight", stateLock);
    await publishPagePhase(
      recoveryStorage.pageInflight,
      "page-inflight",
      stateLock,
      pendingDeployment,
      stateLock,
    );
    await publishPage(runner, pagePath, platformOrigin);
    await stateLock.assertOwnership();
    await transactionPoint(options.transactionHook, "before-page-confirmation", stateLock);
    await publishPagePhase(
      recoveryStorage.pageConfirmed,
      "page-confirmed",
      stateLock,
      pendingDeployment,
      stateLock,
    );
    await transactionPoint(options.transactionHook, "before-state-commit", stateLock);
    await stateLock.assertOwnership();
    await commitGenerationState(stateStorage, stateLock, deployment);
    await transactionPoint(options.transactionHook, "before-pending-cleanup", stateLock);
    await stateLock.assertOwnership();
    await safeRemoveStaged(recoveryStorage.pending, pendingPath);
    return deployment;
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("MIAOBI_")) throw error;
    throw codedError("MIAOBI_DEPLOY_FAILED");
  } finally {
    await stateLock?.release();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const gitCommit = process.env.MIAOBI_GIT_COMMIT;
  if (!gitCommit) {
    console.error("MIAOBI_GIT_COMMIT_REQUIRED");
    process.exitCode = 1;
  } else {
    try {
      const runner = createMagicBuilderRunner({
        authEnv: { MAGIC_TOKEN: process.env.MAGIC_TOKEN, MAGIC_BASE_URL: process.env.MAGIC_BASE_URL },
      });
      void deployMiaobi({ runner, gitCommit, now: new Date() })
        .then((state) => process.stdout.write(`${state.releaseId}\n`))
        .catch((error: unknown) => {
          console.error((error as { code?: string }).code ?? "MIAOBI_DEPLOY_FAILED");
          process.exitCode = 1;
        });
    } catch (error) {
      console.error((error as { code?: string }).code ?? "MIAOBI_DEPLOY_FAILED");
      process.exitCode = 1;
    }
  }
}

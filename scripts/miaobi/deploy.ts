import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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

type PendingDeployment = {
  schemaVersion: 2;
  status: "pending-page-commit";
  platformOrigin: string;
  apiBuildMarker: string;
  deployment: MiaobiDeploymentState;
  page: { id: string; artifactPath: "dist/miaobi/page.html"; sha256: string };
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
  path: string;
};

type TrustedRecovery = TrustedStorage & {
  pendingPath: string;
  legacyPendingPath: string;
  lockPath: string;
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

function deploymentPaths() {
  return {
    outputDirectory: resolve("dist/miaobi"),
    statePath: resolve(".miaobi/deployment.json"),
    legacyPendingPath: resolve(".miaobi/deployment.pending.json"),
    recoveryPath: resolve(".miaobi-recovery/deployment.pending.json"),
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
  return {
    ...storage,
    path: statePath,
  };
}

async function trustedRecovery(recoveryPath: string, legacyPendingPath: string): Promise<TrustedRecovery> {
  const storage = await trustedStorage(dirname(recoveryPath));
  return {
    ...storage,
    pendingPath: recoveryPath,
    legacyPendingPath,
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

async function acquireStateLock(state: TrustedRecovery): Promise<() => Promise<void>> {
  await assertStorageIdentity(state);
  const token = randomUUID().replaceAll("-", "");
  const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
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
      return async () => {
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
      const ageMs = Date.now() - metadata.mtimeMs;
      if (ageMs < LOCK_GRACE_MS) throw codedError("MIAOBI_STATE_LOCKED");
      let stale = false;
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
        if (existing.pid === process.pid) {
          const actualProcessStart = Date.now() - process.uptime() * 1000;
          stale = Math.abs(recordedProcessStart - actualProcessStart) > 5_000;
        }
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
      if (beforeRemove.dev !== metadata.dev || beforeRemove.ino !== metadata.ino) {
        throw codedError("MIAOBI_STATE_LOCKED");
      }
      await rm(state.lockPath);
    }
  }
  throw codedError("MIAOBI_STATE_LOCKED");
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

async function priorState(state: TrustedState, platformOrigin: string) {
  await assertStorageIdentity(state);
  const value = await readJsonFile(state.path);
  return value === undefined ? undefined : parseDeploymentState(value, platformOrigin);
}

function parsePending(value: unknown, platformOrigin: string): PendingDeployment {
  try {
    const pending = value as PendingDeployment;
    const keys = pending && typeof pending === "object" ? Object.keys(pending).sort() : [];
    const pageKeys = pending?.page && typeof pending.page === "object"
      ? Object.keys(pending.page).sort()
      : [];
    if (
      !pending || typeof pending !== "object" ||
      JSON.stringify(keys) !== JSON.stringify(["apiBuildMarker", "deployment", "page", "platformOrigin", "schemaVersion", "status"].sort()) ||
      JSON.stringify(pageKeys) !== JSON.stringify(["artifactPath", "id", "sha256"].sort()) ||
      pending.schemaVersion !== 2 ||
      pending.status !== "pending-page-commit" || pending.platformOrigin !== platformOrigin ||
      !BUILD_MARKER_PATTERN.test(pending.apiBuildMarker) ||
      pending.apiBuildMarker !== pending.deployment?.apiBuildMarker ||
      pending.page.id !== deployConfig.pageId ||
      pending.page.artifactPath !== "dist/miaobi/page.html" ||
      !HASH_PATTERN.test(pending.page.sha256)
    ) throw new Error();
    const deployment = parseDeploymentState(pending.deployment, platformOrigin);
    if (deployment.schemaVersion !== 2) throw new Error();
    return pending;
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
      schemaVersion: 2,
      status: "pending-page-commit",
      platformOrigin,
      apiBuildMarker: buildMarker,
      deployment,
      page: pending.page,
    };
  } catch {
    throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
  }
}

async function pendingState(
  state: TrustedState,
  recovery: TrustedRecovery,
  platformOrigin: string,
  outputDirectory: string,
  gitCommit: string,
): Promise<{ pending: PendingDeployment; sourcePath: string; sourceStorage: TrustedStorage } | undefined> {
  await assertStorageIdentity(recovery);
  const current = await readJsonFile(recovery.pendingPath);
  if (current !== undefined) {
    if ((current as { schemaVersion?: unknown }).schemaVersion === 2) {
      return {
        pending: parsePending(current, platformOrigin),
        sourcePath: recovery.pendingPath,
        sourceStorage: recovery,
      };
    }
    try {
      const metadata = await readApiBuildMetadata(outputDirectory, gitCommit);
      return {
        pending: migrateLegacyPending(current, platformOrigin, metadata.buildMarker),
        sourcePath: recovery.pendingPath,
        sourceStorage: recovery,
      };
    } catch {
      throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
    }
  }
  await assertStorageIdentity(state);
  const legacy = await readJsonFile(recovery.legacyPendingPath);
  if (legacy === undefined) return undefined;
  try {
    const metadata = await readApiBuildMetadata(outputDirectory, gitCommit);
    return {
      pending: migrateLegacyPending(legacy, platformOrigin, metadata.buildMarker),
      sourcePath: recovery.legacyPendingPath,
      sourceStorage: state,
    };
  } catch {
    throw codedError("MIAOBI_PENDING_RECOVERY_REQUIRED");
  }
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

function pageHtml(webFaasUrl: string, webFaasId: string, platformOrigin: string): string {
  const safeUrl = validatePublishedUrl(webFaasUrl, `/api/faas/${validateResourceId(webFaasId)}`, platformOrigin);
  const scriptUrl = JSON.stringify(safeUrl).replace(/</g, "\\u003c");
  const linkUrl = safeUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><script>location.replace(${scriptUrl})</script><a href="${linkUrl}">打开魔方简历</a>`;
}

async function stageJson(state: TrustedStorage, targetPath: string, value: unknown): Promise<string> {
  await assertStorageIdentity(state);
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    return temporaryPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function commitStaged(temporaryPath: string, targetPath: string, state: TrustedStorage): Promise<void> {
  try {
    await assertStorageIdentity(state);
    const metadata = await lstat(temporaryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== state.device) throw new Error();
    await rename(temporaryPath, targetPath);
    await assertStorageIdentity(state);
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  }
}

async function safeRemoveStaged(state: TrustedStorage, path: string): Promise<void> {
  try {
    await assertStorageIdentity(state);
    await rm(path, { force: true });
  } catch {
    // A changed directory identity is a fail-closed condition; never follow the replacement path.
  }
}

async function writeAtomicJson(state: TrustedStorage, targetPath: string, value: unknown): Promise<void> {
  const staged = await stageJson(state, targetPath, value);
  try { await commitStaged(staged, targetPath, state); } finally {
    await safeRemoveStaged(state, staged);
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

async function reconcilePending(
  pending: PendingDeployment,
  pendingSourcePath: string,
  pendingSourceStorage: TrustedStorage,
  state: TrustedState,
  recovery: TrustedRecovery,
  runner: MagicBuilderRunner,
  platformOrigin: string,
): Promise<MiaobiDeploymentState> {
  const canonicalPage = pageHtml(
    pending.deployment.webFaasUrl,
    pending.deployment.webFaasId,
    pending.platformOrigin,
  );
  const canonicalHash = createHash("sha256").update(canonicalPage).digest("hex");
  if (canonicalHash !== pending.page.sha256) throw codedError("MIAOBI_PENDING_INVALID");
  await assertStorageIdentity(recovery);
  const temporaryPage = join(recovery.directory, `page-${randomUUID()}.html`);
  let handle;
  try {
    handle = await open(
      temporaryPage,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(canonicalPage, "utf8");
    await handle.close();
    handle = undefined;
    await assertStorageIdentity(recovery);
    await publishPage(runner, temporaryPage, platformOrigin);
    await writeAtomicJson(state, state.path, pending.deployment);
    await assertStorageIdentity(pendingSourceStorage);
    await rm(pendingSourcePath, { force: true });
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
}): Promise<MiaobiDeploymentState> {
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const platformOrigin = resolveMagicPlatformOrigin(options.runner.platformOrigin);
    const { outputDirectory, statePath, legacyPendingPath, recoveryPath } = deploymentPaths();
    const stateStorage = await trustedState(statePath);
    const recoveryStorage = await trustedRecovery(recoveryPath, legacyPendingPath);
    releaseLock = await acquireStateLock(recoveryStorage);

    const pendingRecord = await pendingState(
      stateStorage,
      recoveryStorage,
      platformOrigin,
      outputDirectory,
      options.gitCommit,
    );
    if (pendingRecord) {
      if (markerCommit(pendingRecord.pending.apiBuildMarker) !== options.gitCommit) {
        throw codedError("MIAOBI_PENDING_INVALID");
      }
      return await reconcilePending(
        pendingRecord.pending,
        pendingRecord.sourcePath,
        pendingRecord.sourceStorage,
        stateStorage,
        recoveryStorage,
        options.runner,
        platformOrigin,
      );
    }

    const previous = await priorState(stateStorage, platformOrigin);
    const apiMetadata = await readApiBuildMetadata(outputDirectory, options.gitCommit);
    const releaseId = createReleaseId(options.gitCommit, options.now);
    const manifest = await publishAssets({
      directory: resolve(outputDirectory, "client/assets"),
      releaseId,
      runner: options.runner,
    });
    const api = await publishFaas(
      options.runner,
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
      options.runner,
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
    await checkHealth({ ...health, url: api.url, kind: "api" });
    await checkHealth({ ...health, url: web.url, kind: "web" });

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
      schemaVersion: 2,
      status: "pending-page-commit",
      platformOrigin,
      apiBuildMarker: apiMetadata.buildMarker,
      deployment,
      page: {
        id: deployConfig.pageId,
        artifactPath: "dist/miaobi/page.html",
        sha256: createHash("sha256").update(await readFile(pagePath)).digest("hex"),
      },
    };
    const stagedStatePath = await stageJson(stateStorage, stateStorage.path, deployment);
    await writeAtomicJson(recoveryStorage, recoveryStorage.pendingPath, pendingDeployment);
    try {
      await publishPage(options.runner, pagePath, platformOrigin);
      await commitStaged(stagedStatePath, stateStorage.path, stateStorage);
      await assertStorageIdentity(recoveryStorage);
      await rm(recoveryStorage.pendingPath, { force: true });
    } finally {
      await safeRemoveStaged(stateStorage, stagedStatePath);
    }
    return deployment;
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("MIAOBI_")) throw error;
    throw codedError("MIAOBI_DEPLOY_FAILED");
  } finally {
    await releaseLock?.();
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

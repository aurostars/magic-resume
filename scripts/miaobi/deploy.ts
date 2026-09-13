import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export interface MiaobiDeploymentState {
  schemaVersion: 1;
  releaseId: string;
  apiFaasId: string;
  apiFaasUrl: string;
  webFaasId: string;
  webFaasUrl: string;
  pageId: string;
  deployedAt: string;
}

type PendingDeployment = {
  schemaVersion: 1;
  status: "pending-page-commit";
  platformOrigin: string;
  deployment: MiaobiDeploymentState;
  page: { id: string; artifactPath: "dist/miaobi/page.html"; sha256: string };
};

type TrustedState = {
  directory: string;
  path: string;
  pendingPath: string;
  lockPath: string;
  device: number;
  inode: number;
};

type ApiBuildMetadata = {
  schemaVersion: 1;
  buildMarker: string;
  bundleSha256: string;
};

const deployConfig = config as MiaobiDeployConfig;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BUILD_MARKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function deploymentPaths() {
  return {
    outputDirectory: resolve("dist/miaobi"),
    statePath: resolve(".miaobi/deployment.json"),
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

async function trustedState(statePath: string): Promise<TrustedState> {
  const directory = dirname(statePath);
  await rejectSymlinkAncestors(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw codedError("MIAOBI_STATE_FAILED");
  await chmod(directory, 0o700);
  return {
    directory,
    path: statePath,
    pendingPath: join(directory, "deployment.pending.json"),
    lockPath: join(directory, "deployment.lock"),
    device: metadata.dev,
    inode: metadata.ino,
  };
}

async function assertStateIdentity(state: TrustedState): Promise<void> {
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

async function acquireStateLock(state: TrustedState): Promise<() => Promise<void>> {
  await assertStateIdentity(state);
  const ownerPath = join(state.lockPath, "owner.json");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(state.lockPath, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: "wx" });
      await assertStateIdentity(state);
      return async () => {
        try {
          await assertStateIdentity(state);
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
          if (owner.token === token) await rm(state.lockPath, { recursive: true, force: true });
        } catch {
          // Identity/ownership changed: do not remove another process' lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        throw codedError("MIAOBI_STATE_LOCKED");
      }
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
        if (typeof owner.pid !== "number" || owner.pid <= 0) throw new Error();
        try {
          process.kill(owner.pid, 0);
          throw codedError("MIAOBI_STATE_LOCKED");
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        }
        await assertStateIdentity(state);
        await rm(state.lockPath, { recursive: true });
      } catch (staleError) {
        if ((staleError as { code?: string }).code === "MIAOBI_STATE_LOCKED") throw staleError;
        throw codedError("MIAOBI_STATE_LOCKED");
      }
    }
  }
  throw codedError("MIAOBI_STATE_LOCKED");
}

function parseDeploymentState(value: unknown, platformOrigin: string): MiaobiDeploymentState {
  const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
  const expectedKeys = [
    "apiFaasId", "apiFaasUrl", "deployedAt", "pageId", "releaseId",
    "schemaVersion", "webFaasId", "webFaasUrl",
  ].sort();
  if (
    typeof value !== "object" || value === null ||
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (value as { pageId?: unknown }).pageId !== deployConfig.pageId ||
    typeof (value as { releaseId?: unknown }).releaseId !== "string" ||
    !/^[0-9a-f]{12}-\d{14}$/.test((value as { releaseId: string }).releaseId) ||
    typeof (value as { deployedAt?: unknown }).deployedAt !== "string"
  ) throw codedError("MIAOBI_STATE_FAILED");
  const deployment = value as MiaobiDeploymentState;
  try {
    if (new Date(deployment.deployedAt).toISOString() !== deployment.deployedAt) throw new Error();
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
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  }
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
  await assertStateIdentity(state);
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
      JSON.stringify(keys) !== JSON.stringify(["deployment", "page", "platformOrigin", "schemaVersion", "status"].sort()) ||
      JSON.stringify(pageKeys) !== JSON.stringify(["artifactPath", "id", "sha256"].sort()) ||
      pending.schemaVersion !== 1 ||
      pending.status !== "pending-page-commit" || pending.platformOrigin !== platformOrigin ||
      !pending.page || pending.page.id !== deployConfig.pageId ||
      pending.page.artifactPath !== "dist/miaobi/page.html" ||
      !HASH_PATTERN.test(pending.page.sha256)
    ) throw new Error();
    parseDeploymentState(pending.deployment, platformOrigin);
    return pending;
  } catch {
    throw codedError("MIAOBI_PENDING_INVALID");
  }
}

async function pendingState(state: TrustedState, platformOrigin: string) {
  await assertStateIdentity(state);
  const value = await readJsonFile(state.pendingPath);
  return value === undefined ? undefined : parsePending(value, platformOrigin);
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

async function stageJson(state: TrustedState, targetPath: string, value: unknown): Promise<string> {
  await assertStateIdentity(state);
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

async function commitStaged(temporaryPath: string, targetPath: string, state: TrustedState): Promise<void> {
  try {
    await assertStateIdentity(state);
    const metadata = await lstat(temporaryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== state.device) throw new Error();
    await rename(temporaryPath, targetPath);
    await assertStateIdentity(state);
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  }
}

async function safeRemoveStaged(state: TrustedState, path: string): Promise<void> {
  try {
    await assertStateIdentity(state);
    await rm(path, { force: true });
  } catch {
    // A changed directory identity is a fail-closed condition; never follow the replacement path.
  }
}

async function writeAtomicJson(state: TrustedState, targetPath: string, value: unknown): Promise<void> {
  const staged = await stageJson(state, targetPath, value);
  try { await commitStaged(staged, targetPath, state); } finally {
    await safeRemoveStaged(state, staged);
  }
}

async function readApiBuildMetadata(outputDirectory: string): Promise<ApiBuildMetadata> {
  try {
    const bundle = await readFile(resolve(outputDirectory, "api-faas.cjs"));
    const value = JSON.parse(await readFile(resolve(outputDirectory, "api-faas.meta.json"), "utf8")) as ApiBuildMetadata;
    if (
      value.schemaVersion !== 1 || !BUILD_MARKER_PATTERN.test(value.buildMarker) ||
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
  state: TrustedState,
  runner: MagicBuilderRunner,
  platformOrigin: string,
): Promise<MiaobiDeploymentState> {
  const artifactPath = resolve(pending.page.artifactPath);
  if (artifactPath !== resolve("dist/miaobi/page.html")) throw codedError("MIAOBI_PENDING_INVALID");
  let hash: string;
  try { hash = createHash("sha256").update(await readFile(artifactPath)).digest("hex"); } catch {
    throw codedError("MIAOBI_PENDING_INVALID");
  }
  if (hash !== pending.page.sha256) throw codedError("MIAOBI_PENDING_INVALID");
  await assertStateIdentity(state);
  await publishPage(runner, artifactPath, platformOrigin);
  await writeAtomicJson(state, state.path, pending.deployment);
  await assertStateIdentity(state);
  await rm(state.pendingPath, { force: true });
  return pending.deployment;
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
    const { outputDirectory, statePath } = deploymentPaths();
    const stateStorage = await trustedState(statePath);
    releaseLock = await acquireStateLock(stateStorage);

    const pending = await pendingState(stateStorage, platformOrigin);
    if (pending) return await reconcilePending(pending, stateStorage, options.runner, platformOrigin);

    const previous = await priorState(stateStorage, platformOrigin);
    const apiMetadata = await readApiBuildMetadata(outputDirectory);
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
      schemaVersion: 1,
      releaseId,
      apiFaasId: api.id,
      apiFaasUrl: api.url,
      webFaasId: web.id,
      webFaasUrl: web.url,
      pageId: deployConfig.pageId,
      deployedAt: options.now.toISOString(),
    };
    const pendingDeployment: PendingDeployment = {
      schemaVersion: 1,
      status: "pending-page-commit",
      platformOrigin,
      deployment,
      page: {
        id: deployConfig.pageId,
        artifactPath: "dist/miaobi/page.html",
        sha256: createHash("sha256").update(await readFile(pagePath)).digest("hex"),
      },
    };
    const stagedStatePath = await stageJson(stateStorage, stateStorage.path, deployment);
    await writeAtomicJson(stateStorage, stateStorage.pendingPath, pendingDeployment);
    try {
      await publishPage(options.runner, pagePath, platformOrigin);
      await commitStaged(stagedStatePath, stateStorage.path, stateStorage);
      await rm(stateStorage.pendingPath, { force: true });
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

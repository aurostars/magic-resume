import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import config from "../../miaobi.config.json" with { type: "json" };
import { injectMiaobiRuntime } from "../../miaobi/runtime-config";
import { MIAOBI_ASSET_BASE_PLACEHOLDER } from "../../vite.miaobi.config";
import { buildWebFaas } from "./build-web-faas";
import { createMagicBuilderRunner, MagicBuilderError, runMagicBuilderObject } from "./magic-builder";
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

const deployConfig = config as MiaobiDeployConfig;

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

const PLATFORM_ORIGIN = "https://magic.solutionsuite.cn";
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validateResourceId(value: unknown): string {
  if (typeof value !== "string" || !RESOURCE_ID_PATTERN.test(value)) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  return value;
}

function validatePublishedUrl(value: string, expectedPath: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin !== PLATFORM_ORIGIN || url.username || url.password ||
      url.pathname !== expectedPath || url.search || url.hash
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
}

type TrustedState = {
  directory: string;
  path: string;
  device: number;
  inode: number;
};

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
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw codedError("MIAOBI_STATE_FAILED");
  }
  await chmod(directory, 0o700);
  return { directory, path: statePath, device: metadata.dev, inode: metadata.ino };
}

async function assertStateIdentity(state: TrustedState): Promise<void> {
  try {
    const metadata = await lstat(state.directory);
    if (
      metadata.isSymbolicLink() || !metadata.isDirectory() ||
      metadata.dev !== state.device || metadata.ino !== state.inode
    ) {
      throw new Error();
    }
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  }
}

function parsePriorState(value: unknown): MiaobiDeploymentState {
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
  ) {
    throw codedError("MIAOBI_STATE_FAILED");
  }
  const state = value as MiaobiDeploymentState;
  if (new Date(state.deployedAt).toISOString() !== state.deployedAt) {
    throw codedError("MIAOBI_STATE_FAILED");
  }
  try {
    validatePublishedUrl(state.apiFaasUrl, `/api/faas/${validateResourceId(state.apiFaasId)}`);
    validatePublishedUrl(state.webFaasUrl, `/api/faas/${validateResourceId(state.webFaasId)}`);
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  }
  return state;
}

async function priorState(state: TrustedState): Promise<MiaobiDeploymentState | undefined> {
  await assertStateIdentity(state);
  let handle;
  try {
    handle = await open(state.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw codedError("MIAOBI_STATE_FAILED");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw codedError("MIAOBI_STATE_FAILED");
    return parsePriorState(JSON.parse(await handle.readFile("utf8")));
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  } finally {
    await handle.close();
  }
}

function parseFaasPublishResponse(value: unknown): { id: string; url: string } {
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { faas_url?: unknown }).faas_url !== "string"
  ) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  const id = validateResourceId((value as { id?: unknown }).id);
  return {
    id,
    url: validatePublishedUrl(
      (value as { faas_url: string }).faas_url,
      `/api/faas/${id}`,
    ),
  };
}

function validatePagePublishResponse(value: unknown): void {
  if (
    typeof value !== "object" || value === null ||
    (value as { id?: unknown }).id !== deployConfig.pageId ||
    typeof (value as { html_box_url?: unknown }).html_box_url !== "string"
  ) {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
  validatePublishedUrl(
    (value as { html_box_url: string }).html_box_url,
    `/html-box/${deployConfig.pageId}`,
  );
}

async function publishFaas(
  runner: MagicBuilderRunner,
  bundlePath: string,
  name: string,
  existingId?: string,
): Promise<{ id: string; url: string }> {
  const selector = existingId
    ? ["--name", name, "--id", existingId]
    : ["--name", name];
  return parseFaasPublishResponse(await runMagicBuilderObject(runner, [
    "faas", "publish", bundlePath, ...selector, "--format", "json", "--quiet",
  ]));
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
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
};

type WebRuntimeMarker = {
  platform?: unknown;
  apiFunctionUrl?: unknown;
  assetBaseUrl?: unknown;
};

function webRuntimeFrom(body: string): WebRuntimeMarker | undefined {
  const match = body.match(/window\.__MAGIC_RESUME_RUNTIME__=(\{[^<]+\})<\/script>/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as WebRuntimeMarker;
  } catch {
    return undefined;
  }
}

async function checkHealth(check: HealthCheck): Promise<void> {
  const target = check.kind === "api"
    ? new URL("?__path=%2F__miaobi_health__", check.url).toString()
    : check.url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), check.timeoutMs);
  timeout.unref?.();
  try {
    const response = await check.fetch(target, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBodyPrefix(response);
    if (check.kind === "api") {
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw codedError("MIAOBI_HEALTH_FAILED");
      }
      if (
        response.status !== 404 ||
        response.headers.get("X-Magic-Resume-Faas") !== "magic-resume-api" ||
        typeof payload !== "object" || payload === null ||
        (payload as { code?: unknown }).code !== "notFound"
      ) {
        throw codedError("MIAOBI_HEALTH_FAILED");
      }
      return;
    }
    const runtime = webRuntimeFrom(body);
    if (
      response.status !== 200 ||
      response.headers.get("X-Magic-Resume-Faas") !== "magic-resume-web" ||
      runtime?.platform !== "miaobi" ||
      runtime.apiFunctionUrl !== check.apiFaasUrl ||
      runtime.assetBaseUrl !== check.assetBaseUrl
    ) {
      throw codedError("MIAOBI_HEALTH_FAILED");
    }
  } catch {
    throw codedError("MIAOBI_HEALTH_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

function pageHtml(webFaasUrl: string, webFaasId: string): string {
  const safeUrl = validatePublishedUrl(webFaasUrl, `/api/faas/${validateResourceId(webFaasId)}`);
  const scriptUrl = JSON.stringify(safeUrl).replace(/</g, "\\u003c");
  const linkUrl = safeUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><script>location.replace(${scriptUrl})</script><a href="${linkUrl}">打开魔方简历</a>`;
}

async function stageState(state: TrustedState, value: MiaobiDeploymentState): Promise<string> {
  await assertStateIdentity(state);
  const temporaryPath = `${state.path}.tmp-${randomUUID()}`;
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

async function commitState(
  temporaryPath: string,
  state: TrustedState,
): Promise<void> {
  try {
    await assertStateIdentity(state);
    const metadata = await lstat(temporaryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== state.device) {
      throw codedError("MIAOBI_STATE_FAILED");
    }
    await rename(temporaryPath, state.path);
  } catch {
    throw codedError("MIAOBI_STATE_FAILED");
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function deployMiaobi(options: {
  runner: MagicBuilderRunner;
  gitCommit: string;
  now: Date;
  fetch?: typeof globalThis.fetch;
  healthTimeoutMs?: number;
}): Promise<MiaobiDeploymentState> {
  try {
    const { outputDirectory, statePath } = deploymentPaths();
    const stateStorage = await trustedState(statePath);
    const previous = await priorState(stateStorage);
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
      previous?.webFaasId,
    );

    const health = {
      apiFaasUrl: api.url,
      assetBaseUrl: manifest.baseUrl,
      fetch: options.fetch ?? globalThis.fetch,
      timeoutMs: options.healthTimeoutMs ?? 10_000,
    };
    await checkHealth({ ...health, url: api.url, kind: "api" });
    await checkHealth({ ...health, url: web.url, kind: "web" });

    const pagePath = resolve(outputDirectory, "page.html");
    await writeFile(pagePath, pageHtml(web.url, web.id), { encoding: "utf8", mode: 0o600 });
    const state: MiaobiDeploymentState = {
      schemaVersion: 1,
      releaseId,
      apiFaasId: api.id,
      apiFaasUrl: api.url,
      webFaasId: web.id,
      webFaasUrl: web.url,
      pageId: deployConfig.pageId,
      deployedAt: options.now.toISOString(),
    };
    const stagedStatePath = await stageState(stateStorage, state);
    try {
      validatePagePublishResponse(await runMagicBuilderObject(options.runner, [
        "page", "publish", pagePath,
        "--title", deployConfig.title,
        "--id", deployConfig.pageId,
        "--format", "json",
        "--quiet",
      ]));
      await commitState(stagedStatePath, stateStorage);
    } finally {
      await rm(stagedStatePath, { force: true }).catch(() => undefined);
    }
    return state;
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith("MIAOBI_")) throw error;
    throw codedError("MIAOBI_DEPLOY_FAILED");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const gitCommit = process.env.MIAOBI_GIT_COMMIT;
  if (!gitCommit) {
    console.error("MIAOBI_GIT_COMMIT_REQUIRED");
    process.exitCode = 1;
  } else {
    void deployMiaobi({
      runner: createMagicBuilderRunner({
        authEnv: {
          MAGIC_TOKEN: process.env.MAGIC_TOKEN,
          MAGIC_BASE_URL: process.env.MAGIC_BASE_URL,
        },
      }),
      gitCommit,
      now: new Date(),
    }).then((state) => process.stdout.write(`${state.releaseId}\n`)).catch((error: unknown) => {
      console.error((error as { code?: string }).code ?? "MIAOBI_DEPLOY_FAILED");
      process.exitCode = 1;
    });
  }
}

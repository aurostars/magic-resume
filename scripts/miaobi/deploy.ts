import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import config from "../../miaobi.config.json" with { type: "json" };
import { injectMiaobiRuntime } from "../../miaobi/runtime-config";
import { MIAOBI_ASSET_BASE_PLACEHOLDER } from "../../vite.miaobi.config";
import { buildWebFaas } from "./build-web-faas";
import { createMagicBuilderRunner, MagicBuilderError, runMagicBuilderJson } from "./magic-builder";
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

function validatePublishedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new MagicBuilderError("MIAOBI_INVALID_RESPONSE");
  }
}

async function priorState(statePath: string): Promise<MiaobiDeploymentState | undefined> {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8")) as MiaobiDeploymentState;
    return value.schemaVersion === 1 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw codedError("MIAOBI_STATE_FAILED");
    throw error;
  }
}

async function publishFaas(
  runner: MagicBuilderRunner,
  bundlePath: string,
  name: string,
  existingId?: string,
): Promise<{ id: string; url: string }> {
  const selector = existingId ? ["--id", existingId] : ["--name", name];
  const result = await runMagicBuilderJson(runner, [
    "faas", "publish", bundlePath, ...selector, "--format", "json", "--quiet",
  ]);
  return { id: result.id, url: validatePublishedUrl(result.url) };
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

async function checkHealth(url: string, kind: "api" | "web"): Promise<void> {
  const target = kind === "api"
    ? new URL("?__path=%2F__miaobi_health__", url).toString()
    : url;
  let response: Response;
  try {
    response = await fetch(target, { method: "GET", redirect: "error" });
  } catch {
    throw codedError("MIAOBI_HEALTH_FAILED");
  }
  const body = await readBodyPrefix(response);
  const healthy = kind === "api"
    ? response.status === 404 && body.includes('"code":"notFound"')
    : response.status === 200 && body.includes("window.__MAGIC_RESUME_RUNTIME__");
  if (!healthy) throw codedError("MIAOBI_HEALTH_FAILED");
}

function pageHtml(webFaasUrl: string): string {
  const safeUrl = validatePublishedUrl(webFaasUrl);
  const scriptUrl = JSON.stringify(safeUrl).replace(/</g, "\\u003c");
  const linkUrl = safeUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><script>location.replace(${scriptUrl})</script><a href="${linkUrl}">打开魔方简历</a>`;
}

async function stageState(statePath: string, state: MiaobiDeploymentState): Promise<string> {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return temporaryPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function commitState(temporaryPath: string, statePath: string): Promise<void> {
  try {
    await rename(temporaryPath, statePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function deployMiaobi(options: {
  runner: MagicBuilderRunner;
  gitCommit: string;
  now: Date;
}): Promise<MiaobiDeploymentState> {
  try {
    const { outputDirectory, statePath } = deploymentPaths();
    const previous = await priorState(statePath);
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

    await checkHealth(api.url, "api");
    await checkHealth(web.url, "web");

    const pagePath = resolve(outputDirectory, "page.html");
    await writeFile(pagePath, pageHtml(web.url), { encoding: "utf8", mode: 0o600 });
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
    const stagedStatePath = await stageState(statePath, state);
    try {
      await runMagicBuilderJson(options.runner, [
        "page", "publish", pagePath,
        "--title", deployConfig.title,
        "--id", deployConfig.pageId,
        "--format", "json",
        "--quiet",
      ]);
      await commitState(stagedStatePath, statePath);
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

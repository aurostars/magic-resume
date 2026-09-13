import {
  createBrowserHistory,
  createHashHistory,
  type RouterHistory,
} from "@tanstack/react-router";

export interface MagicResumeRuntimeConfig {
  platform: "default" | "miaobi";
  apiFunctionUrl: string | null;
  assetBaseUrl: string | null;
}

declare global {
  interface Window {
    __MAGIC_RESUME_RUNTIME__?: MagicResumeRuntimeConfig;
  }
}

const DEFAULT_RUNTIME_CONFIG: MagicResumeRuntimeConfig = {
  platform: "default",
  apiFunctionUrl: null,
  assetBaseUrl: null,
};

const invalidRuntimeConfig = () =>
  new Error("Invalid runtime endpoint configuration");

function normalizeEndpoint(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalidRuntimeConfig();

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw invalidRuntimeConfig();
    url.hash = "";
    return url.toString();
  } catch {
    throw invalidRuntimeConfig();
  }
}

function isCloudflareWorkersHostname(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname.toLowerCase().replace(/\.+$/, "");
  return hostname === "workers.dev" || hostname.endsWith(".workers.dev");
}

export function getRuntimeConfig(): MagicResumeRuntimeConfig {
  if (typeof window === "undefined" || !window.__MAGIC_RESUME_RUNTIME__) {
    return { ...DEFAULT_RUNTIME_CONFIG };
  }

  const runtime = window.__MAGIC_RESUME_RUNTIME__ as unknown as Record<
    string,
    unknown
  >;
  if (runtime.platform !== "default" && runtime.platform !== "miaobi") {
    throw invalidRuntimeConfig();
  }

  const config: MagicResumeRuntimeConfig = {
    platform: runtime.platform,
    apiFunctionUrl: normalizeEndpoint(runtime.apiFunctionUrl),
    assetBaseUrl: normalizeEndpoint(runtime.assetBaseUrl),
  };
  if (
    config.platform === "miaobi" &&
    [config.apiFunctionUrl, config.assetBaseUrl].some(
      (endpoint) => endpoint !== null && isCloudflareWorkersHostname(endpoint)
    )
  ) {
    throw invalidRuntimeConfig();
  }
  return config;
}

export function getApiRequestUrl(path: `/api/${string}`): string {
  const { platform, apiFunctionUrl } = getRuntimeConfig();
  if (platform !== "miaobi") return path;
  if (apiFunctionUrl === null) throw invalidRuntimeConfig();

  const url = new URL(apiFunctionUrl);
  url.searchParams.set("__path", path);
  return url.toString();
}

export function getPublicAssetUrl(path: `/${string}`): string {
  const { platform, assetBaseUrl } = getRuntimeConfig();
  if (platform !== "miaobi" || assetBaseUrl === null) return path;

  const baseUrl = assetBaseUrl.endsWith("/") ? assetBaseUrl : `${assetBaseUrl}/`;
  return new URL(path.slice(1), baseUrl).toString();
}

export function createAppHistory(): RouterHistory {
  return getRuntimeConfig().platform === "miaobi"
    ? createHashHistory()
    : createBrowserHistory();
}

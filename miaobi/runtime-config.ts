export interface MiaobiRuntimeInjection {
  platform: "miaobi";
  apiFunctionUrl: string;
  assetBaseUrl: string;
}

export type MiaobiAssetMode = "github-pages" | "legacy-tos";

const PAGES_ORIGIN = "https://aurostars.github.io";
const PAGES_PREFIX = "/magic-resume/";
const API_ORIGIN = "https://magic.solutionsuite.cn";
const API_PATH_PATTERN = /^\/api\/faas\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BUILD_PLACEHOLDER = "https://miaobi.invalid/__ASSET_BASE__/";

export function assertGitHubPagesAssetBaseUrlValue(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin !== PAGES_ORIGIN || url.username || url.password || url.port ||
      url.search || url.hash || !url.pathname.startsWith(PAGES_PREFIX) ||
      !url.pathname.endsWith("/") || url.toString() !== value ||
      /%(?:2e|2f|5c)/i.test(url.pathname)
    ) throw new Error();
    return value;
  } catch {
    throw new Error("MIAOBI_INVALID_PAGES_URL");
  }
}

function assertLegacyAssetBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || !url.pathname.endsWith("/") || url.toString() !== value ||
      /%(?:2e|2f|5c)/i.test(url.pathname)
    ) throw new Error();
    return value;
  } catch {
    throw new Error("MIAOBI_INVALID_RUNTIME_CONFIG");
  }
}

export function assertMiaobiApiFunctionUrl(value: string, expectedOrigin = API_ORIGIN): string {
  try {
    const url = new URL(value);
    const origin = new URL(expectedOrigin);
    if (
      origin.toString() !== `${origin.origin}/` || origin.protocol !== "https:" ||
      origin.username || origin.password || origin.port ||
      url.origin !== origin.origin || url.username || url.password || url.port ||
      url.search || url.hash || !API_PATH_PATTERN.test(url.pathname) || url.toString() !== value
    ) throw new Error();
    return value;
  } catch {
    throw new Error("MIAOBI_INVALID_RUNTIME_CONFIG");
  }
}

export function validateMiaobiRuntimeInjection(
  config: MiaobiRuntimeInjection,
  assetMode: MiaobiAssetMode = "github-pages",
  expectedApiOrigin = API_ORIGIN,
): MiaobiRuntimeInjection {
  if (config.platform !== "miaobi") throw new Error("MIAOBI_INVALID_RUNTIME_CONFIG");
  if (config.assetBaseUrl !== BUILD_PLACEHOLDER) {
    if (assetMode === "github-pages") assertGitHubPagesAssetBaseUrlValue(config.assetBaseUrl);
    else assertLegacyAssetBaseUrl(config.assetBaseUrl);
  }
  assertMiaobiApiFunctionUrl(config.apiFunctionUrl, expectedApiOrigin);
  return config;
}

function escapeInlineJson(value: string): string {
  return value.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return character;
    }
  });
}

function injectRuntime(
  html: string,
  config: MiaobiRuntimeInjection,
  assetMode: MiaobiAssetMode,
  expectedApiOrigin = API_ORIGIN,
): string {
  validateMiaobiRuntimeInjection(config, assetMode, expectedApiOrigin);
  const firstApplicationScript = html.search(/<script\b/i);
  if (firstApplicationScript < 0) {
    throw new Error("Miaobi SPA shell has no application script");
  }

  const assignment = `<script>window.__MAGIC_RESUME_RUNTIME__=${escapeInlineJson(JSON.stringify(config))}</script>`;
  return `${html.slice(0, firstApplicationScript)}${assignment}${html.slice(firstApplicationScript)}`;
}

export function injectMiaobiRuntime(
  html: string,
  config: MiaobiRuntimeInjection,
): string {
  return injectRuntime(html, config, "github-pages");
}

export function injectLegacyMiaobiRuntime(
  html: string,
  config: MiaobiRuntimeInjection,
  expectedApiOrigin = API_ORIGIN,
): string {
  return injectRuntime(html, config, "legacy-tos", expectedApiOrigin);
}

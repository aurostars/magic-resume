export interface MiaobiRuntimeInjection {
  platform: "miaobi";
  apiFunctionUrl: string;
  assetBaseUrl: string;
}

const PAGES_ORIGIN = "https://aurostars.github.io";
const PAGES_PREFIX = "/magic-resume/";
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

export function validateMiaobiRuntimeInjection(config: MiaobiRuntimeInjection): MiaobiRuntimeInjection {
  if (config.platform !== "miaobi") throw new Error("MIAOBI_INVALID_RUNTIME_CONFIG");
  if (config.assetBaseUrl !== BUILD_PLACEHOLDER) {
    assertGitHubPagesAssetBaseUrlValue(config.assetBaseUrl);
  }
  try {
    const apiUrl = new URL(config.apiFunctionUrl);
    if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password) throw new Error();
  } catch {
    throw new Error("MIAOBI_INVALID_RUNTIME_CONFIG");
  }
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

export function injectMiaobiRuntime(
  html: string,
  config: MiaobiRuntimeInjection,
): string {
  validateMiaobiRuntimeInjection(config);
  const firstApplicationScript = html.search(/<script\b/i);
  if (firstApplicationScript < 0) {
    throw new Error("Miaobi SPA shell has no application script");
  }

  const assignment = `<script>window.__MAGIC_RESUME_RUNTIME__=${escapeInlineJson(JSON.stringify(config))}</script>`;
  return `${html.slice(0, firstApplicationScript)}${assignment}${html.slice(firstApplicationScript)}`;
}

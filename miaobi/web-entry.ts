import {
  validateMiaobiRuntimeInjection,
  type MiaobiAssetMode,
  type MiaobiRuntimeInjection,
} from "./runtime-config";

type RuntimeConfig = MiaobiRuntimeInjection;

function runtimeConfigFrom(
  html: string,
  assetMode: MiaobiAssetMode,
  expectedApiOrigin?: string,
): RuntimeConfig {
  const match = html.match(/window\.__MAGIC_RESUME_RUNTIME__=(\{[^<]+\})<\/script>/);
  if (!match) throw new Error("MIAOBI_INVALID_WEB_HTML");
  const config = JSON.parse(match[1]) as Partial<RuntimeConfig>;
  if (
    config.platform !== "miaobi" || typeof config.apiFunctionUrl !== "string" ||
    typeof config.assetBaseUrl !== "string"
  ) {
    throw new Error("MIAOBI_INVALID_WEB_HTML");
  }
  return validateMiaobiRuntimeInjection(config as RuntimeConfig, assetMode, expectedApiOrigin);
}

function cspFor(html: string, assetMode: MiaobiAssetMode, expectedApiOrigin?: string): string {
  const config = runtimeConfigFrom(html, assetMode, expectedApiOrigin);
  const assetSource = new URL(config.assetBaseUrl).origin;
  const apiSource = new URL(config.apiFunctionUrl).origin;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${assetSource}`,
    `style-src 'unsafe-inline' ${assetSource}`,
    `img-src data: blob: 'self' ${assetSource} ${apiSource}`,
    `font-src data: ${assetSource}`,
    `media-src data: blob: ${assetSource}`,
    `connect-src ${apiSource} https:`,
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function createWebFaasHandler(
  html: string,
  assetMode: MiaobiAssetMode = "github-pages",
  expectedApiOrigin?: string,
) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": cspFor(html, assetMode, expectedApiOrigin),
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Magic-Resume-Faas": "magic-resume-web",
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: "GET, HEAD" },
      });
    }
    return new Response(request.method === "HEAD" ? null : html, { headers });
  };
}

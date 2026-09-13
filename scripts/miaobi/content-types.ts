import { extname } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeFor(relativePath: string): string | null {
  return CONTENT_TYPES[extname(relativePath).toLowerCase()] ?? null;
}

export function isRewritableTextAsset(relativePath: string): boolean {
  return [".html", ".js", ".mjs", ".css"].includes(
    extname(relativePath).toLowerCase(),
  );
}

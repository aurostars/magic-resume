import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { assertGitHubPagesAssetBaseUrlValue } from "../../miaobi/runtime-config";
import { graphBaseUrlFromManifest } from "./github-pages-assets";
import type { GitHubPagesPublication } from "./publish-github-pages";
import type { GitHubPagesAssetRecord, GitHubPagesManifest } from "./types";

const PAGES_ORIGIN = "https://aurostars.github.io";
const PAGES_PREFIX = "/magic-resume/";
const MANIFEST_LIMIT = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function invalidUrl(): never {
  throw new Error("MIAOBI_INVALID_PAGES_URL");
}

function healthFailed(): never {
  throw new Error("MIAOBI_PAGES_HEALTH_FAILED");
}

export function assertGitHubPagesAssetBaseUrl(value: string): string {
  return assertGitHubPagesAssetBaseUrlValue(value);
}

function assertPagesUrl(value: string): string {
  const slash = value.lastIndexOf("/");
  if (slash < 0) invalidUrl();
  assertGitHubPagesAssetBaseUrl(value.slice(0, slash + 1));
  try {
    const url = new URL(value);
    if (url.toString() !== value || url.search || url.hash || /%(?:2e|2f|5c)/i.test(url.pathname)) invalidUrl();
    return value;
  } catch (error) {
    if ((error as Error)?.message === "MIAOBI_INVALID_PAGES_URL") throw error;
    return invalidUrl();
  }
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]));
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
}

function assertPublication(publication: GitHubPagesPublication): void {
  const commit = publication.manifest.sourceCommit;
  if (!COMMIT_PATTERN.test(commit) || !COMMIT_PATTERN.test(publication.pagesCommit)) invalidUrl();
  if (assertGitHubPagesAssetBaseUrl(publication.pagesBaseUrl) !== PAGES_ORIGIN + PAGES_PREFIX) invalidUrl();
  if (publication.manifest.baseUrl !== publication.pagesBaseUrl) invalidUrl();
  try {
    if (graphBaseUrlFromManifest(publication.manifest) !== publication.graphBaseUrl) invalidUrl();
    assertGitHubPagesAssetBaseUrl(publication.graphBaseUrl);
  } catch {
    invalidUrl();
  }
  const expectedManifest = `${publication.pagesBaseUrl}releases/${commit}/manifest.json`;
  if (publication.releaseManifestUrl !== expectedManifest) invalidUrl();
  assertPagesUrl(publication.releaseManifestUrl);
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error("aborted"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function fetchFollowingRedirects(
  initialUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertPagesUrl(url);
    const response = await withAbort(
      fetchImpl(url, { method: "GET", redirect: "manual", signal }),
      signal,
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      cancelResponse(response);
      if (!location || redirects === MAX_REDIRECTS) healthFailed();
      try {
        url = new URL(location, url).toString();
        assertPagesUrl(url);
      } catch {
        healthFailed();
      }
      continue;
    }
    return response;
  }
  return healthFailed();
}

function normalizedContentType(value: string | null): string {
  return value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

function contentTypeMatches(actual: string | null, expected: string): boolean {
  const normalized = normalizedContentType(actual);
  const wanted = normalizedContentType(expected);
  if (wanted === "application/json; charset=utf-8") {
    return normalized === wanted || normalized === "application/json";
  }
  return normalized === wanted;
}

type AssetRole = "index" | "script" | "stylesheet";

const ROLE_CONTENT_TYPES: Record<AssetRole, ReadonlySet<string>> = {
  index: new Set(["text/html", "text/html; charset=utf-8"]),
  script: new Set([
    "application/javascript",
    "application/javascript; charset=utf-8",
    "text/javascript",
    "text/javascript; charset=utf-8",
  ]),
  stylesheet: new Set(["text/css", "text/css; charset=utf-8"]),
};

function assertRoleContentType(contentType: string, role: AssetRole): void {
  if (!ROLE_CONTENT_TYPES[role].has(normalizedContentType(contentType))) healthFailed();
}

async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
  collect: boolean,
): Promise<{ bytes?: Uint8Array; hash: string; size: number }> {
  if (!response.body) healthFailed();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) healthFailed();
      hash.update(value);
      if (collect) chunks.push(value);
    }
    const bytes = collect ? Buffer.concat(chunks, size) : undefined;
    return { bytes, hash: hash.digest("hex"), size };
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

async function fetchChecked(
  url: string,
  expectedContentType: string,
  limit: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  collect: boolean,
): Promise<{ bytes?: Uint8Array; hash: string; size: number }> {
  const response = await fetchFollowingRedirects(url, fetchImpl, signal);
  if (response.status < 200 || response.status >= 300 ||
    !contentTypeMatches(response.headers.get("Content-Type"), expectedContentType)) {
    cancelResponse(response);
    healthFailed();
  }
  return readBounded(response, limit, signal, collect);
}

function assertAssetRecord(record: GitHubPagesAssetRecord, relativePath: string, baseUrl: string): void {
  if (
    record.relativePath !== relativePath || !HASH_PATTERN.test(record.contentHash) ||
    !Number.isSafeInteger(record.size) || record.size < 0 || record.key !== record.objectPath ||
    !/^objects\/[0-9a-f]{64}\/[A-Za-z0-9_./-]+$/.test(record.objectPath) ||
    record.objectPath.includes("..") || record.url !== `${baseUrl}${record.objectPath}`
  ) healthFailed();
  assertPagesUrl(record.url);
}

interface ParsedAttribute {
  present: boolean;
  value?: string;
}

function attribute(tag: string, name: string): ParsedAttribute {
  const openingTag = /^<[^\s>]+/.exec(tag);
  if (!openingTag) return { present: false };
  const attributes = tag.slice(openingTag[0].length);
  const pattern = /(?:^|\s+)([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1].toLowerCase() === name.toLowerCase()) {
      return { present: true, value: match[2] ?? match[3] ?? match[4] };
    }
  }
  return { present: false };
}

function bootAssets(html: string): Array<{ url: string; role: Exclude<AssetRole, "index"> }> {
  const assets = new Map<string, Exclude<AssetRole, "index">>();
  const add = (url: string, role: Exclude<AssetRole, "index">): void => {
    const existing = assets.get(url);
    if (existing && existing !== role) healthFailed();
    assets.set(url, role);
  };
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const type = attribute(tag, "type");
    if (type.value?.toLowerCase() === "module") {
      const src = attribute(tag, "src");
      if (!src.present) continue;
      if (!src.value?.trim()) healthFailed();
      add(src.value, "script");
    }
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(tag, "rel");
    const relations = (rel.value ?? "").toLowerCase().split(/\s+/);
    const isStylesheet = relations.includes("stylesheet");
    const isModulePreload = relations.includes("modulepreload");
    if (isStylesheet && isModulePreload) healthFailed();
    if (isStylesheet || isModulePreload) {
      const href = attribute(tag, "href");
      if (!href.present || !href.value?.trim()) healthFailed();
      add(href.value, isStylesheet ? "stylesheet" : "script");
    }
  }
  return [...assets].sort(([left], [right]) => left.localeCompare(right))
    .map(([url, role]) => ({ url, role }));
}

export async function verifyGitHubPagesRelease(input: {
  publication: GitHubPagesPublication;
  fetchImpl?: typeof fetch;
  signalFactory?: (timeoutMs: number) => AbortSignal;
}): Promise<void> {
  assertPublication(input.publication);
  const signal = (input.signalFactory ?? AbortSignal.timeout)(DEFAULT_TIMEOUT_MS);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  try {
    const manifestResult = await fetchChecked(
      input.publication.releaseManifestUrl,
      "application/json; charset=utf-8",
      MANIFEST_LIMIT,
      fetchImpl,
      signal,
      true,
    );
    let remoteManifest: GitHubPagesManifest;
    try {
      remoteManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestResult.bytes)) as GitHubPagesManifest;
    } catch {
      healthFailed();
    }
    if (!sameJson(remoteManifest, input.publication.manifest) ||
      remoteManifest.sourceCommit !== input.publication.manifest.sourceCommit) healthFailed();

    const index = remoteManifest.files["index.html"];
    if (!index) healthFailed();
    assertAssetRecord(index, "index.html", remoteManifest.baseUrl);
    assertRoleContentType(index.contentType, "index");
    const indexResult = await fetchChecked(
      index.url, index.contentType, index.size, fetchImpl, signal, true,
    );
    if (indexResult.size !== index.size || indexResult.hash !== index.contentHash) healthFailed();
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(indexResult.bytes);
    } catch {
      healthFailed();
    }

    const byUrl = new Map<string, [string, GitHubPagesAssetRecord]>();
    for (const [relativePath, record] of Object.entries(remoteManifest.files)) {
      assertAssetRecord(record, relativePath, remoteManifest.baseUrl);
      byUrl.set(record.url, [relativePath, record]);
    }
    for (const { url, role } of bootAssets(html)) {
      assertPagesUrl(url);
      const entry = byUrl.get(url);
      if (!entry) healthFailed();
      const [relativePath, record] = entry;
      if (!/\.(?:css|js|mjs)$/.test(relativePath)) healthFailed();
      assertRoleContentType(record.contentType, role);
      const result = await fetchChecked(
        record.url, record.contentType, record.size, fetchImpl, signal, false,
      );
      if (result.size !== record.size || result.hash !== record.contentHash) healthFailed();
    }
  } catch {
    healthFailed();
  }
}

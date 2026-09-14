import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { assertGitHubPagesAssetBaseUrlValue } from "../../miaobi/runtime-config";
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
  const expectedManifest = `${publication.pagesBaseUrl}releases/${commit}/manifest.json`;
  if (publication.releaseManifestUrl !== expectedManifest) invalidUrl();
  assertPagesUrl(publication.releaseManifestUrl);
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchFollowingRedirects(
  initialUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertPagesUrl(url);
    const response = await Promise.race([
      fetchImpl(url, { method: "GET", redirect: "manual", signal }),
      abortPromise(signal),
    ]);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await cancelResponse(response);
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
      const { done, value } = await Promise.race([reader.read(), abortPromise(signal)]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) healthFailed();
      hash.update(value);
      if (collect) chunks.push(value);
    }
    const bytes = collect ? Buffer.concat(chunks, size) : undefined;
    return { bytes, hash: hash.digest("hex"), size };
  } finally {
    await reader.cancel().catch(() => undefined);
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
    await cancelResponse(response);
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

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
}

function bootAssetUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (attribute(tag, "type")?.toLowerCase() === "module") {
      const src = attribute(tag, "src");
      if (!src) healthFailed();
      urls.add(src);
    }
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const relations = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (relations.includes("stylesheet") || relations.includes("modulepreload")) {
      const href = attribute(tag, "href");
      if (!href) healthFailed();
      urls.add(href);
    }
  }
  return [...urls].sort();
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
    for (const url of bootAssetUrls(html)) {
      assertPagesUrl(url);
      const entry = byUrl.get(url);
      if (!entry) healthFailed();
      const [relativePath, record] = entry;
      if (!/\.(?:css|js|mjs)$/.test(relativePath)) healthFailed();
      const result = await fetchChecked(
        record.url, record.contentType, record.size, fetchImpl, signal, false,
      );
      if (result.size !== record.size || result.hash !== record.contentHash) healthFailed();
    }
  } catch {
    healthFailed();
  }
}

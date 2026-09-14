import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertGitHubPagesAssetBaseUrl,
  verifyGitHubPagesRelease,
} from "../scripts/miaobi/github-pages-health";
import type { GitHubPagesPublication } from "../scripts/miaobi/publish-github-pages";
import type { GitHubPagesAssetRecord, GitHubPagesManifest } from "../scripts/miaobi/types";

const SOURCE_COMMIT = "d26c16fcfcec3cb7b73d3d6002aebdf212422f21";
const GRAPH = "1".repeat(64);
const PAGES_BASE = "https://aurostars.github.io/magic-resume/";
const OBJECT_BASE = `${PAGES_BASE}objects/${GRAPH}/`;

function record(relativePath: string, body: Uint8Array, contentType: string): GitHubPagesAssetRecord {
  const objectPath = `objects/${GRAPH}/${relativePath}` as const;
  return {
    relativePath,
    contentHash: createHash("sha256").update(body).digest("hex"),
    contentType,
    key: objectPath,
    url: `${PAGES_BASE}${objectPath}`,
    objectPath,
    size: body.byteLength,
  };
}

function releaseFixture() {
  const js = new TextEncoder().encode("console.log('boot')");
  const css = new TextEncoder().encode("body{color:#111}");
  const html = new TextEncoder().encode(
    `<!doctype html><link rel="stylesheet" href="${OBJECT_BASE}assets/app.css"><script type="module" src="${OBJECT_BASE}assets/app.js"></script>`,
  );
  const files = {
    "index.html": record("index.html", html, "text/html; charset=utf-8"),
    "assets/app.js": record("assets/app.js", js, "application/javascript; charset=utf-8"),
    "assets/app.css": record("assets/app.css", css, "text/css; charset=utf-8"),
  };
  const manifest: GitHubPagesManifest = {
    schemaVersion: 1,
    provider: "github-pages",
    sourceCommit: SOURCE_COMMIT,
    releaseId: "d26c16fcfcec-20260914142200",
    createdAt: "2026-09-14T14:22:00.000Z",
    baseUrl: PAGES_BASE,
    files,
  };
  const publication: GitHubPagesPublication = {
    manifest,
    pagesCommit: "a".repeat(40),
    pagesBaseUrl: PAGES_BASE,
    releaseManifestUrl: `${PAGES_BASE}releases/${SOURCE_COMMIT}/manifest.json`,
  };
  return { publication, bodies: new Map([
    [publication.releaseManifestUrl, new TextEncoder().encode(`${JSON.stringify(manifest)}\n`)],
    [files["index.html"].url, html],
    [files["assets/app.js"].url, js],
    [files["assets/app.css"].url, css],
  ]) };
}

function contentTypeFor(url: string): string {
  if (url.endsWith("manifest.json")) return "application/json; charset=utf-8";
  if (url.endsWith("index.html")) return "text/html; charset=utf-8";
  if (url.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "text/css; charset=utf-8";
}

function successfulFetch(bodies: Map<string, Uint8Array>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    const url = String(input);
    const body = bodies.get(url);
    assert.ok(body, `unexpected URL ${url}`);
    return new Response(body, { headers: { "Content-Type": contentTypeFor(url) } });
  }) as typeof fetch;
}

function trackedResponse(
  body: Uint8Array,
  init: ResponseInit = {},
): { response: Response; cancelled: () => boolean } {
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(body); },
    cancel() { wasCancelled = true; },
  });
  return {
    response: new Response(stream, init),
    cancelled: () => wasCancelled,
  };
}

function deadlineSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(Math.min(timeoutMs, 20));
}

test("accepts only canonical Pages asset bases under the fixed repository prefix", () => {
  assert.equal(assertGitHubPagesAssetBaseUrl(PAGES_BASE), PAGES_BASE);
  assert.equal(assertGitHubPagesAssetBaseUrl(OBJECT_BASE), OBJECT_BASE);

  for (const value of [
    "https://evil.example/magic-resume/",
    "https://aurostars.github.io.evil.example/magic-resume/",
    "https://user@aurostars.github.io/magic-resume/",
    "https://aurostars.github.io:444/magic-resume/",
    "https://aurostars.github.io/magic-resume/?x=1",
    "https://aurostars.github.io/magic-resume/#fragment",
    "https://aurostars.github.io/magic-resume/%2e%2e/escape/",
    "https://aurostars.github.io/magic-resume/%2Fescape/",
    "https://aurostars.github.io/magic-resume",
  ]) assert.throws(() => assertGitHubPagesAssetBaseUrl(value), /MIAOBI_INVALID_PAGES_URL/);
});

test("verifies the release manifest, index, and every boot-critical module and stylesheet", async () => {
  const { publication, bodies } = releaseFixture();
  const visited: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    visited.push(String(input));
    return successfulFetch(bodies)(input, init);
  }) as typeof fetch;

  await verifyGitHubPagesRelease({ publication, fetchImpl });
  assert.deepEqual(visited, [
    publication.releaseManifestUrl,
    publication.manifest.files["index.html"].url,
    publication.manifest.files["assets/app.css"].url,
    publication.manifest.files["assets/app.js"].url,
  ]);
});

test("rejects malformed manifest URLs before making a request", async () => {
  const { publication } = releaseFixture();
  let called = false;
  for (const releaseManifestUrl of [
    `${PAGES_BASE}releases/${SOURCE_COMMIT.toUpperCase()}/manifest.json`,
    `${PAGES_BASE}releases/${SOURCE_COMMIT}/other.json`,
    `${PAGES_BASE}releases/${SOURCE_COMMIT}/manifest.json?raw=1`,
    `${PAGES_BASE}releases/%2e%2e/${SOURCE_COMMIT}/manifest.json`,
  ]) {
    await assert.rejects(verifyGitHubPagesRelease({
      publication: { ...publication, releaseManifestUrl },
      fetchImpl: (async () => { called = true; throw new Error("unexpected"); }) as typeof fetch,
    }), /MIAOBI_INVALID_PAGES_URL/);
  }
  assert.equal(called, false);
});

test("follows same-prefix redirects manually and uses one signal for the whole chain", async () => {
  const { publication, bodies } = releaseFixture();
  const redirected = `${PAGES_BASE}releases/${SOURCE_COMMIT}/manifest-copy.json`;
  const seenSignals = new Set<AbortSignal | null | undefined>();
  let redirectedBodyCancelled = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seenSignals.add(init?.signal);
    if (String(input) === publication.releaseManifestUrl) {
      const stream = new ReadableStream({ cancel() { redirectedBodyCancelled = true; } });
      return new Response(stream, { status: 302, headers: { Location: redirected } });
    }
    if (String(input) === redirected) {
      const body = bodies.get(publication.releaseManifestUrl)!;
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    }
    return successfulFetch(bodies)(input, init);
  }) as typeof fetch;

  await verifyGitHubPagesRelease({ publication, fetchImpl });
  assert.equal(redirectedBodyCancelled, true);
  assert.equal(seenSignals.size, 1);
});

test("rejects redirect escape and cancels its response body", async () => {
  const { publication } = releaseFixture();
  const tracked = trackedResponse(new Uint8Array([1]), {
    status: 302,
    headers: { Location: "https://evil.example/magic-resume/manifest.json" },
  });
  await assert.rejects(verifyGitHubPagesRelease({
    publication,
    fetchImpl: (async () => tracked.response) as typeof fetch,
  }), /MIAOBI_PAGES_HEALTH_FAILED/);
  assert.equal(tracked.cancelled(), true);
});

test("rejects non-2xx and wrong MIME while cancelling bodies", async () => {
  const { publication } = releaseFixture();
  for (const init of [
    { status: 503, headers: { "Content-Type": "application/json" } },
    { status: 200, headers: { "Content-Type": "text/plain" } },
  ]) {
    const tracked = trackedResponse(new TextEncoder().encode("failure body"), init);
    await assert.rejects(verifyGitHubPagesRelease({
      publication,
      fetchImpl: (async () => tracked.response) as typeof fetch,
    }), /MIAOBI_PAGES_HEALTH_FAILED/);
    assert.equal(tracked.cancelled(), true);
  }
});

test("streams the manifest with a 5 MiB limit and cancels as soon as it is exceeded", async () => {
  const { publication } = releaseFixture();
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(verifyGitHubPagesRelease({
    publication,
    fetchImpl: (async () => new Response(stream, {
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch,
  }), /MIAOBI_PAGES_HEALTH_FAILED/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 7, `body was buffered without a streaming bound (${pulls} pulls)`);
});

test("rejects asset hash mismatch and stale source commit", async () => {
  const first = releaseFixture();
  const corruptUrl = first.publication.manifest.files["assets/app.js"].url;
  first.bodies.set(corruptUrl, new TextEncoder().encode("corrupt"));
  await assert.rejects(verifyGitHubPagesRelease({
    publication: first.publication,
    fetchImpl: successfulFetch(first.bodies),
  }), /MIAOBI_PAGES_HEALTH_FAILED/);

  const second = releaseFixture();
  const remote = JSON.parse(new TextDecoder().decode(second.bodies.get(second.publication.releaseManifestUrl)!));
  remote.sourceCommit = "f".repeat(40);
  second.bodies.set(second.publication.releaseManifestUrl, new TextEncoder().encode(JSON.stringify(remote)));
  await assert.rejects(verifyGitHubPagesRelease({
    publication: second.publication,
    fetchImpl: successfulFetch(second.bodies),
  }), /MIAOBI_PAGES_HEALTH_FAILED/);
});

test("one total deadline covers waiting for response headers", async () => {
  const { publication } = releaseFixture();
  await assert.rejects(verifyGitHubPagesRelease({
    publication,
    signalFactory: deadlineSignal,
    fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch,
  }), /MIAOBI_PAGES_HEALTH_FAILED/);
});

test("one total deadline aborts a stalled response body and cancels it", async () => {
  const { publication } = releaseFixture();
  let cancelled = false;
  const fetchImpl = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  await assert.rejects(verifyGitHubPagesRelease({
    publication,
    signalFactory: deadlineSignal,
    fetchImpl,
  }), /MIAOBI_PAGES_HEALTH_FAILED/);
  assert.equal(cancelled, true);
});

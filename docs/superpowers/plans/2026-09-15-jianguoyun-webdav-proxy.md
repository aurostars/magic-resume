# Jianguoyun WebDAV Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jianguoyun WebDAV work from the Miaobi deployment through a fixed-origin API FaaS proxy, sanitize invisible URL characters, and enable auto-sync by default only for new settings.

**Architecture:** Keep the existing WebDAV controller and storage model unchanged. Add a server handler whose upstream is permanently fixed to `https://dav.jianguoyun.com/dav/`, then make `WebDavClient` select a same-origin proxy transport only for normalized Jianguoyun URLs; all other providers continue using direct browser fetch. Merge persisted settings field-by-field so an explicit historical `false` remains false while a missing field receives the new `true` default.

**Tech Stack:** TypeScript, React, Zustand persist, Fetch API, Node test runner through `tsx`, Vite, esbuild, Miaobi API FaaS.

## Global Constraints

- The server must never accept a caller-controlled upstream origin; Jianguoyun origin is exactly `https://dav.jianguoyun.com` and root is exactly `/dav/`.
- Only `OPTIONS`, `PROPFIND`, `MKCOL`, `GET`, `PUT`, `DELETE`, and `MOVE` may be proxied.
- Credentials and upstream response bodies must not appear in errors, logs, snapshots, or committed fixtures.
- Proxy responses must set `Cache-Control: no-store` and expose only synchronization-required response headers.
- Requests and responses must have explicit size limits; use 8 MiB for request bodies and 8 MiB for response bodies so existing resume JSON remains supported.
- Redirects are disabled; a redirect response must fail closed rather than follow another origin.
- Existing non-Jianguoyun WebDAV behavior, file layout, conflict handling, deletion behavior, and JSON format must remain unchanged.
- `autoSyncEnabled` defaults to `true` only when the persisted field is absent; an explicitly persisted `false` remains false.
- Use TDD for every behavior change: write the test, observe the expected failure, implement the minimum, then observe green.

---

### Task 1: Fixed-Origin Jianguoyun Proxy Handler

**Files:**
- Create: `src/lib/server/jianguoyun-webdav-proxy.ts`
- Modify: `src/lib/server/api-router.ts`
- Modify: `miaobi/api-entry.ts`
- Create: `tests/jianguoyun-webdav-proxy.test.ts`
- Modify: `tests/miaobi-api-faas.test.ts`
- Modify: `tests/miaobi-faas-build.test.ts`

**Interfaces:**
- Consumes: standard `Request`, injected `typeof fetch`, and `handleApiRequest()` dependency routing.
- Produces:
  ```ts
  export type JianguoyunWebDavMethod =
    | "OPTIONS" | "PROPFIND" | "MKCOL" | "GET" | "PUT" | "DELETE" | "MOVE";

  export interface JianguoyunProxyRequest {
    method: JianguoyunWebDavMethod;
    path: string;
    username: string;
    password: string;
    headers?: Record<string, string>;
    body?: string;
  }

  export interface JianguoyunProxyDependencies {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }

  export function handleJianguoyunWebDavProxy(
    request: Request,
    dependencies?: JianguoyunProxyDependencies,
  ): Promise<Response>;
  ```
- Extends `ApiRouterDependencies` with:
  ```ts
  webdavJianguoyun: (request: Request) => Promise<Response>;
  ```
- Adds `ApiRoutePath` value `/api/webdav/jianguoyun`, method `POST`.

- [ ] **Step 1: Write failing proxy contract and validation tests**

Create `tests/jianguoyun-webdav-proxy.test.ts` with literal requests and an injected recording fetch. Tests must cover these named behaviors:

```ts
test("the Jianguoyun proxy constructs only the fixed HTTPS upstream", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    method: "PROPFIND",
    path: "magic-resume/manifest.json",
    username: "account@example.test",
    password: "app-password",
    headers: { Depth: "0" },
  }), {
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("<multistatus/>", {
        status: 207,
        headers: { "Content-Type": "application/xml", ETag: '"v1"', Cookie: "secret" },
      });
    },
  });

  assert.equal(calls[0].url,
    "https://dav.jianguoyun.com/dav/magic-resume/manifest.json");
  assert.equal(calls[0].init?.method, "PROPFIND");
  assert.equal(response.status, 207);
  assert.equal(response.headers.get("ETag"), '"v1"');
  assert.equal(response.headers.get("Cookie"), null);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
```

Add separate tests named:

- `the Jianguoyun proxy rejects unsupported methods before fetch`
- `the Jianguoyun proxy rejects absolute paths and encoded path traversal`
- `the Jianguoyun proxy rejects credentials embedded in path data`
- `MOVE rewrites an allowed relative Destination to the fixed upstream`
- `MOVE rejects an absolute or cross-origin Destination`
- `the proxy forwards only Depth Destination Overwrite If If-Match If-None-Match and Content-Type`
- `the proxy disables redirects`
- `the proxy rejects request bodies over 8 MiB`
- `the proxy rejects response bodies over 8 MiB`
- `the proxy timeout returns a stable sanitized JSON error`
- `proxy errors never include username password Authorization or upstream body`

- [ ] **Step 2: Run proxy tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/jianguoyun-webdav-proxy.test.ts
```

Expected: FAIL because `src/lib/server/jianguoyun-webdav-proxy.ts` does not exist.

- [ ] **Step 3: Implement the minimal fixed-origin proxy**

Implement the handler with these constants and boundaries:

```ts
const JIANGUOYUN_ORIGIN = "https://dav.jianguoyun.com";
const JIANGUOYUN_ROOT = "/dav/";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ALLOWED_METHODS = new Set<JianguoyunWebDavMethod>([
  "OPTIONS", "PROPFIND", "MKCOL", "GET", "PUT", "DELETE", "MOVE",
]);
const REQUEST_HEADERS = new Set([
  "depth", "destination", "overwrite", "if", "if-match", "if-none-match", "content-type",
]);
const RESPONSE_HEADERS = new Set([
  "dav", "etag", "last-modified", "content-type", "allow",
]);
```

Parse JSON only after checking request `Content-Length` when present. Validate the decoded relative path segment-by-segment, reject `.` and `..`, reject backslashes and NUL, then construct the target with `new URL(encodedRelativePath, "https://dav.jianguoyun.com/dav/")` and re-check exact origin plus `/dav/` prefix.

Generate Basic auth inside the handler from `username` and `password`. Use `redirect: "manual"`, an `AbortController`, and the injected timeout. Reject any `3xx` as a sanitized `502` proxy error. Read the response through a byte-counting stream or `arrayBuffer()` with the 8 MiB postcondition before creating the downstream `Response`.

Do not include caught error messages in the response. Use stable JSON shapes such as:

```ts
Response.json({ error: "Jianguoyun WebDAV proxy failed", code: "webdavProxyFailed" }, {
  status: 502,
  headers: { "Cache-Control": "no-store" },
});
```

- [ ] **Step 4: Run proxy tests and verify GREEN**

Run:

```bash
corepack pnpm exec tsx --test tests/jianguoyun-webdav-proxy.test.ts
```

Expected: all proxy tests PASS with no warnings.

- [ ] **Step 5: Write failing API routing and bundle tests**

In `tests/miaobi-api-faas.test.ts`, add:

```ts
test("the Miaobi API routes Jianguoyun WebDAV requests through the injected handler", async () => {
  const handler = createMiaobiApiHandler(undefined, async () =>
    Response.json({ proxied: true }, { status: 207 }));
  const response = await handler(new Request(
    "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fwebdav%2Fjianguoyun",
    { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
  ));
  assert.equal(response.status, 207);
  assert.deepEqual(await response.json(), { proxied: true });
});
```

Also extend the existing runtime-require bundle test to invoke the new route with an injected fetch and confirm bundle evaluation still performs no runtime `require`.

- [ ] **Step 6: Run API tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/miaobi-api-faas.test.ts tests/miaobi-faas-build.test.ts
```

Expected: FAIL because the route and second `createMiaobiApiHandler` dependency do not exist.

- [ ] **Step 7: Register the route and inject the handler**

Update `src/lib/server/api-router.ts`:

```ts
export type ApiRoutePath =
  | "/api/grammar"
  | "/api/polish"
  | "/api/ai-test"
  | "/api/resume-import"
  | "/api/proxy/image"
  | "/api/webdav/jianguoyun";
```

Register it as `POST` with dependency `webdavJianguoyun`. Add a fail-closed default dependency that dynamically imports the proxy handler.

Update `miaobi/api-entry.ts` without importing Node-only modules:

```ts
export function createMiaobiApiHandler(
  imageTransport?: ImageProxyTransport,
  jianguoyunHandler = handleJianguoyunWebDavProxy,
) {
  return createMiaobiFaasAdapter((request, logicalPath) =>
    handleApiRequest(request, logicalPath, {
      ...defaultApiRouterDependencies,
      imageProxy: (imageRequest) => imageTransport
        ? handleImageProxy(imageRequest, { transport: imageTransport })
        : handleImageProxy(imageRequest),
      webdavJianguoyun: jianguoyunHandler,
    }));
}
```

- [ ] **Step 8: Run API, bundle, and proxy tests**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/jianguoyun-webdav-proxy.test.ts \
  tests/miaobi-api-faas.test.ts \
  tests/miaobi-faas-build.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add \
  src/lib/server/jianguoyun-webdav-proxy.ts \
  src/lib/server/api-router.ts \
  miaobi/api-entry.ts \
  tests/jianguoyun-webdav-proxy.test.ts \
  tests/miaobi-api-faas.test.ts \
  tests/miaobi-faas-build.test.ts
git commit -m "feat(webdav): add Jianguoyun FaaS proxy"
```

---

### Task 2: URL Normalization and Jianguoyun Client Transport

**Files:**
- Modify: `src/lib/webdav/client.ts`
- Modify: `src/config/runtime-endpoints.ts` only if the existing `getApiRequestUrl()` type prevents using the new literal path; do not duplicate endpoint construction.
- Modify: `tests/webdav-client.test.ts`
- Create: `tests/webdav-jianguoyun-transport.test.ts`

**Interfaces:**
- Consumes: `getApiRequestUrl("/api/webdav/jianguoyun")` and the Task 1 JSON request/HTTP response contract.
- Produces:
  ```ts
  export function normalizeWebDavBaseUrl(value: string): URL;
  export function isJianguoyunWebDavUrl(value: URL): boolean;
  export type WebDavFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  export function createJianguoyunProxyFetch(
    config: WebDavClientConfig,
    fetchImpl?: typeof fetch,
  ): WebDavFetch;
  ```
- `WebDavClient` keeps its public API unchanged.

- [ ] **Step 1: Write failing URL normalization tests**

In `tests/webdav-client.test.ts`, add literal tests:

```ts
test("WebDAV base URL removes trailing invisible format characters", () => {
  assert.equal(
    normalizeWebDavBaseUrl(" https://dav.jianguoyun.com/dav\u200c ").toString(),
    "https://dav.jianguoyun.com/dav/",
  );
});
```

Add separate tests for `U+200B`, `U+200D`, `U+2060`, `U+FEFF`, and combinations at both ends. Add tests proving embedded invisible characters inside a hostname or path are rejected rather than silently rewritten. Preserve tests for HTTPS enforcement, credential rejection, query/hash removal, and forbidden worker hostnames.

- [ ] **Step 2: Run normalization tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-client.test.ts
```

Expected: FAIL because `normalizeWebDavBaseUrl` is not exported and the invisible suffix is retained.

- [ ] **Step 3: Implement shared normalization**

Replace private `safeBaseUrl` with exported `normalizeWebDavBaseUrl`. Strip only leading/trailing characters matching:

```ts
const EDGE_IGNORABLE = /^[\s\u200B\u200C\u200D\u2060\uFEFF]+|[\s\u200B\u200C\u200D\u2060\uFEFF]+$/gu;
```

After URL parsing, reject any remaining `U+200B/U+200C/U+200D/U+2060/U+FEFF`, userinfo, non-HTTPS scheme, explicit non-default port, and forbidden worker host. Keep query/hash removal. For exact `dav.jianguoyun.com` and a normalized `/dav` root, canonicalize to `/dav/`.

- [ ] **Step 4: Run normalization tests and verify GREEN**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-client.test.ts
```

Expected: all client normalization and existing client tests PASS.

- [ ] **Step 5: Write failing Jianguoyun transport tests**

Create `tests/webdav-jianguoyun-transport.test.ts` with a fake fetch that records the same-origin API request and returns real `Response` objects. Tests must be named:

- `Jianguoyun OPTIONS uses the same-origin API endpoint`
- `Jianguoyun PROPFIND forwards Depth and XML body through the envelope`
- `Jianguoyun MOVE converts Destination to a relative Jianguoyun path`
- `Jianguoyun proxy responses preserve status ETag Last-Modified DAV Allow and body`
- `Jianguoyun credentials never appear in the request URL`
- `non-Jianguoyun WebDAV keeps using the direct target URL`
- `a trailing-dot or lookalike Jianguoyun hostname does not select the proxy`

Use a Miaobi runtime fixture where:

```ts
window.__MAGIC_RESUME_RUNTIME__ = {
  platform: "miaobi",
  apiFunctionUrl: "https://magic.solutionsuite.cn/api/faas/test-id",
  assetBaseUrl: "https://aurostars.github.io/magic-resume/objects/test/",
};
```

Assert the proxy request URL equals:

```text
https://magic.solutionsuite.cn/api/faas/test-id?__path=%2Fapi%2Fwebdav%2Fjianguoyun
```

- [ ] **Step 6: Run transport tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-jianguoyun-transport.test.ts
```

Expected: FAIL because Jianguoyun still uses direct browser fetch.

- [ ] **Step 7: Implement automatic transport selection**

Implement `isJianguoyunWebDavUrl()` with exact normalized hostname and `/dav/` prefix checks. Implement `createJianguoyunProxyFetch()` to translate `RequestInit` into Task 1’s envelope and call `getApiRequestUrl("/api/webdav/jianguoyun")` with `POST`, `Content-Type: application/json`, and `Cache-Control: no-store`.

Keep `WebDavClient`’s injectable fetch behavior for tests. Select the proxy only when no explicit transport was injected and the normalized base URL is Jianguoyun. All existing status mapping and response parsing must continue to operate on the returned `Response`.

- [ ] **Step 8: Run client and transport tests**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/webdav-client.test.ts \
  tests/webdav-jianguoyun-transport.test.ts \
  tests/webdav-controller.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add \
  src/lib/webdav/client.ts \
  src/config/runtime-endpoints.ts \
  tests/webdav-client.test.ts \
  tests/webdav-jianguoyun-transport.test.ts
git commit -m "feat(webdav): route Jianguoyun through FaaS"
```

---

### Task 3: Auto-Sync Default, Persisted Compatibility, and Settings UX

**Files:**
- Modify: `src/store/useWebDavStore.ts`
- Modify: `src/components/settings/WebDavSection.tsx`
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`
- Modify: `tests/webdav-store.test.ts`
- Modify: `tests/webdav-ui-contract.test.ts`

**Interfaces:**
- Consumes: `normalizeWebDavBaseUrl()` from Task 2 and existing `WebDavErrorCode` values.
- Produces: unchanged `WebDavSettings`; new defaults and field-by-field persisted merge behavior.

- [ ] **Step 1: Write failing store compatibility tests**

In `tests/webdav-store.test.ts`, add:

```ts
test("new WebDAV settings enable automatic sync by default", () => {
  const store = createWebDavStore(testStorage());
  assert.equal(store.getState().settings.autoSyncEnabled, true);
});

test("persisted false keeps automatic sync disabled", async () => {
  const storage = hydratedStorage({
    settings: {
      baseUrl: "https://dav.jianguoyun.com/dav/",
      username: "account@example.test",
      password: "app-password",
      remoteDirectory: "/magic-resume/",
      autoSyncEnabled: false,
    },
    deviceId: "device-existing",
  });
  const store = createWebDavStore(storage);
  await waitForHydration(store);
  assert.equal(store.getState().settings.autoSyncEnabled, false);
});

test("persisted settings without the auto-sync field receive the new default", async () => {
  // Hydrate a legacy settings object that omits autoSyncEnabled.
  // Expect all persisted fields retained and autoSyncEnabled === true.
});
```

Also assert `clearCredentials()` restores the new default `true`.

- [ ] **Step 2: Run store tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-store.test.ts
```

Expected: FAIL because the current default is `false` and persisted settings replace the complete defaults object.

- [ ] **Step 3: Implement the default and field-level merge**

Change:

```ts
autoSyncEnabled: true,
```

Change persist merge to preserve default fields missing from legacy state while preserving explicit `false`:

```ts
merge: (persistedState, currentState) => {
  const persisted = persistedState as Partial<PersistedWebDavState>;
  return {
    ...currentState,
    settings: {
      ...currentState.settings,
      ...(persisted.settings ?? {}),
    },
    deviceId: persisted.deviceId ?? currentState.deviceId,
  };
},
```

- [ ] **Step 4: Run store tests and verify GREEN**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-store.test.ts
```

Expected: all store tests PASS.

- [ ] **Step 5: Write failing settings normalization and error-copy tests**

Add component-level tests proving:

- Pasting `https://dav.jianguoyun.com/dav\u200c` and pressing “测试连接” saves canonical `https://dav.jianguoyun.com/dav/` before invoking the controller.
- A new store renders the auto-sync switch with `aria-checked="true"`.
- `AUTH` displays the dedicated Jianguoyun third-party app-password guidance.
- `FORBIDDEN`, `TIMEOUT`, `SERVER`, and `UNKNOWN` remain sanitized and localized.

- [ ] **Step 6: Run settings tests and verify RED**

Run the existing UI contract test file:

```bash
corepack pnpm exec tsx --test tests/webdav-ui-contract.test.ts
```

Expected: FAIL because UI normalization only trims spaces/slashes and current copy is generic.

- [ ] **Step 7: Reuse shared normalization and update localized copy**

Import `normalizeWebDavBaseUrl` in `WebDavSection.tsx` and set:

```ts
baseUrl: normalizeWebDavBaseUrl(draft.baseUrl).toString(),
```

Do not maintain a second regular expression in the component. Keep username trimming and directory normalization unchanged.

Update Chinese and English WebDAV translation objects with provider-specific authentication guidance. Chinese authentication copy must state that the password is the third-party application password generated under 坚果云“账户信息 → 安全选项 → 第三方应用管理”, not the login password. Keep all error strings free of raw upstream details.

- [ ] **Step 8: Run store, settings, client, and controller tests**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/webdav-store.test.ts \
  tests/webdav-client.test.ts \
  tests/webdav-controller.test.ts \
  tests/webdav-ui-contract.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 9: Run the scoped frontend formatter/linter**

Run:

```bash
standard-lint \
  /Users/bytedance/Downloads/github/magic-resume/.worktrees/pr-webdav-clean/src/store/useWebDavStore.ts \
  /Users/bytedance/Downloads/github/magic-resume/.worktrees/pr-webdav-clean/src/components/settings/WebDavSection.tsx \
  --rule-set one-site-ff9630ec-d4ee-4614-b4fa-195e2b73a74c --format
```

Expected: no errors caused by the changed files; ignore only missing-module diagnostics as allowed by the frontend validation policy.

- [ ] **Step 10: Commit Task 3**

```bash
git add \
  src/store/useWebDavStore.ts \
  src/components/settings/WebDavSection.tsx \
  src/i18n/locales/zh.json \
  src/i18n/locales/en.json \
  tests/webdav-store.test.ts \
  tests/webdav-ui-contract.test.ts
git commit -m "feat(webdav): enable safe Jianguoyun defaults"
```

---

### Task 4: End-to-End Regression, Documentation, and Atomic Production Deployment

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/miaobi-deployment.md`
- Modify: `tests/miaobi-production-contract.test.ts`
- Modify: `tests/miaobi-github-pages-production.test.ts` only if the existing production fixture needs the new API route.

**Interfaces:**
- Consumes: Task 1 proxy route, Task 2 client transport, Task 3 settings behavior, existing GitHub Pages/Miaobi atomic deployment pipeline.
- Produces: documented Jianguoyun configuration and verified production release.

- [ ] **Step 1: Write failing production contract tests**

Extend `tests/miaobi-production-contract.test.ts` to prove the built client contains the Jianguoyun proxy API path and does not contain a direct production fetch target for `https://dav.jianguoyun.com/dav/`. Extend the API bundle runtime test to execute a sanitized proxy request with injected fetch and assert no Node runtime `require` is introduced.

Add a test asserting generated Web FaaS CSP still allows only the current Miaobi API origin for API calls; no new arbitrary WebDAV host is added to browser `connect-src`.

- [ ] **Step 2: Run production contract tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts \
  tests/miaobi-faas-build.test.ts
```

Expected: at least the new proxy-routing contract FAILS before the final integration is present.

- [ ] **Step 3: Update user and deployment documentation**

Document in Chinese and English:

- Server URL: `https://dav.jianguoyun.com/dav/`.
- Username: Jianguoyun account email.
- Password: third-party application password, not login password.
- Jianguoyun traffic uses the fixed-origin Miaobi API FaaS proxy because Jianguoyun does not permit direct browser CORS.
- Credentials remain in browser persistence and are forwarded per request; FaaS does not persist them.
- New configurations enable auto-sync by default; existing explicit settings are preserved.
- Non-Jianguoyun services continue direct browser WebDAV and therefore still require CORS support.

Update deployment documentation to include the new proxy route in API health/manual smoke checks without printing credentials.

- [ ] **Step 4: Run focused WebDAV and Miaobi suites**

Run:

```bash
corepack pnpm test:webdav
corepack pnpm test:miaobi
```

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Build with the exact source commit marker**

Run:

```bash
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm build:miaobi
```

Expected: build exits 0 and `dist/miaobi/api-faas.meta.json` records the exact current 40-character commit.

- [ ] **Step 6: Perform credential-free proxy smoke checks before production**

Execute the built handler or a local API test with fake upstream fetch and confirm:

- unsupported method returns the documented sanitized `4xx`;
- malformed path returns the documented sanitized `4xx`;
- no response contains an Authorization value or submitted password;
- API bundle loads when runtime `require` throws.

Do not attempt a real authenticated Jianguoyun request unless the user supplies credentials through an approved secret channel. Never place credentials in shell history, source, test fixtures, or logs.

- [ ] **Step 7: Request whole-change code review**

Dispatch an independent reviewer with base SHA `ba07901` and current HEAD. Resolve every Critical and Important finding, rerun affected tests, and obtain GO before production deployment.

- [ ] **Step 8: Commit Task 4 documentation and contracts**

```bash
git add \
  README.md \
  README.zh-CN.md \
  docs/miaobi-deployment.md \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts
git commit -m "docs(webdav): document Jianguoyun proxy setup"
```

- [ ] **Step 9: Deploy atomically to GitHub Pages and Miaobi**

Run:

```bash
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm build:miaobi
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm deploy:miaobi
```

Expected deployment order remains: GitHub Pages publication and health, API FaaS publication and health, Web FaaS publication and health, then fixed page switch. If any health check fails, do not manually switch the fixed page.

- [ ] **Step 10: Verify production without exposing credentials**

Verify:

- GitHub Pages latest build status is `built` for the emitted Pages commit.
- Release manifest `sourceCommit` equals current HEAD.
- A representative boot asset returns 200 and matches manifest MIME, size, and SHA-256.
- API health returns 404 `notFound` with current `X-Magic-Resume-Build` and `X-Magic-Resume-Faas: magic-resume-api`.
- Web health returns 200 with the current API URL and graph asset base.
- `https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR` ultimately loads HTML that references the current Web FaaS.
- Built client routes Jianguoyun through `/api/webdav/jianguoyun` and contains no Cloudflare, workers.dev, TOS, or direct Jianguoyun browser dependency.

Ask the user to perform one real “测试连接” with their locally stored credentials after deployment. Do not request that they send the password in chat.

- [ ] **Step 11: Push the verified source commit to the fork**

Only after production verification succeeds:

```bash
git push fork HEAD:main
git ls-remote fork refs/heads/main
```

Expected: remote `refs/heads/main` equals local `git rev-parse HEAD`. Never force-push.

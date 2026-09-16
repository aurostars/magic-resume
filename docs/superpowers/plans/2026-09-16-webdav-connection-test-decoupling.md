# WebDAV Connection Test Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WebDAV “Test connection” execute independently of resume-store hydration while preserving the hydration gate for real synchronization.

**Architecture:** Introduce a small one-shot connection-test service that creates a normal `WebDavClient` and performs `OPTIONS` followed by `PROPFIND`. `WebDavSection` owns only the transient request lifecycle for that action; manual and automatic synchronization continue using the global `WebDavSyncController`. A new safe `CLIENT_NOT_READY` error identifies unavailable synchronization controllers without exposing internals.

**Tech Stack:** TypeScript, React 18, Zustand, next-intl compatibility layer, Node test runner, Testing Library, pnpm, Miaobi FaaS and GitHub Pages release controller.

## Global Constraints

- The connection test must not depend on `useResumeStore._hasHydrated` or `getWebDavSyncController()`.
- Manual and automatic synchronization must retain the existing resume hydration gate.
- The test request order is exactly `OPTIONS` then `PROPFIND` for the normalized remote directory.
- Continue using the existing Jianguoyun fixed proxy, path-segment protocol, 15,000 ms request timeout, status mapping, and credential handling.
- Never display or log password, Authorization, request body, upstream response body, URL query parameters, or raw exception text.
- Do not accept the legacy ambiguous Jianguoyun string-path proxy envelope.
- `CLIENT_NOT_READY` maps to `WD-CLIENT-NOT-READY` with no HTTP status.
- Do not commit `.miaobi/`, `dist/`, quarantine directories, logs, screenshots, or credentials.
- Use TDD: observe each focused test fail before changing production code.

---

## File Structure

- Create `src/lib/webdav/connection-test.ts`: one-shot client construction and `OPTIONS`/`PROPFIND` orchestration.
- Create `tests/webdav-connection-test.test.ts`: focused behavior and error propagation tests.
- Modify `src/lib/webdav/errors.ts`: add `CLIENT_NOT_READY` to the safe error union.
- Modify `src/lib/webdav/diagnostics.ts`: map the new error to a stable diagnostic and localized message key.
- Modify `src/i18n/locales/zh.json` and `src/i18n/locales/en.json`: add actionable controller-not-ready copy.
- Modify `src/components/settings/WebDavSection.tsx`: call the one-shot service for test actions and retain the controller only for sync actions.
- Modify `tests/webdav-diagnostics.test.ts`: cover the new diagnostic.
- Modify `tests/webdav-ui-contract.test.ts`: reproduce the production failure without an injected controller and prove a proxy request occurs.

### Task 1: Explicit Client-Not-Ready Diagnostic

**Files:**
- Modify: `src/lib/webdav/errors.ts`
- Modify: `src/lib/webdav/diagnostics.ts`
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`
- Modify: `tests/webdav-diagnostics.test.ts`
- Modify: `tests/webdav-ui-contract.test.ts`

**Interfaces:**
- Consumes: existing `WebDavSafeError` and `getWebDavDiagnostic`.
- Produces: `WebDavErrorCode` value `CLIENT_NOT_READY`, message key `clientNotReadyError`, and diagnostic `WD-CLIENT-NOT-READY` with `httpStatus: null`.

- [ ] **Step 1: Write failing diagnostic and locale tests**

Add a focused classifier assertion:

```ts
assert.deepEqual(
  getWebDavDiagnostic({ code: "CLIENT_NOT_READY", status: null }, true),
  {
    messageKey: "clientNotReadyError",
    diagnosticCode: "WD-CLIENT-NOT-READY",
    httpStatus: null,
  },
);
```

Add `clientNotReadyError` to the UI locale parity key list and assert the Chinese copy explains that local resume data is not ready and recommends refreshing, without naming internal Store fields.

- [ ] **Step 2: Run tests and verify RED**

```bash
corepack pnpm exec tsx --test \
  tests/webdav-diagnostics.test.ts \
  tests/webdav-ui-contract.test.ts
```

Expected: FAIL because `CLIENT_NOT_READY` and the locale key are absent.

- [ ] **Step 3: Implement the minimal diagnostic**

Add `"CLIENT_NOT_READY"` to `WebDavErrorCode`. Extend `WebDavDiagnosticMessageKey` with `"clientNotReadyError"` and add a classifier branch before generic `UNKNOWN` handling:

```ts
case "CLIENT_NOT_READY":
  return diagnostic("clientNotReadyError", "WD-CLIENT-NOT-READY", null);
```

Add equivalent localized messages:

```json
"clientNotReadyError": "本地简历数据尚未准备完成，请刷新页面后重试。"
```

```json
"clientNotReadyError": "Local resume data is not ready yet. Refresh the page and try again."
```

- [ ] **Step 4: Run tests and verify GREEN**

Run the same focused command. Expected: all tests PASS with zero failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add \
  src/lib/webdav/errors.ts \
  src/lib/webdav/diagnostics.ts \
  src/i18n/locales/zh.json \
  src/i18n/locales/en.json \
  tests/webdav-diagnostics.test.ts \
  tests/webdav-ui-contract.test.ts
git commit -m "feat(webdav): diagnose unavailable sync controller"
```

### Task 2: One-Shot Connection Test Service

**Files:**
- Create: `src/lib/webdav/connection-test.ts`
- Create: `tests/webdav-connection-test.test.ts`

**Interfaces:**
- Consumes: `WebDavClient`, `WebDavClientConfig`, and an optional injected `fetch` for tests.
- Produces:

```ts
export interface WebDavConnectionTestSettings extends WebDavClientConfig {
  remoteDirectory: string;
}

export async function testWebDavConnection(
  settings: WebDavConnectionTestSettings,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<void>;
```

- [ ] **Step 1: Write failing service tests**

Use the real `WebDavClient` with an injected fetch recorder. Assert:

```ts
await testWebDavConnection(settings, undefined, fetchImpl);
assert.deepEqual(calls.map((call) => call.method), ["OPTIONS", "PROPFIND"]);
assert.equal(new URL(calls[0].url).pathname, "/dav/magic-resume/");
assert.equal(new URL(calls[1].url).pathname, "/dav/magic-resume/");
```

Use a non-Jianguoyun HTTPS fixture URL so the injected transport observes direct WebDAV requests without invoking production runtime configuration. Add separate tests proving:

- `OPTIONS` failure stops before `PROPFIND` and preserves `WebDavError` code/status;
- `PROPFIND` failure is propagated;
- the same caller `AbortSignal` reaches both requests;
- the service has no dependency on `useResumeStore` or controller construction.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
corepack pnpm exec tsx --test tests/webdav-connection-test.test.ts
```

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement the minimal service**

```ts
import { WebDavClient, type WebDavClientConfig } from "./client";

export interface WebDavConnectionTestSettings extends WebDavClientConfig {
  remoteDirectory: string;
}

export async function testWebDavConnection(
  settings: WebDavConnectionTestSettings,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const client = new WebDavClient(settings, fetchImpl);
  await client.options(settings.remoteDirectory, signal);
  await client.propfind(settings.remoteDirectory, signal);
}
```

Do not import any Store, repository, coordinator, or controller module.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused test. Expected: all service tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/webdav/connection-test.ts tests/webdav-connection-test.test.ts
git commit -m "feat(webdav): add one-shot connection test"
```

### Task 3: Settings UI Integration and Production Regression

**Files:**
- Modify: `src/components/settings/WebDavSection.tsx:1-115`
- Modify: `tests/webdav-ui-contract.test.ts`

**Interfaces:**
- Consumes: `testWebDavConnection(normalized, signal)` from Task 2 and existing `controllerProvider()` for sync only.
- Produces: a test action that performs real client I/O independent of the controller, plus `CLIENT_NOT_READY` for sync-only controller absence.

- [ ] **Step 1: Add the real regression test before changing the component**

Render `Providers` and `WebDavSection` without injecting a controller. Keep `useResumeStore._hasHydrated` false, type a complete Jianguoyun configuration through real input events, and click “Test connection”. Stub only `globalThis.fetch` and record the API envelope.

Assert that the fixed behavior sends two POST requests to the configured Miaobi API route whose decoded methods are `OPTIONS` and `PROPFIND`, both target `pathSegments: ["magic-resume"]`, and neither request contains plaintext Authorization headers outside the safe envelope contract. Before the fix, assert RED evidence: request count is zero and the UI shows `WD-CLIENT-UNKNOWN`.

Add a separate “Sync now” case with no controller and assert `WD-CLIENT-NOT-READY` and zero fetch calls.

- [ ] **Step 2: Run the focused UI test and verify RED**

```bash
corepack pnpm exec tsx --test tests/webdav-ui-contract.test.ts
```

Expected: the connection-test regression fails because the component still requires `controllerProvider()`.

- [ ] **Step 3: Integrate the one-shot service**

Import `testWebDavConnection`. In `run`, branch before reading the controller:

```ts
if (action === "test") {
  const requestController = new AbortController();
  const store = useWebDavStore.getState();
  store.beginRequest(requestController, "testing");
  try {
    await testWebDavConnection(normalized, requestController.signal);
    store.finishRequest("success");
  } catch (caught) {
    store.finishRequest("error");
    const safeError = caught instanceof WebDavError
      ? caught
      : new WebDavError("UNKNOWN");
    store.setError({ code: safeError.code, status: safeError.status });
    throw safeError;
  }
  return;
}

const controller = controllerProvider();
if (!controller) {
  useWebDavStore.getState().setError({ code: "CLIENT_NOT_READY", status: null });
  return;
}
await controller.syncNow("manual");
```

Remove the `setTimeout(0)` controller wait because test no longer uses the controller and synchronization cannot safely manufacture readiness. Preserve existing duplicate-action disabling.

Track the one-shot `AbortController` in a ref, clear it after completion, and abort it in an unmount cleanup. Do not abort the global synchronization controller from this cleanup.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
corepack pnpm exec tsx --test \
  tests/webdav-connection-test.test.ts \
  tests/webdav-diagnostics.test.ts \
  tests/webdav-ui-contract.test.ts
```

Expected: all focused tests PASS, including the production regression.

- [ ] **Step 5: Run WebDAV regression tests**

```bash
corepack pnpm test:webdav
```

Expected: all WebDAV tests PASS with zero failures.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/components/settings/WebDavSection.tsx tests/webdav-ui-contract.test.ts
git commit -m "fix(webdav): decouple connection test from hydration"
```

### Task 4: Review, Release, and Production Verification

**Files:**
- No production source changes unless review identifies a real defect and a failing regression test is added first.
- Never commit generated deployment artifacts.

**Interfaces:**
- Consumes: reviewed Tasks 1–3.
- Produces: a verified GitHub Pages release, fresh API/Web FaaS IDs, switched fixed page, and updated `fork/main`.

- [ ] **Step 1: Run release tests sequentially**

Do not run build-mutating Miaobi suites concurrently:

```bash
corepack pnpm test:webdav
corepack pnpm exec tsx --test \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts \
  tests/miaobi-faas-build.test.ts
corepack pnpm test:miaobi
corepack pnpm test:ai
```

Expected: every command exits `0` with zero failures.

- [ ] **Step 2: Build the exact reviewed HEAD**

```bash
export MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)"
corepack pnpm build:miaobi
```

Verify `dist/miaobi/api-faas.meta.json.gitCommit` equals the full 40-character HEAD.

- [ ] **Step 3: Complete task-level and whole-branch reviews**

Review every task after its commit. The final reviewer receives the design, plan, complete diff from `16b437536843c1c0b9bae78da8e4ecf7b62b914d` to HEAD, test evidence, and all deferred minors. Fix every Critical or Important finding with a failing regression test before release.

- [ ] **Step 4: Deploy with the fenced controller**

```bash
export MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)"
corepack pnpm deploy:miaobi
```

If GitHub Pages is still building, poll until `built` before retrying. Do not manually bypass generation fencing or switch the fixed page out of order.

- [ ] **Step 5: Verify production resources**

Confirm:

- Pages manifest `sourceCommit` equals HEAD;
- representative asset MIME, size, and SHA-256 match the manifest;
- API build marker equals HEAD;
- Web FaaS runtime points to the new API FaaS and Pages graph;
- fixed page points to the new Web FaaS;
- malformed proxy request is sanitized and `Cache-Control: no-store` remains present.

- [ ] **Step 6: Verify the original symptom in a local browser**

Using only safe invalid credentials, fill the production settings form through normal input events and click “Test connection”. Confirm the browser sends the Jianguoyun proxy request and the UI shows `WD-AUTH-401`, not `WD-CLIENT-UNKNOWN`. Clear the test credentials afterward. Do not inspect or use the user's real credentials.

- [ ] **Step 7: Push verified source**

```bash
git diff --check
git push fork HEAD:main
test "$(git ls-remote fork refs/heads/main | cut -f1)" = "$(git rev-parse HEAD)"
```

Never force-push. Keep the worktree and `.miaobi/` deployment state local.

# WebDAV Safe Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace generic WebDAV failures with safe, actionable diagnostic codes and HTTP status information without exposing credentials or upstream response details.

**Architecture:** Add a pure diagnostic classifier beside the existing WebDAV error types, then let `WebDavSection` render its message key, stable diagnostic code, and validated HTTP status. The store remains the security boundary and continues retaining only `{ code, status }`; no logs, telemetry, protocol compatibility fallback, or credential persistence changes are introduced.

**Tech Stack:** TypeScript, React 18, next-intl compatibility layer, Zustand, Node test runner, Testing Library, pnpm.

## Global Constraints

- Never display or log password, Authorization, request body, upstream response body, URL query parameters, or raw exception text.
- Continue rejecting the legacy ambiguous Jianguoyun string-path proxy envelope; do not restore backward compatibility for it.
- Do not change WebDAV synchronization, automatic directory creation, or non-Jianguoyun direct transport behavior.
- Only HTTP integers from `100` through `599` may be displayed.
- New diagnostics are transient and must not be included in persisted WebDAV state.
- Use TDD: observe each focused test fail before changing production code.

---

## File Structure

- Create `src/lib/webdav/diagnostics.ts`: pure mapping from safe error state/provider to message key, diagnostic code, and validated HTTP status.
- Create `tests/webdav-diagnostics.test.ts`: focused classifier and sanitization tests.
- Modify `src/components/settings/WebDavSection.tsx`: consume the classifier and render diagnostic metadata.
- Modify `src/i18n/locales/zh.json`: Chinese proxy-version guidance and diagnostic labels.
- Modify `src/i18n/locales/en.json`: equivalent English copy.
- Modify `tests/webdav-ui-contract.test.ts`: localized rendering and secret-exclusion regression tests.

### Task 1: Pure Safe Diagnostic Classifier

**Files:**
- Create: `src/lib/webdav/diagnostics.ts`
- Create: `tests/webdav-diagnostics.test.ts`

**Interfaces:**
- Consumes: `WebDavSafeError` from `src/store/useWebDavStore.ts`.
- Produces:
  ```ts
  export type WebDavDiagnosticMessageKey =
    | "newerSnapshotError" | "corruptSnapshotError" | "jianguoyunAuthError"
    | "authError" | "forbiddenError" | "networkError" | "timeoutError"
    | "directoryError" | "quotaError" | "proxyProtocolError" | "unknownError";

  export interface WebDavDiagnostic {
    messageKey: WebDavDiagnosticMessageKey;
    diagnosticCode: string;
    httpStatus: number | null;
  }

  export function getWebDavDiagnostic(
    error: WebDavSafeError,
    jianguoyun: boolean,
  ): WebDavDiagnostic;
  ```

- [ ] **Step 1: Write failing classifier tests**

Create table-driven tests that assert at least:

```ts
assert.deepEqual(
  getWebDavDiagnostic({ code: "UNKNOWN", status: 400 }, true),
  { messageKey: "proxyProtocolError", diagnosticCode: "WD-PROXY-400", httpStatus: 400 },
);
assert.deepEqual(
  getWebDavDiagnostic({ code: "AUTH", status: 401 }, true),
  { messageKey: "jianguoyunAuthError", diagnosticCode: "WD-AUTH-401", httpStatus: 401 },
);
assert.deepEqual(
  getWebDavDiagnostic({ code: "SERVER", status: 502 }, true),
  { messageKey: "networkError", diagnosticCode: "WD-UPSTREAM-502", httpStatus: 502 },
);
assert.deepEqual(
  getWebDavDiagnostic({ code: "UNKNOWN", status: null }, true),
  { messageKey: "unknownError", diagnosticCode: "WD-CLIENT-UNKNOWN", httpStatus: null },
);
```

Also cover `FORBIDDEN/403`, `NOT_FOUND/404`, `DIRECTORY/409`, `QUOTA/507`, `TIMEOUT`, `NETWORK`, non-Jianguoyun `UNKNOWN/400`, snapshot validation errors, and invalid runtime statuses such as `NaN`, `99`, `600`, and `401.5` via a narrowly typed test cast.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-diagnostics.test.ts
```

Expected: FAIL because `src/lib/webdav/diagnostics.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure classifier**

Use a private status validator:

```ts
const safeHttpStatus = (status: number | null): number | null =>
  Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : null;
```

Generate only constant prefixes plus validated status values. Preserve the current localized message categories except that exact Jianguoyun `UNKNOWN/400` maps to `proxyProtocolError`. Ensure `SERVER/502` maps to `WD-UPSTREAM-502`, while other server failures use `WD-SERVER-<status>` or `WD-SERVER`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-diagnostics.test.ts
```

Expected: all classifier tests PASS with zero failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/webdav/diagnostics.ts tests/webdav-diagnostics.test.ts
git commit -m "feat(webdav): classify safe diagnostics"
```

### Task 2: Localized Diagnostic Rendering

**Files:**
- Modify: `src/components/settings/WebDavSection.tsx:49-63,141-156,230-260`
- Modify: `src/i18n/locales/zh.json:228-238`
- Modify: `src/i18n/locales/en.json` matching WebDAV locale block
- Modify: `tests/webdav-ui-contract.test.ts:77-88,367-412`

**Interfaces:**
- Consumes: `getWebDavDiagnostic(error, jianguoyun)` from Task 1.
- Produces: an alert containing localized guidance, `diagnosticLabel`, diagnostic code, and optional `httpStatusLabel`.

- [ ] **Step 1: Update UI tests first**

Extend locale parity requirements with:

```ts
"proxyProtocolError", "diagnosticLabel", "httpStatusLabel"
```

Add assertions equivalent to:

```ts
useWebDavStore.getState().setSettings({ baseUrl: "https://dav.jianguoyun.com/dav/" });
useWebDavStore.getState().setError({ code: "UNKNOWN", status: 400 });
renderLocalized(React.createElement(WebDavSection), zh);
const alert = screen.getByRole("alert");
assert.match(alert.textContent ?? "", /请强制刷新页面/);
assert.match(alert.textContent ?? "", /诊断码：WD-PROXY-400/);
assert.match(alert.textContent ?? "", /HTTP 400/);
```

Add separate cases for `WD-AUTH-401`, `WD-UPSTREAM-502`, and `WD-CLIENT-UNKNOWN`. Inject unsafe extra fields into store input and assert the alert excludes their values, `Authorization`, and the submitted password marker.

- [ ] **Step 2: Run the UI contract test and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-ui-contract.test.ts
```

Expected: FAIL because the new locale keys and rendered diagnostics are absent.

- [ ] **Step 3: Add equivalent localized copy**

Add Chinese strings:

```json
"proxyProtocolError": "请求格式与当前服务版本不兼容，请强制刷新页面后重试。",
"diagnosticLabel": "诊断码：{code}",
"httpStatusLabel": "HTTP {status}"
```

Add equivalent English strings using the same placeholders. Keep authentication guidance provider-specific.

- [ ] **Step 4: Integrate diagnostics into `WebDavSection`**

Remove the private `errorKey` switch and import `getWebDavDiagnostic`. Derive diagnostics only when `error` exists:

```ts
const diagnostic = error ? getWebDavDiagnostic(error, jianguoyun) : null;
const statusMessage = diagnostic
  ? t(diagnostic.messageKey)
  : warning
    ? t("nonAtomicWarning")
    : /* existing busy/success behavior */;
```

Inside the existing error alert, render the localized message and a separate metadata line:

```tsx
<p>{statusMessage}</p>
{diagnostic && (
  <p className="mt-1 text-xs">
    {t("diagnosticLabel", { code: diagnostic.diagnosticCode })}
    {diagnostic.httpStatus === null
      ? null
      : ` · ${t("httpStatusLabel", { status: diagnostic.httpStatus })}`}
  </p>
)}
```

Do not render metadata for success, progress, warnings, or conflicts.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/webdav-diagnostics.test.ts \
  tests/webdav-ui-contract.test.ts
```

Expected: all focused tests PASS and no alert contains injected unsafe fields.

- [ ] **Step 6: Run the WebDAV regression suite**

Run:

```bash
corepack pnpm test:webdav
```

Expected: all WebDAV tests PASS with zero failures.

- [ ] **Step 7: Commit Task 2**

```bash
git add \
  src/components/settings/WebDavSection.tsx \
  src/i18n/locales/zh.json \
  src/i18n/locales/en.json \
  tests/webdav-ui-contract.test.ts
git commit -m "feat(webdav): show safe diagnostic codes"
```

### Task 3: Production Contract, Review, and Release

**Files:**
- Modify only if a failing production-contract test exposes a missing required assertion.
- Do not commit `.miaobi/`, `dist/`, quarantine directories, logs, screenshots, or credentials.

**Interfaces:**
- Consumes: reviewed commits from Tasks 1 and 2.
- Produces: verified GitHub Pages release, fresh API/Web FaaS IDs, switched fixed page, and updated `fork/main`.

- [ ] **Step 1: Run scoped formatting/lint checks**

Run `standard-lint` only on changed TypeScript/TSX files if available. Ignore only missing-module diagnostics as allowed by the frontend validation policy; fix all syntax, formatting, and rule errors caused by this change.

- [ ] **Step 2: Run release-relevant tests sequentially**

Do not run Miaobi build-mutating suites concurrently. Run:

```bash
corepack pnpm test:webdav
corepack pnpm exec tsx --test \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts \
  tests/miaobi-faas-build.test.ts
corepack pnpm test:miaobi
```

Expected: every command exits `0` with zero failing tests.

- [ ] **Step 3: Build the exact reviewed commit**

```bash
export MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)"
corepack pnpm build:miaobi
```

Verify `dist/miaobi/api-faas.meta.json.gitCommit` equals the full 40-character HEAD.

- [ ] **Step 4: Request independent code review**

Provide the reviewer the design path, plan path, base SHA `65169c34cb5914aec3b85bfa05b2660ecee0b1c1`, current HEAD, changed-file diff, and requirements. Fix every Critical or Important finding with a new failing regression test before release.

- [ ] **Step 5: Deploy through the existing fenced controller**

```bash
export MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)"
corepack pnpm deploy:miaobi
```

If Pages is still building, poll its actual build state and retry only after it reaches `built`. Do not bypass generation fencing or manually switch the fixed page.

- [ ] **Step 6: Verify production**

Confirm:

- GitHub Pages release manifest `sourceCommit` equals HEAD.
- Representative `index.html` status, MIME, size, and SHA-256 match the manifest.
- API non-existent path returns `404` with current build/FaaS headers.
- Credential-free malformed Jianguoyun request returns sanitized `400` with `Cache-Control: no-store`.
- Web FaaS runtime points to the new API FaaS and GitHub Pages graph.
- Fixed page reaches the new Web FaaS.
- A safe UI reproduction displays `WD-PROXY-400` without raw request data.

- [ ] **Step 7: Push the verified source commit**

```bash
git diff --check
git push fork HEAD:main
test "$(git ls-remote fork refs/heads/main | cut -f1)" = "$(git rev-parse HEAD)"
```

Never force-push. Keep `.miaobi/` local and untracked.

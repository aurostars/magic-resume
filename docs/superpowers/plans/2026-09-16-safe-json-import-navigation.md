# Safe JSON Import Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make valid legacy Magic Resume JSON imports close the import dialog completely before navigating, preventing Radix scroll-lock cleanup from touching a destroyed Miaobi document.

**Architecture:** Add a focused React hook that consumes a pending resume ID only after the dialog is closed and one animation frame has elapsed. `ResumeWorkbench` will parse and save the JSON exactly as today, but it will queue the new ID and close the dialog instead of navigating synchronously. The hook is independently exercised with JSDOM and Testing Library; production is verified with the anonymized structural equivalent of the supplied legacy export.

**Tech Stack:** React 18, TypeScript, TanStack Router, Radix Dialog, Node test runner through `tsx --test`, JSDOM, Testing Library, Vite/Miaobi deployment scripts.

## Global Constraints

- Valid legacy and current Magic Resume JSON exports must remain importable without changing their resume content.
- Navigation must happen only after the import dialog is closed and its subtree has unmounted.
- A successful import must navigate exactly once to `/app/workbench/$id`.
- Do not use a fixed millisecond delay or depend on Miaobi host internals.
- Parse/import failures must keep the existing error path and must not queue navigation.
- Do not upgrade or replace the shared Dialog/scroll-lock dependencies.
- Do not commit `.miaobi/`, `dist/`, screenshots, logs, user fixture content, or temporary artifacts.

---

### Task 1: Deferred dialog navigation hook

**Files:**
- Create: `src/hooks/useDeferredDialogNavigation.ts`
- Create: `tests/deferred-dialog-navigation.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface DeferredDialogNavigationOptions {
    isDialogOpen: boolean;
    pendingId: string | null;
    clearPendingId: () => void;
    navigate: (id: string) => void;
  }

  export function useDeferredDialogNavigation(
    options: DeferredDialogNavigationOptions,
  ): void;
  ```
- Behavior: no scheduling while `isDialogOpen` is `true` or `pendingId` is `null`; after close, schedule one `requestAnimationFrame`, clear the pending ID before navigation, cancel an uncommitted frame on effect cleanup.

- [ ] **Step 1: Write the failing lifecycle tests**

Create a JSDOM harness that calls the hook and records `navigate` calls. Add tests equivalent to:

```tsx
it("waits until the dialog is closed and the next frame before navigating", () => {
  const calls: string[] = [];
  const view = render(<Harness open pendingId="resume-1" onNavigate={(id) => calls.push(id)} />);
  assert.deepEqual(calls, []);

  view.rerender(<Harness open={false} pendingId="resume-1" onNavigate={(id) => calls.push(id)} />);
  assert.deepEqual(calls, []);

  flushAnimationFrame();
  assert.deepEqual(calls, ["resume-1"]);
});
```

Also cover rerenders/Strict Mode producing only one navigation and unmount cancelling the queued frame.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/deferred-dialog-navigation.test.tsx
```

Expected: FAIL because `useDeferredDialogNavigation` does not exist.

- [ ] **Step 3: Implement the minimal hook**

Implement the hook with callback refs plus an effect keyed only by dialog state and pending ID:

```ts
const clearPendingIdRef = useRef(clearPendingId);
const navigateRef = useRef(navigate);
clearPendingIdRef.current = clearPendingId;
navigateRef.current = navigate;

useEffect(() => {
  if (isDialogOpen || !pendingId) return;

  const resumeId = pendingId;
  const frame = window.requestAnimationFrame(() => {
    clearPendingIdRef.current();
    navigateRef.current(resumeId);
  });

  return () => window.cancelAnimationFrame(frame);
}, [isDialogOpen, pendingId]);
```

Callback identity changes must not cancel and recreate an already scheduled frame; clearing the pending ID must happen before navigation to preserve the exactly-once guarantee.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
corepack pnpm exec tsx --test tests/deferred-dialog-navigation.test.tsx
```

Expected: all tests in the file pass with no unhandled errors.

- [ ] **Step 5: Commit Task 1**

Commit only the hook and its test:

```bash
git add src/hooks/useDeferredDialogNavigation.ts tests/deferred-dialog-navigation.test.tsx
git commit -m "fix: defer navigation until dialog cleanup"
```

### Task 2: Integrate deferred navigation into JSON import

**Files:**
- Modify: `src/app/app/dashboard/resumes/ResumeWorkbench.tsx:1-280`
- Create: `tests/json-import-navigation-contract.test.ts`

**Interfaces:**
- Consumes: `useDeferredDialogNavigation(options)` from Task 1.
- Produces: JSON import queues the generated resume ID, closes `ImportResumeDialog`, and lets the hook navigate after cleanup.

- [ ] **Step 1: Write the failing integration contract**

Create a contract test that reads `ResumeWorkbench.tsx` and verifies the import handler no longer calls `router.push` in the same block that parses and adds the resume. It must also verify the component wires:

```ts
const [pendingImportedResumeId, setPendingImportedResumeId] = useState<string | null>(null);

useDeferredDialogNavigation({
  isDialogOpen: isImportDialogOpen,
  pendingId: pendingImportedResumeId,
  clearPendingId: () => setPendingImportedResumeId(null),
  navigate: (id) => router.push({ to: "/app/workbench/$id", params: { id } }),
});
```

The test must isolate the `importResumeFromJson` function body and fail if it contains `router.push`.

- [ ] **Step 2: Run the integration contract and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/json-import-navigation-contract.test.ts
```

Expected: FAIL because import still navigates synchronously and no deferred hook is wired.

- [ ] **Step 3: Apply the minimal component change**

In `ResumeWorkbench`:

1. Add `pendingImportedResumeId` state.
2. Wire `useDeferredDialogNavigation` near the component’s other lifecycle hooks.
3. Keep JSON parsing, ID generation, timestamps, `addResume`, and success toast unchanged.
4. Replace the successful import tail:

```ts
setIsImportDialogOpen(false);
setActiveResume(newId);
router.push({ to: "/app/workbench/$id", params: { id: newId } });
```

with:

```ts
setPendingImportedResumeId(newId);
setIsImportDialogOpen(false);
```

Do not queue an ID in the catch path.

- [ ] **Step 4: Run focused and adjacent tests**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/deferred-dialog-navigation.test.tsx \
  tests/json-import-navigation-contract.test.ts \
  tests/resume-import.test.ts
```

Expected: all tests pass. Then run:

```bash
corepack pnpm test:ai
```

Expected: all repository Node tests pass; existing documented warnings may remain, but no new failures or unhandled errors are allowed.

- [ ] **Step 5: Commit Task 2**

Commit only the integration and tests:

```bash
git add src/app/app/dashboard/resumes/ResumeWorkbench.tsx tests/json-import-navigation-contract.test.ts
git commit -m "fix: import resumes after dialog cleanup"
```

- [ ] **Step 6: Build the committed Miaobi production bundle**

Run:

```bash
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm build:miaobi
```

Expected: exit 0, build metadata contains the exact committed HEAD, and no new TypeScript/bundle error is introduced.

### Task 3: Review, deploy, and production acceptance

**Files:**
- No committed source files unless review finds a task-scoped defect with a failing regression test.
- Keep release metadata and browser artifacts untracked.

**Interfaces:**
- Consumes: the completed hook and `ResumeWorkbench` integration.
- Produces: a Miaobi release whose manifest and FaaS build markers match the final Git HEAD, with `fork/main` updated only after production acceptance.

- [ ] **Step 1: Run final verification from the exact HEAD**

Run sequentially:

```bash
corepack pnpm exec tsx --test \
  tests/deferred-dialog-navigation.test.tsx \
  tests/json-import-navigation-contract.test.ts \
  tests/resume-import.test.ts
corepack pnpm test:webdav
corepack pnpm exec tsx --test \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts \
  tests/miaobi-faas-build.test.ts
corepack pnpm test:miaobi
corepack pnpm test:ai
git diff --check
```

Expected: all commands exit 0; report exact test counts rather than only “passed.”

- [ ] **Step 2: Perform independent code review**

Review the final diff for lifecycle ordering, exactly-once navigation, stale frame cancellation, preservation of import data, and absence of fixed delays. Resolve every Critical or Important finding before deployment.

- [ ] **Step 3: Build and deploy the exact reviewed HEAD**

Run:

```bash
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm build:miaobi
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm deploy:miaobi
```

If GitHub Pages is still building, wait until its state is `built` and rerun the deployment health step. Verify release manifest `sourceCommit`, representative asset MIME/size/hash, API FaaS build marker, Web FaaS runtime config, fixed page routing, and sanitized/no-store API errors.

- [ ] **Step 4: Verify the supplied legacy format in the production browser**

Use only the AIME local browser. Import an anonymized copy preserving the supplied file’s structure and embedded image characteristics. Verify:

- the import dialog closes;
- the browser navigates once to `/app/workbench/<new-id>`;
- no `Cannot read properties of null (reading 'style')` or `getAttribute` error occurs;
- the route does not enter the error boundary;
- the resume preview renders.

Delete the test resume and clear any browser test data created by acceptance.

- [ ] **Step 5: Push and verify the remote SHA**

After production acceptance:

```bash
git push fork HEAD:main
test "$(git ls-remote fork refs/heads/main | cut -f1)" = "$(git rev-parse HEAD)"
```

Do not force push. Confirm the working tree contains only the pre-existing untracked `.miaobi/` directory.

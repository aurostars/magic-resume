# Default Dashboard Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every deployment redirect its root URL directly to the resume dashboard while preserving explicit localized landing-page URLs.

**Architecture:** Change the single TanStack Router root-route redirect from the locale landing page to `/app/dashboard/resumes`. Protect the behavior with a focused source contract test and retain the existing Miaobi Hash History implementation so the deployed URL resolves to `#/app/dashboard/resumes` without rendering the landing page first.

**Tech Stack:** React 18, TypeScript, TanStack Router, Node test runner through `tsx --test`, Miaobi Hash History and deployment scripts.

## Global Constraints

- All deployments must redirect `/` to `/app/dashboard/resumes`.
- Explicit `/zh`, `/en`, and other existing localized landing-page routes must remain available.
- Do not change resume data, local storage, WebDAV, import, create-resume, or dashboard behavior.
- Do not add asynchronous redirects, component-mounted navigation, or fixed delays.
- Do not commit `.miaobi/`, `dist/`, screenshots, logs, or release artifacts.
- Publish only the exact reviewed and committed Git HEAD.

---

### Task 1: Root route dashboard redirect

**Files:**
- Create: `tests/root-route-contract.test.ts`
- Modify: `src/routes/index.tsx:1-9`

**Interfaces:**
- Consumes: TanStack Router `createFileRoute` and `redirect`.
- Produces: root-route `beforeLoad` that throws `redirect({ to: "/app/dashboard/resumes" })` for every runtime and locale.

- [ ] **Step 1: Write the failing root-route contract test**

Create `tests/root-route-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL("../src/routes/index.tsx", import.meta.url);

test("root route redirects directly to the resume dashboard", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /redirect\(\{\s*to: "\/app\/dashboard\/resumes"\s*\}\)/);
  assert.doesNotMatch(source, /getPreferredLocale/);
  assert.doesNotMatch(source, /to: "\/\$locale"/);
});
```

This contract names the production change that makes the test pass: replacing the locale-dependent root redirect with the dashboard redirect.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/root-route-contract.test.ts
```

Expected: FAIL because `src/routes/index.tsx` still imports and calls `getPreferredLocale` and redirects to `/$locale`.

- [ ] **Step 3: Implement the minimal root-route change**

Replace `src/routes/index.tsx` with:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/app/dashboard/resumes" });
  },
});
```

Do not change localized route files or landing-page components.

- [ ] **Step 4: Run focused and adjacent tests and verify GREEN**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/root-route-contract.test.ts \
  tests/miaobi-router-contract.test.ts
```

Expected: both test files pass with no new unhandled errors. The existing Miaobi history tests must continue to prove that `/app/dashboard/resumes` is represented as `#/app/dashboard/resumes` under the Miaobi runtime.

- [ ] **Step 5: Run the relevant Miaobi production contracts**

Run:

```bash
corepack pnpm exec tsx --test \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts \
  tests/miaobi-faas-build.test.ts

git diff --check
```

Expected: all tests pass and `git diff --check` exits 0.

- [ ] **Step 6: Commit Task 1**

Commit only the route and its test:

```bash
git add src/routes/index.tsx tests/root-route-contract.test.ts
git commit -m "feat: open resume dashboard by default"
```

### Task 2: Review, deploy, and production acceptance

**Files:**
- No committed source files unless review finds a task-scoped defect reproduced by a failing regression test.
- Keep generated release metadata and browser artifacts untracked.

**Interfaces:**
- Consumes: the committed root-route redirect from Task 1 and the existing Miaobi build/deploy pipeline.
- Produces: a Miaobi release whose fixed page opens `#/app/dashboard/resumes`, while explicit `#/zh` still renders the landing page.

- [ ] **Step 1: Review the exact committed diff**

Review for:

- root redirect is deployment-independent;
- no locale landing route or component is removed;
- no component-mounted navigation or render-time flash is introduced;
- test assertions describe user-visible behavior without depending on generated route artifacts.

Resolve every Critical or Important finding before deployment, using a failing regression test first for any code change.

- [ ] **Step 2: Verify the exact reviewed HEAD**

Run sequentially:

```bash
corepack pnpm exec tsx --test \
  tests/root-route-contract.test.ts \
  tests/miaobi-router-contract.test.ts
corepack pnpm exec tsx --test \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts \
  tests/miaobi-faas-build.test.ts
git diff --check
git status --short
```

Expected: all tests pass; the only pre-existing untracked path may be `.miaobi/`; no generated artifact is staged.

- [ ] **Step 3: Build and deploy the exact reviewed HEAD**

Run:

```bash
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm build:miaobi
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm deploy:miaobi
```

Verify the published manifest `sourceCommit`, GitHub Pages asset graph, API FaaS build marker, Web FaaS runtime configuration, and fixed page binding all match the exact committed HEAD.

- [ ] **Step 4: Verify the fixed production entry with the AIME local browser**

Open the fixed page in a new AIME browser tab:

```text
https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR
```

Verify:

- the final hash route is `#/app/dashboard/resumes`;
- the landing-page hero and “立即开始” button never appear;
- the “我的简历” heading and the existing resume list or empty state render normally;
- no new page errors occur;
- no static resource request returns 404;
- explicitly navigating to `#/zh` still renders the landing page.

Close the acceptance tab after verification.

- [ ] **Step 5: Push only after production acceptance**

After production acceptance, push the current branch commit to `fork/main` without force:

```bash
git push fork HEAD:main
```

Verify:

```bash
git ls-remote fork refs/heads/main
```

Expected: remote `fork/main` SHA exactly equals local `git rev-parse HEAD`.

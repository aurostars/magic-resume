# GitHub Pages Static Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Miaobi TOS asset publication with immutable, content-addressed assets on the fork repository's public `gh-pages` branch while keeping the user-facing application on `magic.solutionsuite.cn`.

**Architecture:** Build the existing Miaobi SPA locally, transform the complete client tree into immutable `objects/<sha256>/<filename>` entries, and publish a release manifest through an isolated `gh-pages` worktree. Verify GitHub Pages bytes and MIME before creating new Miaobi API/Web FaaS instances; switch fixed page `vv6BtLE8MTR` last through the existing generation-fenced deployment state machine.

**Tech Stack:** TypeScript, Node.js 20, Git, GitHub CLI, GitHub Pages, React/TanStack Start, esbuild, Node test runner + tsx.

## Global Constraints

- User-visible entry and FaaS URLs remain under `https://magic.solutionsuite.cn/`.
- Static assets use `https://aurostars.github.io/magic-resume/`; do not use `raw.githubusercontent.com`, jsDelivr, TOS, or Cloudflare at runtime.
- The GitHub source remote is `fork` and must resolve exactly to `aurostars/magic-resume`; never push asset commits to `origin`.
- Use a public `gh-pages` branch and ordinary non-force pushes only.
- Objects are immutable and content-addressed; releases and old FaaS instances are never deleted automatically.
- Publish the complete browser client resource closure, excluding source maps, dotfiles, server bundles, tests, local state, credentials, and absolute local paths.
- GitHub Pages publication and byte/MIME health checks complete before any new Miaobi FaaS is created.
- Every release creates new API/Web FaaS instances; the fixed Miaobi page switches only after all checks pass.
- Existing generation fencing, immutable pending/state records, durability preflight, and `MIAOBI_PAGE_RESULT_UNCERTAIN` behavior remain authoritative.
- WebDAV credentials and resume data remain browser-local and are never committed, logged, or sent to publication services.
- Existing Cloudflare build/deployment files remain available only as rollback; do not delete the Cloudflare deployment.
- No new runtime dependency. Build/test-only dependencies require explicit justification.

---

### Task 1: Content-addressed GitHub Pages asset tree

**Files:**
- Create: `scripts/miaobi/github-pages-assets.ts`
- Modify: `scripts/miaobi/types.ts`
- Test: `tests/miaobi-github-pages-assets.test.ts`

**Interfaces:**

```ts
export interface GitHubPagesAssetRecord extends MiaobiAssetRecord {
  objectPath: `objects/${string}/${string}`;
  size: number;
}

export interface GitHubPagesManifest extends MiaobiAssetManifest {
  provider: "github-pages";
  sourceCommit: string;
  files: Record<string, GitHubPagesAssetRecord>;
}

export async function materializeGitHubPagesRelease(input: {
  clientDirectory: string;
  pagesDirectory: string;
  sourceCommit: string;
  releaseId: string;
  pagesOrigin: "https://aurostars.github.io";
  pagesBasePath: "/magic-resume/";
}): Promise<{
  manifest: GitHubPagesManifest;
  releaseDirectory: string;
  createdObjectPaths: string[];
}>;
```

- Object path: `objects/<graph-sha256>/<original-relative-path>`.
- `graph-sha256` is computed from the canonical, sorted client tree before substituting the fixed asset-root placeholder; each final file also keeps its own byte SHA-256 in the manifest.
- Release path: `releases/<40-char-source-commit>/`.
- Public URL: `https://aurostars.github.io/magic-resume/<objectPath>`.

- [ ] **Step 1: Write failing complete-tree and filtering tests**

Create a temporary client tree containing nested JS/CSS, fonts, template snapshots, SVG/PNG, dotfiles, `.map`, server/test files and symlinks. Assert the complete allowed tree is represented while forbidden entries and symlink escapes are rejected.

```ts
assert.deepEqual(Object.keys(result.manifest.files).sort(), [
  "assets/app.js",
  "assets/style.css",
  "fonts/default.woff2",
  "template-snapshots/default.png",
]);
assert.equal(await exists(join(pagesDir, ".env")), false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/miaobi-github-pages-assets.test.ts
```

Expected: FAIL because `materializeGitHubPagesRelease` does not exist.

- [ ] **Step 3: Implement safe snapshot and content-addressed objects**

Open files with no-follow semantics where supported, verify file and ancestor identities, snapshot bytes before writing output, compute SHA-256 from final bytes, and publish objects with exclusive hard-link/rename semantics. Existing object paths must be byte-identical or fail closed.

- [ ] **Step 4: Implement deterministic text reference rewriting**

Rewrite only HTML, JS, MJS, CSS, SVG, JSON, TXT and XML references from the build placeholder to the release's fixed graph-root URL. Because every file in one release shares the precomputed graph hash, references remain stable even when bundles contain cycles. Binary bytes are never decoded. Reject any final text containing `workers.dev`, TOS URLs, `/Users/`, `/workspace/`, `file://`, source maps or known test secrets.

- [ ] **Step 5: Add deduplication and immutability tests**

Assert identical bytes share one object, reruns create no duplicate object, conflicting existing object bytes fail, output is deterministic independent of filesystem locale/order, and release manifest/index are written atomically only after all objects succeed.

- [ ] **Step 6: Run tests and commit**

```bash
corepack pnpm exec tsx --test tests/miaobi-github-pages-assets.test.ts
corepack pnpm exec tsc --noEmit --pretty false --skipLibCheck scripts/miaobi/github-pages-assets.ts
```

Commit:

```bash
git add scripts/miaobi/github-pages-assets.ts scripts/miaobi/types.ts tests/miaobi-github-pages-assets.test.ts
git commit -m "feat(miaobi): build GitHub Pages asset releases"
```

---

### Task 2: Isolated `gh-pages` Git publisher and Pages activation

**Files:**
- Create: `scripts/miaobi/git-runner.ts`
- Create: `scripts/miaobi/publish-github-pages.ts`
- Test: `tests/miaobi-github-pages-git.test.ts`
- Modify: `.gitignore`

**Interfaces:**

```ts
export interface GitCommandRunner {
  run(args: string[], options?: { cwd?: string }): Promise<{
    stdout: string;
    stderr: string;
  }>;
}

export interface GitHubPagesPublication {
  manifest: GitHubPagesManifest;
  pagesCommit: string;
  pagesBaseUrl: string;
  releaseManifestUrl: string;
}

export async function publishGitHubPages(input: {
  repositoryDirectory: string;
  clientDirectory: string;
  sourceCommit: string;
  releaseId: string;
  runner: GitCommandRunner;
  maxPushAttempts?: number;
}): Promise<GitHubPagesPublication>;
```

- Validate `fork` using normalized HTTPS/SSH GitHub URL parsing; accepted repository is exactly `aurostars/magic-resume`.
- `gh-pages` branch is created orphan only when absent.
- Commit author may use current Git identity; commit message is `deploy pages: <release-id>`.

- [ ] **Step 1: Write failing Git safety tests**

Use a local bare remote and working repository to assert wrong/missing `fork` rejects before writes, `origin` is never pushed, shell strings are never used, branch creation is orphan, and no force flags appear.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-github-pages-git.test.ts
```

- [ ] **Step 3: Implement argument-array Git runner and worktree lifecycle**

Use `spawn("git", args, { shell: false })`. Fetch only `fork gh-pages`; create a unique temporary worktree under a verified temporary parent; clean it in `finally`. Never log environment variables, credential helpers, remote URLs containing userinfo, or raw command output on failure.

- [ ] **Step 4: Implement first publish, dedup rerun and conflict retry**

For existing branch, start from `fork/gh-pages`. For absent branch, initialize an orphan root containing `.nojekyll`. Materialize Task 1 output, commit only changed paths, and push `HEAD:gh-pages` without force. On non-fast-forward, discard the temporary worktree, refetch, rematerialize and retry up to three times; any other error fails immediately.

- [ ] **Step 5: Implement Pages activation adapter**

Add an injectable `GitHubPagesAdmin` interface:

```ts
export interface GitHubPagesAdmin {
  ensureBranchSource(input: {
    owner: "aurostars";
    repo: "magic-resume";
    branch: "gh-pages";
    path: "/";
  }): Promise<void>;
}
```

The production adapter invokes GitHub CLI with argument arrays and uses `gh api` GET, then POST or PUT only as required. Validate JSON structurally; redact raw bodies and tokens from errors. Tests use a fake admin and never call GitHub.

- [ ] **Step 6: Test cleanup and durability**

Cover worktree-add failure, materialization failure, commit failure, push conflict, exhausted retry, signal interruption and successful cleanup. Existing `gh-pages` content must remain untouched on local failure.

- [ ] **Step 7: Run tests and commit**

```bash
corepack pnpm exec tsx --test tests/miaobi-github-pages-assets.test.ts tests/miaobi-github-pages-git.test.ts
```

Commit:

```bash
git add .gitignore scripts/miaobi/git-runner.ts scripts/miaobi/publish-github-pages.ts tests/miaobi-github-pages-git.test.ts
git commit -m "feat(miaobi): publish assets to GitHub Pages"
```

---

### Task 3: GitHub Pages health checks, runtime injection and CSP

**Files:**
- Create: `scripts/miaobi/github-pages-health.ts`
- Modify: `scripts/miaobi/build-web-faas.ts`
- Modify: `miaobi/runtime-config.ts`
- Modify: `scripts/miaobi/deploy.ts`
- Test: `tests/miaobi-github-pages-health.test.ts`
- Modify: `tests/miaobi-web-faas.test.ts`

**Interfaces:**

```ts
export async function verifyGitHubPagesRelease(input: {
  publication: GitHubPagesPublication;
  fetchImpl?: typeof fetch;
  signalFactory?: (timeoutMs: number) => AbortSignal;
}): Promise<void>;

export function assertGitHubPagesAssetBaseUrl(value: string): string;
```

- Exact allowed origin: `https://aurostars.github.io`.
- Exact base prefix: `/magic-resume/`.
- Manifest URL must be `/magic-resume/releases/<40-char-commit>/manifest.json`.
- Redirects are handled manually; redirects outside the exact origin/prefix are rejected.

- [ ] **Step 1: Write failing Pages URL and health tests**

Cover other hosts, userinfo, ports, query/fragment, encoded path traversal, redirect escape, non-2xx, wrong MIME, oversized bodies, hash mismatch, stale source commit, headers timeout and body timeout. Verify response bodies are cancelled on every rejected path.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-github-pages-health.test.ts
```

- [ ] **Step 3: Implement manifest and key-asset verification**

Fetch the release manifest and all boot-critical JS/CSS/module entries referenced by release index. Enforce one total deadline, 5 MiB manifest limit, explicit content types, exact SHA-256 bytes, manual redirects, response cancellation and safe stable errors. Never log response bodies.

- [ ] **Step 4: Update runtime injection and CSP**

Validate `assetBaseUrl` before HTML injection. CSP must permit script/style/font/image/media resources from `https://aurostars.github.io`, API calls to the current Miaobi API origin, `data:`/`blob:` where already required, and user-configured HTTPS WebDAV through `connect-src https:`. It must not contain TOS, Cloudflare or `workers.dev`.

- [ ] **Step 5: Prove real Web FaaS behavior**

Build and execute the Web FaaS bundle, assert runtime config precedes module scripts, generated module/CSS URLs use Pages object URLs, valid assets are allowed by CSP, and non-Pages asset bases fail before bundle publication.

- [ ] **Step 6: Run tests and commit**

```bash
corepack pnpm exec tsx --test tests/miaobi-github-pages-health.test.ts tests/miaobi-web-faas.test.ts tests/miaobi-production-contract.test.ts
```

Commit:

```bash
git add scripts/miaobi/github-pages-health.ts scripts/miaobi/build-web-faas.ts miaobi/runtime-config.ts scripts/miaobi/deploy.ts tests/miaobi-github-pages-health.test.ts tests/miaobi-web-faas.test.ts
git commit -m "feat(miaobi): verify GitHub Pages releases"
```

---

### Task 4: Deployment integration, documentation and production release

**Files:**
- Modify: `scripts/miaobi/deploy.ts`
- Modify: `scripts/miaobi/build.ts`
- Modify: `scripts/miaobi/types.ts`
- Modify: `miaobi.config.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/miaobi-deployment.md`
- Modify: `tests/miaobi-deploy.test.ts`
- Modify: `tests/miaobi-production-contract.test.ts`
- Test: `tests/miaobi-github-pages-production.test.ts`

**Interfaces:**

Extend deployment state version without weakening v1/v2 compatibility:

```ts
export interface MiaobiDeploymentStateV3 extends MiaobiDeploymentState {
  schemaVersion: 3;
  assetProvider: "github-pages";
  pagesCommit: string;
  pagesBaseUrl: string;
  releaseManifestUrl: string;
}
```

The authoritative deploy order is:

```text
build/test
→ gh-pages push
→ GitHub Pages health
→ new API FaaS
→ new Web FaaS
→ FaaS health
→ fixed page switch
→ immutable deployment state
```

- [ ] **Step 1: Write failing deployment-order and failure-isolation tests**

Use fake Git/Pages/Magic runners. Assert no Magic CLI invocation before Pages health succeeds; every Pages failure leaves page and deployment state unchanged; Pages success followed by FaaS failure only leaves an unused immutable release; reruns reuse an identical Pages release but always create new FaaS.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-deploy.test.ts tests/miaobi-github-pages-production.test.ts
```

- [ ] **Step 3: Replace TOS in the production orchestration**

Wire `publishGitHubPages` and `verifyGitHubPagesRelease` into `deployMiaobi`. Do not invoke `magic-builder file upload`. Preserve generation lock/fencing checks before and after Git push, Pages health, every FaaS call, page call and state commit. If ownership is lost during Git push, retain the immutable Pages release and stop before FaaS.

- [ ] **Step 4: Add schema-v3 state and migration tests**

Validate exact Pages origin/path, `pagesCommit`, manifest source commit, FaaS IDs/URLs and release ID relationships. v1/v2 state remains readable for rollback but cannot be treated as a GitHub Pages release. Existing uncertain page journals keep their fail-closed behavior.

- [ ] **Step 5: Update production contract and documentation**

Document GitHub Pages prerequisites, `gh auth status`, `fork` remote validation, public `gh-pages`, first-publish Pages activation, runtime domains, rollback and storage growth. Remove TOS from the default path while retaining a short historical note about the abandoned blocked route. Production contract recursively scans output and `gh-pages` staging for secrets, local paths, TOS, Cloudflare and `workers.dev`.

- [ ] **Step 6: Run complete local regression**

```bash
corepack pnpm test:miaobi
corepack pnpm test:webdav
corepack pnpm test:ai
corepack pnpm test:resume-import
corepack pnpm build
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm build:miaobi
git diff --check
```

- [ ] **Step 7: Commit implementation**

```bash
git add scripts/miaobi/deploy.ts scripts/miaobi/build.ts scripts/miaobi/types.ts miaobi.config.json README.md README.zh-CN.md docs/miaobi-deployment.md tests/miaobi-deploy.test.ts tests/miaobi-production-contract.test.ts tests/miaobi-github-pages-production.test.ts
git commit -m "feat(miaobi): deploy assets through GitHub Pages"
```

- [ ] **Step 8: Perform production publication after review**

Run on the authenticated local machine:

```bash
gh auth status
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm build:miaobi
MIAOBI_GIT_COMMIT=$(git rev-parse HEAD) corepack pnpm deploy:miaobi
```

Verify:

- `fork/gh-pages` contains the source commit release manifest;
- Pages manifest and boot assets return 2xx with matching hashes/MIME;
- API/Web FaaS health markers match this build;
- `https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR` reaches the native Web FaaS;
- generated/runtime text contains no TOS, Cloudflare or `workers.dev` dependency;
- if no interactive browser, record UI/AI/WebDAV/export checks as not executed rather than claiming success.

- [ ] **Step 9: Push source branch only after production verification**

```bash
git push fork HEAD:main
```

Never force push. Confirm `git ls-remote fork refs/heads/main` equals local `HEAD`.

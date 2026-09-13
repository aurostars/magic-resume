# 妙笔原生部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Magic Resume 的页面、静态资源和服务端 API 全部部署到妙笔，妙笔入口直接运行完整应用且不依赖 Cloudflare。

**Architecture:** 保留现有 TanStack Start/Cloudflare 构建作为回滚路径，新增妙笔专用 SPA 构建、运行时 URL 配置、TOS 资源发布器，以及 Web/API 两个妙笔 FaaS bundle。SPA 使用 hash history，解决妙笔 FaaS 只有固定调用路径的问题；发布脚本先上传 TOS 资源和 API FaaS，再生成 Web FaaS，最后原子切换既有妙笔页面 `vv6BtLE8MTR`。

**Tech Stack:** TypeScript、React 18、TanStack Router/Start 1.160、Vite 6、esbuild、Node.js CommonJS FaaS、妙笔 `magic-builder` CLI、TOS、Node test runner + tsx。

## Global Constraints

- 妙笔地址必须直接运行完整应用，运行时不得请求 `workers.dev` 或依赖 Cloudflare Worker。
- 现有 `corepack pnpm build` 与 Cloudflare 配置必须保持可用，作为回滚路径。
- 简历数据和 WebDAV 凭据只保存在浏览器与用户配置的 WebDAV；妙笔 FaaS 不持久化或记录它们。
- WebDAV 继续由浏览器直连，不新增妙笔 WebDAV 代理，不改变 manifest v2、immutable objects、CAS 或冲突语义。
- API 错误不得泄露用户密钥、WebDAV URL query、上游响应正文、图片正文或简历正文。
- 妙笔 HTML Box 只作为发现入口，不在 sandbox 中运行应用；真实应用入口必须是妙笔 Web FaaS 顶层地址。
- 妙笔 SPA 使用 hash history，所有前端页面位于 `#/...`，避免依赖 FaaS 子路径回退能力。
- 静态资源使用带发布 ID 的不可变 TOS key；新发布不得覆盖或删除上一版资源。
- 发布顺序固定为：构建与测试 → TOS → API FaaS → Web FaaS → 线上检查 → 更新页面 `vv6BtLE8MTR`。
- 任一步失败不得切换妙笔页面；Cloudflare Worker 本次不删除、不下线。
- 不引入 D1、R2、KV、数据库或用户账户存储。
- 新增依赖只能是构建期 devDependency；不得新增运行时依赖。

---

### Task 1: 浏览器运行时 URL 与 hash history

**Files:**
- Create: `src/config/runtime-endpoints.ts`
- Modify: `src/router.tsx`
- Modify: `src/store/useGrammarStore.ts`
- Modify: `src/components/shared/ai/AIPolishDialog.tsx`
- Modify: `src/lib/pdf-import-client.ts`
- Modify: `src/components/shared/PhotoConfigDrawer.tsx`
- Test: `tests/runtime-endpoints.test.ts`
- Test: `tests/miaobi-router-contract.test.ts`

**Interfaces:**
- Consumes: `window.location` and optional `window.__MAGIC_RESUME_RUNTIME__` injected by Web FaaS.
- Produces:

```ts
export interface MagicResumeRuntimeConfig {
  platform: "default" | "miaobi";
  apiFunctionUrl: string | null;
  assetBaseUrl: string | null;
}

export function getRuntimeConfig(): MagicResumeRuntimeConfig;
export function getApiRequestUrl(path: `/api/${string}`): string;
export function getPublicAssetUrl(path: `/${string}`): string;
export function createAppHistory(): RouterHistory;
```

- Default runtime preserves existing relative `/api/*` and root-relative asset behavior.
- Miaobi API URLs use the fixed function endpoint with the logical route encoded once:

```text
https://magic.solutionsuite.cn/api/faas/<api-id>?__path=%2Fapi%2Fgrammar
```

- [ ] **Step 1: Write failing runtime endpoint tests**

Add tests proving:

```ts
assert.equal(getApiRequestUrl("/api/grammar"), "/api/grammar");

installRuntime({
  platform: "miaobi",
  apiFunctionUrl: "https://magic.solutionsuite.cn/api/faas/api-id",
  assetBaseUrl: "https://tos.example/releases/r1/"
});
assert.equal(
  getApiRequestUrl("/api/grammar"),
  "https://magic.solutionsuite.cn/api/faas/api-id?__path=%2Fapi%2Fgrammar"
);
assert.equal(
  getPublicAssetUrl("/fonts/a.ttf"),
  "https://tos.example/releases/r1/fonts/a.ttf"
);
```

Also prove existing query parameters on `apiFunctionUrl` are preserved and that an invalid non-HTTPS runtime URL throws without including the URL in the error message.

- [ ] **Step 2: Run endpoint tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/runtime-endpoints.test.ts
```

Expected: FAIL because `runtime-endpoints.ts` does not exist.

- [ ] **Step 3: Implement runtime endpoint helpers**

Use a typed global declaration:

```ts
declare global {
  interface Window {
    __MAGIC_RESUME_RUNTIME__?: MagicResumeRuntimeConfig;
  }
}
```

Validate injected URLs with `new URL()`, require `https:`, strip fragments, and construct `__path` via `URL.searchParams.set`. Never include rejected URL values in thrown messages.

- [ ] **Step 4: Add failing router and caller contract tests**

Assert that:

- default `getRouter()` uses browser history;
- `getRouter({ platform: "miaobi" })` uses hash history;
- grammar, polish, resume import and image proxy callers resolve URLs through `getApiRequestUrl`;
- font/template/public image helpers resolve through `getPublicAssetUrl` where applicable.

The test must import real caller modules and inspect requests produced by fake `fetch`; do not assert source text.

- [ ] **Step 5: Run caller tests and verify RED**

Run:

```bash
corepack pnpm exec tsx --test tests/runtime-endpoints.test.ts tests/miaobi-router-contract.test.ts
```

Expected: FAIL because callers still use literal relative paths and the router has no platform option.

- [ ] **Step 6: Implement hash history and replace literal runtime URLs**

Change the router signature to:

```ts
export function getRouter(options: { platform?: "default" | "miaobi" } = {}) {
  return createRouter({
    routeTree,
    history: options.platform === "miaobi" ? createHashHistory() : undefined,
    scrollRestoration: true
  });
}
```

Keep all Cloudflare/default behavior unchanged when no option is passed.

- [ ] **Step 7: Run focused and adjacent tests**

Run:

```bash
corepack pnpm exec tsx --test tests/runtime-endpoints.test.ts tests/miaobi-router-contract.test.ts tests/resume-import.test.ts
corepack pnpm test:ai
```

Expected: PASS with zero failures.

- [ ] **Step 8: Commit**

```bash
git add src/config/runtime-endpoints.ts src/router.tsx src/store/useGrammarStore.ts src/components/shared/ai/AIPolishDialog.tsx src/lib/pdf-import-client.ts src/components/shared/PhotoConfigDrawer.tsx tests/runtime-endpoints.test.ts tests/miaobi-router-contract.test.ts
git commit -m "feat(miaobi): add browser runtime endpoints"
```

---

### Task 2: 平台无关 API Router

**Files:**
- Create: `src/lib/server/image-proxy.ts`
- Create: `src/lib/server/api-router.ts`
- Modify: `src/routes/api/proxy/image.ts`
- Test: `tests/api-router.test.ts`
- Test: `tests/image-proxy-security.test.ts`

**Interfaces:**
- Consumes existing `handleTextRequest(request, mode)` and `handleResumeImport(request)`.
- Produces:

```ts
export type ApiRoutePath =
  | "/api/grammar"
  | "/api/polish"
  | "/api/resume-import"
  | "/api/proxy/image";

export async function handleImageProxy(request: Request): Promise<Response>;
export async function handleApiRequest(
  request: Request,
  logicalPath?: string
): Promise<Response>;
```

- The router accepts the normal pathname for Cloudflare and explicit `logicalPath` for Miaobi.

- [ ] **Step 1: Write failing API router tests**

Cover this exact matrix:

| Path | Method | Expected |
| --- | --- | --- |
| `/api/grammar` | POST | delegates to grammar handler |
| `/api/polish` | POST | delegates to polish handler |
| `/api/resume-import` | POST | delegates to import handler |
| `/api/proxy/image` | GET | delegates to image handler |
| known path | unsupported method | 405 + `Allow` |
| unknown path | any | 404 safe JSON |

Inject handler dependencies in tests so routing is tested without external AI calls:

```ts
export interface ApiRouterDependencies {
  grammar: (request: Request) => Promise<Response>;
  polish: (request: Request) => Promise<Response>;
  resumeImport: (request: Request) => Promise<Response>;
  imageProxy: (request: Request) => Promise<Response>;
}
```

- [ ] **Step 2: Run router tests and verify RED**

```bash
corepack pnpm exec tsx --test tests/api-router.test.ts
```

Expected: FAIL because `handleApiRequest` does not exist.

- [ ] **Step 3: Extract image proxy behavior test-first**

Move the current inline implementation from `src/routes/api/proxy/image.ts` into `handleImageProxy`. Add tests proving it rejects:

- missing or malformed URL;
- non-HTTP(S) schemes;
- loopback, link-local, RFC1918 IPv4, IPv6 loopback and IPv4-mapped private IPv6;
- redirects from a public host to a private host;
- non-image content types;
- responses larger than the configured byte limit;
- timeout/abort without leaking target URL or response body.

The TanStack route becomes only:

```ts
GET: ({ request }) => handleImageProxy(request)
```

- [ ] **Step 4: Implement the router and safe method handling**

Use a table keyed by logical path and method. Return only stable `{ error, code }` JSON for 404/405/500 and never serialize caught error objects.

- [ ] **Step 5: Run focused and existing server tests**

```bash
corepack pnpm exec tsx --test tests/api-router.test.ts tests/image-proxy-security.test.ts
corepack pnpm test:ai
corepack pnpm test:resume-import
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/image-proxy.ts src/lib/server/api-router.ts src/routes/api/proxy/image.ts tests/api-router.test.ts tests/image-proxy-security.test.ts
git commit -m "refactor(server): share API handlers across runtimes"
```

---

### Task 3: 妙笔 API FaaS adapter 与 bundle

**Files:**
- Create: `miaobi/api-entry.ts`
- Create: `scripts/miaobi/build-faas.ts`
- Create: `scripts/miaobi/faas-adapter.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Test: `tests/miaobi-api-faas.test.ts`
- Test: `tests/miaobi-faas-build.test.ts`

**Interfaces:**
- Consumes `handleApiRequest` from Task 2.
- Produces:

```ts
export interface MiaobiFaasRequest extends Request {}
export async function handleMiaobiApi(request: Request): Promise<Response>;

export interface FaaSBuildResult {
  apiBundlePath: string;
  webBundlePath: string | null;
}

export async function buildApiFaas(outputDirectory: string): Promise<string>;
```

- Generated file: `dist/miaobi/api-faas.cjs`.
- Final CommonJS contract: `module.exports = async function(request) { return Response }`.

- [ ] **Step 1: Add `esbuild` as a devDependency**

```bash
corepack pnpm add -D esbuild
```

Do not add it to runtime `dependencies`.

- [ ] **Step 2: Write failing adapter tests**

Verify:

```ts
const request = new Request(
  "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fgrammar",
  { method: "POST", body: validBody, headers: { "content-type": "application/json" } }
);
const response = await handleMiaobiApi(request);
```

The adapter must remove only `__path` from the logical URL passed to the router, preserve all other query parameters, and reject duplicate/missing/invalid logical paths with safe 400 JSON.

- [ ] **Step 3: Run adapter test and verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-api-faas.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement adapter and FaaS bundle builder**

Bundle with:

```ts
await build({
  entryPoints: ["miaobi/api-entry.ts"],
  outfile: join(outputDirectory, "api-faas.cjs"),
  bundle: true,
  platform: "node",
  format: "iife",
  target: "node20",
  globalName: "MagicResumeApi",
  footer: { js: "module.exports = MagicResumeApi.handleMiaobiApi" },
  define: { "process.env.NODE_ENV": '"production"' }
});
```

Fail the build if any non-`node:` bare import remains. Do not externalize application dependencies.

- [ ] **Step 5: Write and run bundle contract tests**

The test must build the bundle, load it with `createRequire`, assert `typeof exported === "function"`, call 404/405 cases, and scan bundle text for:

- `workers.dev` — absent;
- `wrangler` — absent;
- source maps containing user paths — absent;
- raw test API keys — absent.

Run:

```bash
corepack pnpm exec tsx --test tests/miaobi-api-faas.test.ts tests/miaobi-faas-build.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add miaobi/api-entry.ts scripts/miaobi/build-faas.ts scripts/miaobi/faas-adapter.ts package.json pnpm-lock.yaml tests/miaobi-api-faas.test.ts tests/miaobi-faas-build.test.ts
git commit -m "feat(miaobi): build API FaaS bundle"
```

---

### Task 4: 妙笔 SPA shell 构建

**Files:**
- Create: `vite.miaobi.config.ts`
- Create: `miaobi/runtime-config.ts`
- Create: `scripts/miaobi/build-spa.ts`
- Modify: `src/routes/__root.tsx`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Test: `tests/miaobi-spa-build.test.ts`

**Interfaces:**
- Consumes runtime endpoint and hash-history support from Task 1.
- Produces:

```ts
export interface MiaobiRuntimeInjection {
  platform: "miaobi";
  apiFunctionUrl: string;
  assetBaseUrl: string;
}

export async function buildMiaobiSpa(input: {
  outputDirectory: string;
  assetBasePlaceholder: string;
}): Promise<{ shellPath: string; assetDirectory: string }>;

export function injectMiaobiRuntime(
  html: string,
  config: MiaobiRuntimeInjection
): string;
```

- Output directory: `dist/miaobi/client`.
- Build placeholder: `https://miaobi.invalid/__ASSET_BASE__/`.

- [ ] **Step 1: Write failing root-shell compatibility test**

Extract the body-level providers/outlet from `RootComponent` into a reusable `AppBody` component while retaining the existing TanStack Start document shell. Test that the existing root still renders `<html>`/`<body>` and the SPA shell uses the same providers without nesting an `<html>` element inside a `<div>`.

- [ ] **Step 2: Run root-shell test and verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-spa-build.test.ts
```

Expected: FAIL because no SPA shell builder exists.

- [ ] **Step 3: Implement dedicated TanStack Start SPA config**

Use the existing Start plugin with a separate build directory and SPA shell:

```ts
tanstackStart({
  srcDirectory: "src",
  spa: { enabled: true, maskPath: "/app/dashboard" },
  client: { base: "https://miaobi.invalid/__ASSET_BASE__/" },
  router: { routesDirectory: "routes" }
})
```

The build must not overwrite `dist/client`, `dist/server`, `routeTree.gen.ts`, or the normal `vite.config.ts` output. If the plugin cannot isolate the generated directory, run it in a temporary copied config tree under `.tmp/miaobi-build` and delete only that temporary tree after success.

- [ ] **Step 4: Inject runtime config before application scripts**

Generate exactly one escaped script assignment before module scripts:

```html
<script>window.__MAGIC_RESUME_RUNTIME__={"platform":"miaobi","apiFunctionUrl":"...","assetBaseUrl":"..."}</script>
```

Serialize with `JSON.stringify` and replace `<`, `>`, `&`, U+2028 and U+2029 so injected values cannot terminate the script.

- [ ] **Step 5: Add SPA artifact tests**

Build once in a temporary directory and assert:

- shell HTML exists;
- module entry and CSS use the asset placeholder;
- no HTML Box iframe is present;
- no `workers.dev` or Cloudflare runtime import appears;
- client JS has no `node:` import;
- hash history initializes under `platform: "miaobi"`;
- the normal build output remains byte-for-byte untouched by the focused test.

- [ ] **Step 6: Run focused build test**

```bash
corepack pnpm exec tsx --test tests/miaobi-spa-build.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vite.miaobi.config.ts miaobi/runtime-config.ts scripts/miaobi/build-spa.ts src/routes/__root.tsx tsconfig.json package.json tests/miaobi-spa-build.test.ts
git commit -m "feat(miaobi): build standalone SPA shell"
```

---

### Task 5: TOS 不可变资源发布器

**Files:**
- Create: `scripts/miaobi/magic-builder.ts`
- Create: `scripts/miaobi/publish-assets.ts`
- Create: `scripts/miaobi/content-types.ts`
- Create: `scripts/miaobi/types.ts`
- Modify: `.gitignore`
- Test: `tests/miaobi-assets.test.ts`
- Test: `tests/miaobi-cli.test.ts`

**Interfaces:**

```ts
export interface MagicBuilderRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface MiaobiAssetRecord {
  relativePath: string;
  contentHash: string;
  contentType: string;
  key: string;
  url: string;
}

export interface MiaobiAssetManifest {
  schemaVersion: 1;
  releaseId: string;
  createdAt: string;
  baseUrl: string;
  files: Record<string, MiaobiAssetRecord>;
}

export async function publishAssets(input: {
  directory: string;
  releaseId: string;
  runner: MagicBuilderRunner;
}): Promise<MiaobiAssetManifest>;
```

- Release ID format: first 12 hexadecimal characters of the Git commit plus `-` plus UTC `yyyyMMddHHmmss`.
- TOS key format: `magic-resume/releases/<release-id>/<relative-path>`.
- Local state path: `.miaobi/state.json`; it is ignored by Git and contains no credentials.

- [ ] **Step 1: Write failing CLI output parser tests**

Test exact cases:

- pure JSON output;
- JSON followed by human-readable status text;
- non-zero exit;
- missing `url`/`id` fields;
- output containing token-like fields must be discarded from returned errors.

- [ ] **Step 2: Run parser tests and verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-cli.test.ts
```

Expected: FAIL because the runner/parser does not exist.

- [ ] **Step 3: Implement safe `magic-builder` runner**

Use `spawn` with an argument array, never a shell string. Do not log environment variables or raw CLI responses. Convert failures to stable codes such as `MIAOBI_CLI_FAILED`, `MIAOBI_AUTH_REQUIRED`, and `MIAOBI_INVALID_RESPONSE`.

- [ ] **Step 4: Write failing asset publication tests**

Use a fake runner to prove:

- traversal paths and symlinks outside the build root are rejected;
- dotfiles, source maps and server bundles are excluded;
- MIME types are explicit for JS, CSS, JSON, SVG, PNG, JPG, TTF, OTF, WOFF and WOFF2;
- each key contains the release ID and normalized POSIX path;
- duplicate content is uploaded once and mapped deterministically;
- failed upload prevents manifest creation;
- generated manifest contains no local absolute paths.

- [ ] **Step 5: Run asset tests and verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-assets.test.ts
```

Expected: FAIL because `publishAssets` does not exist.

- [ ] **Step 6: Implement immutable upload and placeholder rewriting**

Before uploading final text assets:

1. upload a small release marker using key `magic-resume/releases/<release-id>/release.json`;
2. derive and validate the HTTPS release base URL from its returned URL;
3. replace `https://miaobi.invalid/__ASSET_BASE__/` in HTML, JS and CSS with that base URL;
4. recompute content hashes after replacement;
5. upload every final asset with explicit `--key` and `--content-type`;
6. write `dist/miaobi/asset-manifest.json` only after all uploads succeed.

Binary files are never decoded or rewritten.

- [ ] **Step 7: Run focused tests**

```bash
corepack pnpm exec tsx --test tests/miaobi-cli.test.ts tests/miaobi-assets.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/miaobi/magic-builder.ts scripts/miaobi/publish-assets.ts scripts/miaobi/content-types.ts scripts/miaobi/types.ts .gitignore tests/miaobi-assets.test.ts tests/miaobi-cli.test.ts
git commit -m "feat(miaobi): publish immutable TOS assets"
```

---

### Task 6: Web FaaS 与原子部署编排

**Files:**
- Create: `miaobi/web-entry.ts`
- Create: `scripts/miaobi/build-web-faas.ts`
- Create: `scripts/miaobi/build.ts`
- Create: `scripts/miaobi/deploy.ts`
- Create: `miaobi.config.json`
- Modify: `package.json`
- Test: `tests/miaobi-web-faas.test.ts`
- Test: `tests/miaobi-deploy.test.ts`

**Interfaces:**

```ts
export interface MiaobiDeployConfig {
  pageId: "vv6BtLE8MTR";
  title: "魔方简历";
  assetKeyPrefix: "magic-resume/releases";
}

export interface MiaobiDeploymentState {
  schemaVersion: 1;
  releaseId: string;
  apiFaasId: string;
  apiFaasUrl: string;
  webFaasId: string;
  webFaasUrl: string;
  pageId: string;
  deployedAt: string;
}

export function createWebFaasHandler(html: string): (request: Request) => Promise<Response>;
export async function buildMiaobiArtifacts(options: {
  outputDirectory: string;
  assetBasePlaceholder: string;
}): Promise<FaaSBuildResult & { shellPath: string; assetDirectory: string }>;
export async function deployMiaobi(options: {
  runner: MagicBuilderRunner;
  gitCommit: string;
  now: Date;
}): Promise<MiaobiDeploymentState>;
```

- Web FaaS bundle: `dist/miaobi/web-faas.cjs`.
- Page artifact: `dist/miaobi/page.html` containing only a direct top-level redirect and accessible fallback link to `webFaasUrl`; it must contain no Cloudflare URL.

- [ ] **Step 1: Write failing Web FaaS tests**

Prove:

- GET and HEAD return HTML/headers correctly;
- POST/PUT/DELETE return 405 with `Allow: GET, HEAD`;
- HTML has `Cache-Control: no-store`, `Content-Type: text/html; charset=utf-8`, `X-Content-Type-Options: nosniff`, and a restrictive CSP allowing only the TOS release URL and API FaaS URL;
- response contains runtime config before module scripts;
- response body contains neither `workers.dev` nor secrets.

- [ ] **Step 2: Run Web FaaS tests and verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-web-faas.test.ts
```

Expected: FAIL because Web FaaS does not exist.

- [ ] **Step 3: Implement and bundle Web FaaS**

Use an IIFE/CommonJS footer equivalent to Task 3. Embed the finalized HTML at build time with safe JavaScript string serialization; no filesystem read occurs at request time.

- [ ] **Step 4: Write failing deployment state-machine tests**

With a fake CLI runner, assert exact order:

```text
file upload ...
faas publish api-faas.cjs --name magic-resume-api
faas publish web-faas.cjs --name magic-resume-web
HTTP health checks
page publish page.html --title 魔方简历 --id vv6BtLE8MTR
```

Also prove:

- any asset/API/Web/health failure prevents page publication;
- page update failure keeps the prior state file intact;
- successful deployment writes state atomically through a temporary file + rename;
- rerun with existing IDs uses `--id` to update functions rather than creating duplicates;
- logged errors contain safe codes, not CLI response bodies or credentials.

- [ ] **Step 5: Run deploy tests and verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-deploy.test.ts
```

Expected: FAIL because `deployMiaobi` does not exist.

- [ ] **Step 6: Implement deployment orchestration**

Add scripts:

```json
{
  "build:miaobi": "tsx scripts/miaobi/build.ts",
  "deploy:miaobi": "tsx scripts/miaobi/deploy.ts",
  "test:miaobi": "tsx --test tests/miaobi-*.test.ts"
}
```

Health checks must call the new URLs and verify status/body markers without printing full bodies. The page must switch only after both FaaS checks pass.

- [ ] **Step 7: Run focused deploy tests**

```bash
corepack pnpm test:miaobi
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add miaobi/web-entry.ts miaobi.config.json scripts/miaobi/build-web-faas.ts scripts/miaobi/build.ts scripts/miaobi/deploy.ts package.json tests/miaobi-web-faas.test.ts tests/miaobi-deploy.test.ts
git commit -m "feat(miaobi): orchestrate native deployment"
```

---

### Task 7: 文档、完整回归与妙笔生产发布

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Create: `docs/miaobi-deployment.md`
- Test: `tests/miaobi-production-contract.test.ts`

**Interfaces:**
- Consumes Tasks 1–6.
- Produces a verified native deployment and updated `.miaobi/state.json`.

- [ ] **Step 1: Add production artifact contract test**

The test executes `build:miaobi` and asserts:

- `dist/miaobi/api-faas.cjs`, `web-faas.cjs`, `page.html`, client assets and manifest exist;
- all generated URLs use `https://magic.solutionsuite.cn/` or returned HTTPS TOS hosts;
- no generated text file contains `workers.dev`;
- no generated text file contains known test passwords/API keys;
- default Cloudflare build still produces `dist/client` and `dist/server/server.js`.

- [ ] **Step 2: Run contract test and verify RED**

```bash
corepack pnpm exec tsx --test tests/miaobi-production-contract.test.ts
```

Expected: FAIL until all final artifact wiring is present.

- [ ] **Step 3: Write bilingual deployment documentation**

Document:

- prerequisites: authenticated `magic-builder` 1.3.0 or newer;
- `corepack pnpm deploy:miaobi` command;
- generated state and artifact paths;
- deployment order and rollback behavior;
- browser-local resume/WebDAV credential boundary;
- Cloudflare remains a rollback deployment and is not used by Miaobi runtime;
- limitations when no disposable WebDAV directory or AI key is available.

Do not document internal authentication tokens or raw API calls.

- [ ] **Step 4: Run complete local regression**

```bash
corepack pnpm test:miaobi
corepack pnpm test:webdav
corepack pnpm test:ai
corepack pnpm test:resume-import
corepack pnpm build
corepack pnpm build:miaobi
git diff --check
```

Expected: all commands exit 0; build warnings may be recorded only if they pre-existed and are non-fatal.

- [ ] **Step 5: Commit release-ready implementation**

```bash
git add README.md README.zh-CN.md docs/miaobi-deployment.md tests/miaobi-production-contract.test.ts
git commit -m "docs(miaobi): document native deployment"
```

- [ ] **Step 6: Publish to Miaobi**

Run on the authenticated local device:

```bash
corepack pnpm deploy:miaobi
```

Expected output includes safe identifiers and URLs only:

```text
releaseId=<commit12>-<utc timestamp>
apiFaasId=<record id>
webFaasId=<record id>
pageId=vv6BtLE8MTR
```

Do not copy credentials or raw CLI output into reports.

- [ ] **Step 7: Verify the deployed application**

Verify:

1. `https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR` reaches the Web FaaS application without a `workers.dev` request.
2. The application renders “我的简历” and the settings page.
3. Creating a disposable resume, refreshing, and reopening preserves it in localStorage.
4. JSON export/import round-trips the disposable resume.
5. Word and local PDF exports produce non-empty files.
6. Grammar/polish test requests reach the API FaaS; if no disposable AI key exists, validate only safe connection failure behavior and record the limitation.
7. WebDAV is tested only when a disposable authorized directory exists; otherwise do not issue production writes and record the limitation.
8. Browser console has no new CSP, CORS, localStorage or runtime errors.

- [ ] **Step 8: Push the verified branch**

```bash
git push fork HEAD:main
```

No force push. Confirm remote `main` equals local HEAD after push.

- [ ] **Step 9: Final record**

Record in the task report:

- local commit and fork main SHA;
- release ID;
- page, Web FaaS and API FaaS URLs;
- TOS asset count;
- test/build totals;
- interactive checks completed;
- checks skipped for lack of disposable credentials/data.

Never record credentials, query-bearing WebDAV URLs, AI payloads or resume contents.

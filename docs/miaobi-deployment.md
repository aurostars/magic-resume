# 妙笔原生部署 / Miaobi Native Deployment

本文是 Magic Resume 妙笔原生部署的运维契约。中文为主；文末提供 English summary。不得在文档、命令历史或日志中记录令牌和 CLI 原始认证响应。

## 1. 生产拓扑与固定契约

默认生产链路由以下部分组成：

- `https://aurostars.github.io/magic-resume/` 上公开、不可变、内容寻址的浏览器资源；
- 妙笔 API FaaS；
- 妙笔 Web FaaS，负责提供注入运行时配置后的 HTML；
- 固定页面 `https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR`，只在所有健康检查成功后切换。

浏览器网络边界按用途分离：静态应用资源只从当前 GitHub Pages graph origin 加载；应用 API 请求固定发送到 `https://magic.solutionsuite.cn/api/faas/<id>` 的当前妙笔 API origin；`connect-src https:` 仅保留非坚果云 WebDAV 的既有浏览器直连能力。坚果云 WebDAV 不直连浏览器，也不单独加入 CSP，而是使用 `POST /api/webdav/jianguoyun`，由服务端固定访问 `https://dav.jianguoyun.com/dav/`。运行时不得依赖 TOS、Cloudflare 或 `workers.dev`。早期 TOS 方案因生产发布受阻而放弃，仅作为历史背景，不是回滚或默认路径。

## 2. 前置条件

1. Node.js 20+，通过 Corepack 使用仓库锁定的 pnpm。
2. 工作区干净，目标 commit 已评审并完成本地回归。
3. 安装并登录 `gh`；`gh auth status` 必须成功，且账号对 `aurostars/magic-resume` 有 `gh-pages` 写权限和 Pages 管理权限。
4. 安装并登录 `magic-builder` 1.3.0+；用 `magic-builder --version` 检查版本。
5. `fork` remote 必须只有一个 push URL，并精确指向 GitHub 上的 `aurostars/magic-resume`。部署器会拒绝其他 owner、repo、主机、凭据 URL 或多个 push destination。
6. GitHub Pages 必须为公开站点，source 为 `gh-pages` 分支根目录 `/`。首次发布时部署器在 push 后通过 GitHub API 启用或修正该 source；执行者必须具备相应权限。
7. 文件系统必须支持目录 `fsync`、硬链接和安全权限；预检失败会在任何远端副作用前返回 `MIAOBI_DURABILITY_UNSUPPORTED`。
8. 同一工作区同一时刻只运行一个部署，不要手工删除活跃锁。

检查命令：

```bash
gh auth status
git remote get-url --push --all fork
magic-builder --version
```

## 3. 构建与本地契约检查

```bash
corepack pnpm exec tsx --test \
  tests/miaobi-production-contract.test.ts \
  tests/miaobi-github-pages-production.test.ts \
  tests/miaobi-faas-build.test.ts
corepack pnpm test:webdav
corepack pnpm test:miaobi
MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)" corepack pnpm build:miaobi
```

构建后确认 `dist/miaobi/api-faas.meta.json` 的 `gitCommit` 与当前完整 40 位 HEAD 一致。生产契约必须分别审计客户端与 API bundle：客户端 origin allowlist 不得包含 `dav.jianguoyun.com`，API bundle 仅额外允许固定坚果云 origin。行为测试还会把真实 `WebDavClient` 构建为浏览器产物，在妙笔 runtime 下执行并记录 `fetch`，证明坚果云配置只请求当前妙笔 API 的 `?__path=/api/webdav/jianguoyun`，同时保留 API bundle 固定上游与 runtime `require` 不可用时的执行断言。

`dist/miaobi/` 包含：

- `api-faas.cjs`、`api-faas.meta.json`：API FaaS 与绑定 source commit/nonce/hash 的元数据；
- `web-faas.cjs`：部署前占位构建，部署时按最终 API URL 与 Pages base URL 重建；
- `client/`：完整浏览器客户端；
- `page.html`：固定页面发布工件，部署时改写为最终 Web FaaS 跳转；
- `manifest.json`：schema v2 本地构建清单，声明 `assetProvider: github-pages` 和 Pages base URL。

生产契约会递归检查构建输出与模拟 `gh-pages` staging：禁止已知 secret、本机绝对路径、TOS、Cloudflare Worker 和 `workers.dev` 依赖，并按产物边界校验 URL allowlist。客户端与 Pages 产物不允许坚果云 origin；只有 `api-faas.cjs` 允许固定的 `https://dav.jianguoyun.com` 上游。`dist/` 可重建，不是部署事实来源。

凭据无关 smoke 必须在发布前执行：用构建后的 API handler 与注入的假上游 `fetch` 请求 `/api/webdav/jianguoyun`；确认不支持的方法与畸形路径返回文档化、脱敏的 `4xx`，任何响应都不含 `Authorization` 值或提交的密码，且 bundle 在运行时 `require` 抛错时仍可加载。不得发起真实认证的坚果云请求，不得把凭据放入命令、fixture 或日志。

## 4. 生产部署

生产发布仅由 controller 在代码审查通过后执行：

```bash
export MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)"
corepack pnpm build:miaobi
corepack pnpm deploy:miaobi
```

PowerShell：

```powershell
$env:MIAOBI_GIT_COMMIT = (git rev-parse HEAD)
corepack pnpm build:miaobi
corepack pnpm deploy:miaobi
```

权威顺序不可调整：

1. 本地 build/test，并取得带心跳的独占 generation lock；
2. 将同一 source commit/release 的内容寻址资源 push 到 `fork/gh-pages`；
3. 校验远端 release manifest、`index.html` 和启动 CSS/JS 的状态码、MIME、大小与 SHA-256；
4. 新建 API FaaS；
5. 注入 API URL 与 Pages base URL，重建并新建 Web FaaS；
6. 校验 API build marker、Web runtime 和两端健康状态；
7. 持久化 pending/page-inflight 后切换固定页面，再持久化 page-confirmed；
8. 提交不可变 schema-v3 generation state，最后清理本 generation pending。

`magic-builder file upload` 不属于该流程。Pages health 成功前不得调用任何 Magic CLI。Pages 发布失败或健康检查失败时，固定页面和 deployment state 均保持不变；Pages 成功后的 FaaS/健康/页面前失败只会留下未引用的不可变 Pages release。相同 source commit 与 release ID 的重跑会复用相同 Pages release，但始终新建 API/Web FaaS。

## 5. Generation fencing 与状态 schema

每次尝试取得 `(generation, ownerToken)`。Git push、Pages health、每次 FaaS 调用、page 调用和 state commit 的前后都验证 token、inode 与 lease。若 Pages push 完成时 ownership 已丢失，已发布 release 保留，但旧 owner 必须在 FaaS 前停止并返回 `MIAOBI_OWNERSHIP_LOST`。

```text
.miaobi/
└── states/<generation>-<ownerToken>.json
.miaobi-recovery/
├── generations/
├── pending/
├── page-inflight/
├── page-confirmed/
└── deployment.lock
```

最高 generation 的有效 state 是权威状态。新记录使用 schema v3，包含：

- `assetProvider: "github-pages"`；
- 精确的 `pagesCommit`；
- `pagesBaseUrl: "https://aurostars.github.io/magic-resume/"`；
- 与 API build marker/source commit 一致的 `releaseManifestUrl`；
- 新 API/Web FaaS ID、精确 URL、release ID、固定 page ID 和部署时间。

v1/v2 state 仅可严格读取以支持回滚迁移；它们没有 Pages provenance，绝不能伪装或解释为 GitHub Pages release。旧 pending/page journal 的结果若不确定，继续 fail closed。

## 6. 页面结果不确定

一旦 `page-inflight` 已落盘，远端页面调用可能已生效。若无法证明结果，后续运行返回 `MIAOBI_PAGE_RESULT_UNCERTAIN`。此时必须停止自动发布和自动回滚，保存 `.miaobi/` 与 `.miaobi-recovery/`，人工核验页面、Web/API FaaS、Pages release 后再作独立评审决定。禁止自动覆盖、重试页面、删除屏障或伪造 confirmation。

## 7. 回滚与存储增长

回滚应选择已审核的历史 source commit，在干净工作区重新执行完整 build/test/deploy，创建新的 FaaS 与 generation；不要修改历史 state 或原地覆盖 FaaS。v1/v2 记录可辅助选择历史 FaaS，但不能提供 Pages release 身份。

`gh-pages` 的 `objects/<sha256>/...` 与 `releases/<sourceCommit>/manifest.json` 是不可变审计材料，会随唯一资源增长。定期监控仓库大小；删除对象或 release 必须经过独立保留策略评审，先证明没有任何保留 manifest 引用，再单独提交，绝不能在正常部署中自动垃圾回收。

Cloudflare 只保留为控制方人工灾备入口，不得由妙笔部署脚本自动切换。恢复妙笔前仍需解决所有不确定页面屏障。

## 8. 发布后验证与限制

controller 发布后至少核对：

- `fork/gh-pages` manifest 的 source commit 与目标 HEAD 相同；
- Pages manifest、index 和启动资源为 2xx，hash/MIME 匹配；
- API/Web FaaS marker 与 runtime 指向本次 build 和 Pages base URL；
- API health 继续对不存在路径返回 `404 notFound`，并携带当前 `X-Magic-Resume-Build` 与 `X-Magic-Resume-Faas: magic-resume-api`；同时以不含凭据的畸形请求检查 `/api/webdav/jianguoyun` 返回脱敏 `4xx`；
- Web FaaS CSP 的静态资源 directive 只允许当前 Pages graph origin，应用 API 固定为当前妙笔 API origin；`connect-src https:` 仅保留非坚果云 WebDAV 的既有直连能力，不单独加入坚果云 host；
- 固定页面到达新的原生 Web FaaS；
- 生成物与运行时文本不依赖 TOS、Cloudflare 或 `workers.dev`。

浏览器 localStorage 中的简历、设置、AI 配置和 WebDAV 凭据不会迁入 FaaS 或 Pages。没有交互浏览器、一次性 AI key 或可丢弃 WebDAV 目录时，必须将对应 UI/AI/WebDAV/导出检查记录为“未执行”，不能声称验证成功。

---

## English summary

After review, the controller checks `gh auth status`, validates the single `fork` push URL, builds the reviewed commit, and runs the generation-fenced deployment. Static application assets load only from the current GitHub Pages graph origin, and application API requests use the current fixed Miaobi API origin. `connect-src https:` remains for direct non-Jianguoyun WebDAV providers, which still require CORS. Jianguoyun users configure `https://dav.jianguoyun.com/dav/`, their account email, and a third-party application password rather than the login password. Jianguoyun traffic uses the fixed-origin `/api/webdav/jianguoyun` API FaaS route because browser CORS is unavailable; its host is not added separately to CSP. Credentials remain in browser persistence, are forwarded per request, and are not persisted by FaaS. New configurations enable auto-sync by default while explicit existing settings are preserved. Before deployment, run credential-free malformed/unsupported proxy checks and verify that neither responses nor logs expose authorization data. The fixed order is GitHub Pages push, Pages health, fresh API FaaS, fresh Web FaaS, FaaS health, fixed-page switch, then immutable schema-v3 state. No Magic CLI call is allowed before Pages health succeeds. v1/v2 states remain read-only rollback inputs and never imply GitHub Pages provenance. Monitor immutable `gh-pages` storage growth and use a separately reviewed retention procedure. Production publication and source-main push are controller-only post-review steps.

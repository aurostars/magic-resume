# 妙笔原生部署 / Miaobi Native Deployment

本文是 Magic Resume 妙笔原生部署的运维契约。中文为主；文末提供 English summary。这里不记录内部令牌、原始平台 API 或 CLI 原始响应。

## 1. 适用范围

妙笔生产链路由以下部分组成：

- TOS 上按 release 隔离的静态客户端资源；
- 妙笔 API FaaS；
- 妙笔 Web FaaS（提供注入运行时配置后的 HTML）；
- 固定页面 `https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR`，只在最后一步切换到已通过健康检查的 Web FaaS。

Cloudflare 构建仍被保留，**仅用于人工回滚**。妙笔运行时不会加载 Cloudflare Worker、`workers.dev` 或 Cloudflare 资源。

## 2. 前置条件

1. Node.js 20+，并可通过 Corepack 使用仓库锁定的 pnpm。
2. 工作区干净，部署目标 commit 已完成评审与本地回归。
3. 已安装并通过官方方式登录 `magic-builder` **1.3.0 或更高版本**。可运行 `magic-builder --version` 检查版本；本文不记录认证材料。
4. 部署机器和文件系统必须支持目录 `fsync`、硬链接以及安全的文件权限。能力预检失败时部署会在任何远端副作用前以 `MIAOBI_DURABILITY_UNSUPPORTED` 终止。
5. 同一工作区同一时刻只运行一个部署。锁会阻止并发发布；不要手工删除活跃锁。

## 3. 构建与本地契约检查

在仓库根目录运行：

```bash
corepack pnpm exec tsx --test tests/miaobi-production-contract.test.ts
```

该测试会真实执行妙笔构建和默认 Cloudflare 构建，并验证完整产物、安全主机约束、禁止的 `workers.dev` 与已知测试凭据，以及默认构建的 `dist/client`、`dist/server/server.js`。

也可以单独生成妙笔产物：

```bash
corepack pnpm build:miaobi
```

构建产物位于 `dist/miaobi/`：

- `api-faas.cjs`、`api-faas.meta.json`：API FaaS 与绑定 commit/nonce/hash 的构建元数据；
- `web-faas.cjs`：部署前占位版本，部署时会用最终 HTTPS API/TOS URL 重新生成；
- `client/`：浏览器客户端与 `client/assets/`；
- `page.html`：固定妙笔页面的本地发布工件，部署时会改写为最终 Web FaaS 跳转；
- `manifest.json`：本地生产产物清单；
- `asset-manifest.json`：仅在静态资源全部上传成功后由部署流程原子生成，记录妙笔返回的 HTTPS TOS URL。

`dist/` 是可重建目录，不是部署事实来源。

## 4. 生产部署

先确认当前 commit，再构建，最后调用部署脚本：

```bash
export MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)"
corepack pnpm build:miaobi
corepack pnpm deploy:miaobi
```

`corepack pnpm deploy:miaobi` 只接受与 `api-faas.meta.json` 一致的 `MIAOBI_GIT_COMMIT`。不要用环境变量绕过 commit 校验，也不要把认证信息写入命令历史、文档或日志。

发布顺序固定且不可跳过：

1. 预检持久化目录并取得带心跳的独占锁及单调递增 generation；
2. 上传 release 标记和客户端资源，所有资源完成后原子提交 `dist/miaobi/asset-manifest.json`；
3. 发布或更新 API FaaS；
4. 将妙笔返回的 HTTPS API URL 和 HTTPS TOS 基址注入 HTML，重建并发布 Web FaaS；
5. 校验 API 构建标记、Web 运行时配置和两端健康状态；
6. 持久化 pending 与 `page-inflight` 记录后，更新固定页面；
7. 持久化 `page-confirmed`，再提交不可变 generation state；
8. 清理本 generation 的 pending。历史不可变记录仍保留。

在第 6 步之前失败不会切换页面。页面成功确认后即使最终 state 提交中断，后续进程也只补交本地 state，不会重复发布页面。

## 5. Generation fencing 与状态目录

部署锁不只是互斥锁。每次尝试都会取得 `(generation, ownerToken)`，所有远端调用前后均重新确认锁文件的 token、inode 与心跳。租约过期并被后继者接管后，旧进程会得到 `MIAOBI_OWNERSHIP_LOST`，不能继续执行远端副作用、提交更高优先级状态或删除后继者的 pending。这就是 generation fencing。

状态布局：

```text
.miaobi/
├── states/<generation>-<ownerToken>.json   # 权威、不可变的已提交部署记录
├── state.json                              # 资源发布兼容/恢复视图，不是部署权威
└── reservations/                           # release ID 本地预留
.miaobi-recovery/
├── generations/                            # 单调 generation 预留
├── pending/                                # 页面提交前事务
├── page-inflight/                          # 已进入远端页面调用的屏障
├── page-confirmed/                         # 已确认的远端页面结果
└── deployment.lock                         # 带心跳的当前所有者锁
```

- 以 `.miaobi/states/` 中最高 generation 的有效记录为权威部署状态。
- `.miaobi/state.json` 仅是资源发布状态的兼容/恢复提示；不得用它覆盖 generation state。
- 旧版 `.miaobi/deployment.json` 和 pending 文件只用于严格校验后的迁移兼容，不应作为新自动化的写入目标。
- 这些目录使用 `0700`，记录使用 `0600`。它们防止意外损坏和非同 UID 进程写入，但不对同一用户身份下的恶意代码提供真实性保证。
- 不要修改、排序重写或删除不可变记录来“修复”部署；保留现场并由人工审查。

## 6. 远端页面结果不确定：必须 fail closed

一旦 `page-inflight` 已落盘，远端页面调用就可能已经生效。若进程在收到或持久化成功结果前中断，下一次运行会返回：

```text
MIAOBI_PAGE_RESULT_UNCERTAIN
```

此状态要求：

1. 立即停止自动发布和自动回滚；
2. 人工检查固定远端页面当前实际指向、对应 Web FaaS、运行时 API URL 和 TOS release；
3. 保存 `.miaobi/` 与 `.miaobi-recovery/` 现场，按独立审核后的恢复决定处理；
4. **绝不能**自动覆盖、自动重试页面发布、删除 `page-inflight` 或伪造 `page-confirmed`。

即使本地 `page.html` 看起来正确，也不能证明远端页面调用未成功。任何自动重试都可能把较新的页面结果覆盖为旧 generation，因此实现会永久 fail closed，直到人工验证与处置。

## 7. 回滚

### 妙笔版本回滚

1. 若出现 `MIAOBI_PAGE_RESULT_UNCERTAIN`，先按上一节人工核验，禁止直接重跑。
2. 选择已审核的历史 commit，在独立干净工作区重新执行完整构建、契约测试和回归。
3. 使用该 commit 的 `MIAOBI_GIT_COMMIT` 执行正常部署流程。不要手改 manifest、generation state 或远端页面。
4. 部署完成后核对新 generation、FaaS 健康状态与固定页面。

TOS release 是不可变发布单元；回滚也创建新的、可审计的部署 generation，而不是修改历史记录。

### Cloudflare 应急回滚

Cloudflare 产物只作为外部、人工控制的灾备入口保留。仅在妙笔链路无法恢复且已获批准时，由控制方把入口切回最近已验证的 Cloudflare 发布。不要让妙笔 HTML/FaaS/TOS 产物依赖 Cloudflare，也不要在妙笔部署脚本中自动切换 Cloudflare。恢复妙笔前仍需解决所有不确定页面屏障。

## 8. 浏览器本地数据边界

- 简历、设置、AI 配置以及 WebDAV 凭据保存在当前浏览器 profile 的本地存储中；部署过程不会把这些浏览器数据迁入 FaaS 或 TOS。
- 浏览器直接连接用户配置的 WebDAV 服务。简历和凭据不经过 Magic Resume API FaaS；远端简历是 HTTPS 传输的明文 JSON，Magic Resume 不提供静态加密。
- 同一 profile 下的脚本、扩展或其他用户可能读取本地存储。请使用专用、最小权限、仅限目标目录的 WebDAV 账号，勿在共享设备保存凭据。
- 清除浏览器本地数据会移除本地简历和已保存凭据，但不会删除 WebDAV 远端文件；部署/回滚也不会恢复浏览器本地数据。
- AI key 仅由浏览器按当前配置发起请求时使用。没有一次性测试 key 时，只验证安全失败，不记录或复用真实 key。

## 9. 发布后验证与限制

生产发布和外部验证由控制方在独立评审后执行，不属于普通代码实现提交。发布后至少检查：

- 固定页面可达且不跳转到 `workers.dev`；
- “我的简历”和设置页可渲染；
- 有交互浏览器时验证 localStorage、JSON 导入/导出、非空 Word/PDF 导出；
- 只有提供一次性 AI key 时验证真实 AI；否则只验证安全失败；
- 只有提供独立、可丢弃且已授权的 WebDAV 目录时验证真实同步；否则跳过；
- 有控制台时确认没有新增 CSP、CORS、localStorage 或运行时错误。

没有可丢弃 WebDAV 目录或 AI key 时，不能声称完成对应端到端外部验证。没有交互浏览器时，也不能声称完成 UI、本地存储、导出和控制台验证。

---

## English summary

Use authenticated `magic-builder` 1.3.0+, set `MIAOBI_GIT_COMMIT` to the reviewed HEAD, then run `corepack pnpm build:miaobi` and `corepack pnpm deploy:miaobi`. The deployment uploads immutable TOS assets, publishes API and Web FaaS, health-checks both, and switches the fixed page only after durable generation-fenced records are prepared.

The highest valid record in `.miaobi/states/` is authoritative. `.miaobi/state.json` is only a compatibility/recovery hint for asset publication. A superseded owner is fenced from further remote mutations. `MIAOBI_PAGE_RESULT_UNCERTAIN` is permanently fail-closed: manually verify the remote page and never automatically override, retry, delete the in-flight barrier, or fabricate confirmation.

Resume data, settings, AI configuration, and WebDAV credentials remain in the current browser profile. WebDAV traffic goes directly from the browser to the configured server. Cloudflare is retained only as a manually controlled rollback path and is not used by the Miaobi runtime. Real AI/WebDAV end-to-end checks require disposable credentials/directories; otherwise document them as skipped.

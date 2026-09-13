# 妙笔原生部署设计

## 背景与目标

Magic Resume 当前通过 Cloudflare Workers 运行 TanStack Start 服务端，并由浏览器保存简历数据和 WebDAV 凭据。目标是将网页入口、静态资源和服务端 API 全部迁移到妙笔，用户访问妙笔地址即可使用完整应用，不再依赖 Cloudflare 域名或运行时。

本次迁移保留现有数据模型和隐私边界：简历仍保存在浏览器与用户配置的 WebDAV 中，妙笔服务端不持久化简历正文、WebDAV 凭据或 AI 请求内容。

## 已确认方案

采用“妙笔 FaaS 应用入口 + 妙笔 TOS 静态资源 + 妙笔 FaaS API Router”的原生部署架构。

不采用以下方案：

- 不把应用嵌入妙笔 HTML Box iframe。HTML Box 的安全沙箱会限制应用所需的浏览器同源存储。
- 不把全部字体、图片、脚本和样式内联到单个 HTML。产物过大，缓存、首屏性能和维护性较差。
- 不直接把现有 TanStack Start 服务端包原样放入单个 FaaS。当前服务端产物包含针对 Cloudflare/Node 兼容层的运行时假设，直接迁移风险较高。

妙笔 CLI 支持页面、FaaS 和文件资源的发布与管理，本方案分别使用这三类能力完成入口、服务逻辑和静态资源部署（妙笔 CLI 使用说明：https://bytedance.larkoffice.com/docx/PTIkdJ9Zoomrq3x2IQNc0hUxnjg）。

## 总体架构

```text
妙笔页面（应用发现入口）
└── 跳转至妙笔 Web FaaS 顶层地址

妙笔 Web FaaS
├── GET /                 -> 返回 SPA index.html
├── GET /app/*            -> 返回 SPA index.html
├── GET /dashboard/*      -> 返回 SPA index.html
└── 其他前端 History 路由 -> 返回 SPA index.html

妙笔 API FaaS
├── /api/grammar          -> 语法检查
├── /api/polish           -> AI 润色
├── /api/resume-import    -> 智能简历导入
└── /api/proxy/image      -> 外部图片代理

妙笔 TOS
├── JavaScript / CSS chunks
├── 字体文件
├── 模板预览图
├── SVG / 图片
└── 其他静态资源

浏览器
├── localStorage：简历、设置、WebDAV 凭据
├── WebDAV：每份简历独立 JSON + manifest/objects
├── 本地导入导出：JSON / Markdown / Word
├── 客户端导出：长图 / 本地 PDF
└── 调用妙笔 API FaaS：AI / 智能导入 / 图片代理
```

## 前端构建

### SPA 入口

新增妙笔专用 Vite SPA 构建，不替换现有 Cloudflare 构建：

- 使用现有 React 页面、TanStack Router 路由树、Zustand store 和组件。
- 禁用服务端渲染及 TanStack Start 服务端入口。
- 生成一个轻量 `index.html` 和浏览器端资源清单。
- 所有前端 History 路由由 Web FaaS 回退至同一 `index.html`。
- 妙笔构建使用独立脚本和配置，避免影响现有开发、测试和 Cloudflare 回滚产物。

### 静态资源

构建后先上传所有非 HTML 资源至妙笔 TOS，再根据上传返回的 URL 生成最终 `index.html`：

1. 生成 SPA 客户端资源。
2. 遍历构建清单中的 JS、CSS、字体、模板图和图标。
3. 使用稳定、带内容哈希的 key 上传到妙笔 TOS。
4. 生成 `asset-manifest.json`，记录本地路径、内容哈希、MIME 类型和 TOS URL。
5. 将 `index.html` 中的资源引用改写为 TOS 绝对 URL。
6. Web FaaS 内嵌最终 `index.html`，不在每次请求读取外部配置。

同一哈希资源可复用，发布新版本时不覆盖旧资源，以支持安全回滚。旧资源不在本次自动删除。

## 服务端迁移

### API Router

现有 API 业务逻辑从 TanStack Start route handler 中提取为与平台无关的函数：

```ts
type ApiHandler = (request: Request) => Promise<Response>;
```

妙笔 API FaaS 使用一个 CommonJS bundle，根据 URL pathname 分发到对应 handler。构建时将运行依赖打包进单个 JavaScript 文件，不依赖 FaaS 运行环境预装 npm 包。

### Web FaaS

Web FaaS 是独立的小型函数，只负责：

- 返回最终 SPA HTML；
- 对支持的方法返回正确状态；
- 添加必要的缓存、安全和内容类型响应头；
- 将未知前端路由回退到 SPA；
- 不代理 WebDAV，不接收 WebDAV 凭据。

Web FaaS 顶层地址是应用真实运行入口。妙笔页面仅用于应用发现和飞书打开方式，不承载应用状态，因此不会触发 HTML Box 的 `localStorage` 沙箱限制。

妙笔 FaaS 支持发布 Node.js 函数并通过 `/api/faas/{id}` 调用（妙笔空间 API 文档：https://bytedance.larkoffice.com/docx/A9kHdyZmeo0xOgxZXBXczpSEnS6）。

## 数据流与隐私边界

### 简历与 WebDAV

- 简历业务数据继续由 Zustand 持久化到浏览器 localStorage。
- WebDAV 地址、用户名和密码仍只保存在浏览器。
- 浏览器继续直接请求 WebDAV，保持现有 CORS 前置条件、原子 MOVE、CAS 与冲突处理语义。
- 妙笔 FaaS 不代理 WebDAV，不记录凭据，也不持久化简历 JSON。

### AI 与智能导入

- 浏览器只向妙笔 API FaaS 发送当前功能所需的请求数据。
- API Router 沿用现有 provider 校验、超时、错误脱敏和响应结构。
- 不写日志保存简历正文、图片正文、用户 API Key 或上游响应正文。
- 浏览器状态层只接收安全错误码和 HTTP 状态。

### 图片代理

- 继续执行协议、目标地址和响应类型校验。
- 禁止访问本地、环回、私网和元数据地址，避免 SSRF。
- 限制响应体大小与请求超时。

## URL、缓存与安全头

- 页面 HTML：`Cache-Control: no-store`，保证发布切换后及时获取新入口。
- 带内容哈希的 TOS 资源：长期不可变缓存。
- API 响应：默认 `no-store`。
- Web FaaS 与 API FaaS 仅允许应用自身需要的方法。
- API 校验 `Content-Type`、请求体大小和合法 JSON。
- CORS 只允许妙笔应用入口；开发环境使用显式 allowlist，不允许无条件 `*` 携带敏感请求。
- 错误响应不得包含密钥、WebDAV URL query、上游响应正文或简历正文。

## 发布流程

发布必须按以下顺序执行：

1. 运行测试与妙笔 SPA/API 构建。
2. 上传带哈希的 TOS 静态资源。
3. 发布新的 API FaaS，完成健康检查和安全错误检查。
4. 根据 TOS URL 与 API FaaS URL 生成最终 SPA HTML。
5. 发布新的 Web FaaS，验证首页和至少一个深层路由。
6. 更新妙笔页面 `vv6BtLE8MTR`，使其只跳转至新的 Web FaaS 地址。
7. 验证妙笔独立页面、应用模式、飞书侧边栏和标签页入口。
8. 保留 Cloudflare Worker 作为回滚版本，不在本次删除或下线。

发布失败时不更新妙笔页面；用户仍进入上一版。页面切换完成后若发现阻断问题，恢复上一版妙笔页面内容或 Web FaaS ID。

## 测试与验收

### 自动化测试

- SPA 构建不包含 Cloudflare URL 或 Cloudflare runtime import。
- HTML 中所有本地资源都已改写为妙笔 TOS URL。
- API Router 的四类接口保持现有请求/响应契约。
- Web FaaS 对首页与深层路由返回同一可启动 SPA。
- API 和页面错误不泄露敏感数据。
- 原 WebDAV、AI、导入和导出测试继续通过。

### 线上验收

- 妙笔地址直接显示完整应用，不经过 Cloudflare。
- 浏览器网络请求中不出现 `workers.dev`。
- 新建简历后刷新页面仍能恢复数据，证明 localStorage 可用。
- JSON/Word/PDF 导入导出可用。
- AI 润色、语法检查和智能导入调用妙笔 API FaaS。
- WebDAV 测试连接、同步和冲突提示保持正常。
- 首页、设置页和深层路由刷新无 404。
- 控制台无新增 CSP、CORS、localStorage 或运行时错误。

若没有可丢弃的 WebDAV 目录或测试 AI Key，线上验收只执行非破坏性部分，并在交付中明确列出未覆盖项，禁止使用用户生产数据冒险验证。

## 迁移范围与非目标

### 本次范围

- 妙笔专用 SPA 构建。
- TOS 资源发布和清单生成。
- Web FaaS 与 API FaaS bundle。
- 妙笔发布脚本、测试和部署说明。
- 更新现有妙笔页面入口。

### 非目标

- 不修改简历数据格式。
- 不迁移或托管用户简历数据。
- 不代理 WebDAV。
- 不删除 Cloudflare Worker。
- 不引入 D1、R2、KV 或其他云存储。
- 不改变现有 GitHub fork 的部署状态。

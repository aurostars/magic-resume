# GitHub Pages 静态资源发布设计

## 背景与目标

妙笔原生部署已经完成 Web FaaS、API FaaS、Hash Router、Node DNS-pinned 图片代理、原子页面切换和 generation fencing，但生产发布被妙笔 TOS 的 `audit confirmation failed` 阻塞。

本设计以 GitHub Pages 替代 TOS 承载浏览器静态资源。用户仍从妙笔域名访问应用，Cloudflare 和 TOS 都不参与妙笔运行时。

## 用户入口与域名

用户访问固定妙笔入口：

```text
https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR
```

页面跳转至妙笔 Web FaaS：

```text
https://magic.solutionsuite.cn/api/faas/<web-faas-id>
```

Web FaaS 返回 SPA HTML。浏览器随后从 GitHub Pages 加载静态资源：

```text
https://aurostars.github.io/magic-resume/objects/<sha256>/<filename>
```

AI、导入、语法检查和图片代理请求妙笔 API FaaS。地址栏中的主域名始终是 `magic.solutionsuite.cn`；`aurostars.github.io` 只作为后台静态资源域名。

## GitHub Pages 存储模型

fork 仓库使用公开的 `gh-pages` 分支，和 `main` 源码历史隔离。

```text
/
├── objects/<sha256>/<filename>
├── releases/<git-sha>/manifest.json
├── releases/<git-sha>/index.html
├── current.json
└── .nojekyll
```

- `objects/` 是内容寻址、只增不改的事实源。
- 相同字体、图片和模板只提交一次；后续 release 复用原对象。
- `releases/<git-sha>/manifest.json` 记录该版本完整资源映射、MIME、大小和哈希。
- `current.json` 只供人工查看，不是运行时事实源。
- 不自动删除历史对象，确保旧 Web FaaS 和回滚版本仍可运行。

## 发布器

新增 GitHub Pages publisher，使用临时 Git worktree 操作 `gh-pages`：

1. 验证 fork remote 指向 `aurostars/magic-resume`。
2. 获取远端 `gh-pages`；不存在时创建 orphan 分支。
3. 将构建后的完整 `dist/miaobi/client` 转换为内容寻址资源：
   - 文本资源安全重写内部引用；
   - 二进制资源保持原始字节；
   - 排除 source map、dotfile、服务端 bundle、测试文件和本地状态；
   - 拒绝秘密、本地绝对路径、`workers.dev` 和 TOS URL。
4. 已存在且哈希一致的对象不重复写入。
5. 写入 release manifest、release index 和 `.nojekyll`。
6. 提交后普通 push `gh-pages`，禁止 force push。
7. 非 fast-forward 时重新获取远端，在新的临时 worktree 中重新合并内容寻址对象并重试有限次数。
8. 所有临时 worktree 必须在成功或失败后清理，不能影响当前开发分支。

GitHub commit 只包含浏览器公开构建资源，不包含任何凭据、简历数据、WebDAV 配置或 AI key。

## Pages 激活与健康检查

发布器使用 GitHub Pages 标准地址：

```text
https://aurostars.github.io/magic-resume/
```

首次发布后通过 GitHub API/CLI确认 Pages 来源为 `gh-pages` 分支根目录；如果尚未启用则启用。该操作只配置当前 fork。

推送后轮询本次 release manifest 和至少一个 JS、CSS 入口：

- 必须返回 2xx；
- 禁止跟随到非 GitHub Pages origin；
- 响应字节 SHA-256 必须与 manifest 一致；
- MIME 必须与资源类型匹配；
- 使用总 deadline 和有限退避；
- 日志不得输出响应正文或秘密。

Pages 未生效时，不发布 FaaS、不切换妙笔页面。

## 妙笔部署集成

部署顺序修改为：

```text
本地构建与测试
→ GitHub Pages 内容寻址资源提交并 push
→ Pages 资源健康检查
→ 创建新 API FaaS
→ 创建新 Web FaaS
→ 两个 FaaS 健康检查
→ 最后更新固定妙笔页面 vv6BtLE8MTR
→ 提交 immutable deployment state
```

每次 release 创建新的 API/Web FaaS，不在页面切换前覆盖线上实例。Web FaaS HTML 内注入：

- `platform: "miaobi"`
- 新 API FaaS URL
- 当前 release 的 GitHub Pages asset base URL

CSP 允许当前妙笔 API origin、GitHub Pages 静态资源、图片 data/blob 和用户配置的 HTTPS WebDAV。应用自身继续拒绝 `workers.dev`。

## 原子性与恢复

- GitHub Pages push 失败：没有 FaaS 或页面副作用。
- Pages 健康检查失败：不继续发布。
- API/Web FaaS 或健康检查失败：固定页面保持旧版本。
- page 更新失败或结果不确定：沿用 generation fencing、immutable pending 和 `MIAOBI_PAGE_RESULT_UNCERTAIN` 永久屏障。
- GitHub Pages 已发布但妙笔后续失败时，保留该不可变 release；下次可复用，不视为线上切换。
- 不自动删除旧 Pages 对象或旧 FaaS，确保回滚能力。

## 回滚

回滚选择已有 release manifest 和对应 API/Web FaaS，经健康检查后重新发布固定妙笔页面。`current.json` 不参与回滚决策。页面结果不确定时禁止自动覆盖或重试。

## 测试策略

- 本地 bare Git remote：覆盖首次 orphan 创建、重复发布去重、非 fast-forward 重试、push 失败和 worktree 清理。
- 资产测试：覆盖完整 client 资源、内容哈希、文本引用重写、二进制不变、MIME、过滤和秘密扫描。
- HTTP 测试：覆盖 Pages 延迟生效、错误 MIME、跨 origin redirect、哈希不匹配和总 timeout。
- 部署状态机：验证 Pages 必须早于 FaaS，任何 Pages 失败都不调用妙笔 CLI。
- 回归：妙笔、WebDAV、AI、导入、默认 Cloudflare 构建和妙笔构建。
- 生产验证：固定妙笔入口、GitHub Pages release、API/Web FaaS 均可访问，运行时不请求 Cloudflare 或 TOS。

## 非目标与约束

- 不使用 `raw.githubusercontent.com` 或 jsDelivr 作为正式资源入口。
- 不购买或配置自定义域名。
- 不把简历、WebDAV 凭据或 AI key 写入 GitHub。
- 不删除现有 Cloudflare 部署；它只保留为人工回滚路径。
- GitHub Pages 是公开静态资源服务，不用于任何用户数据存储。

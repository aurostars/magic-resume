# 妙笔原生部署 Final Review 修复报告

## 范围

- 基线：`73c57e0167e59371db65a1c384d88cd78ac9d638`
- 本轮只执行本地修复、构建与测试；未 push、未调用真实妙笔/TOS 发布。
- 目标：一次性关闭 final whole-branch review 中的 Critical/Important，并保留既有 Cloudflare build 与安全边界。

## 已修复

1. **原子 FaaS 发布**
   - 每个 release 始终新建 API 与 Web FaaS，不再把 prior ID 作为 `faas publish --id` 传入。
   - 固定页面仍是最后一个远端切换动作；历史 FaaS ID 保留用于人工回滚。
   - 新 ID 仅在页面确认并提交 generation state 后成为 authoritative prior。

2. **完整 API surface**
   - shared router 新增 `POST /api/ai-test`，并复用 text provider 的 `test` action。
   - 前端模型测试通过 runtime-aware URL adapter 发往妙笔 FaaS。

3. **Node DNS-pinned 图片代理**
   - 妙笔 API 使用 Node 内置 `dns/promises`、`http`、`https` 和 stream bridge。
   - 每次请求及每次 redirect 都解析并验证全部地址；socket lookup 只返回已经验证的地址集合。
   - HTTPS SNI 与 `Host` 保持原目标 hostname；没有 ambient `fetch` 回退，也没有新增运行时依赖。

4. **Hash router 导航**
   - 移除 PreviewDock 的 pathname/assign fallback。
   - LandingHeader 使用 TanStack Router。
   - legacy redirect 在妙笔 runtime 内只更新 hash，不逃离 `/api/faas/<web-id>`。

5. **完整 TOS 资产图**
   - 发布目录由 `client/assets/` 扩为完整 `client/`。
   - 构建后统一重写 JS/CSS/HTML 中的 bundled assets、字体、模板快照、favicon、SVG 与图片根路径。
   - 文本资源继续做 placeholder 替换；二进制保持原字节；补齐 txt/xml/ico MIME。

6. **资源发布持久化与恢复**
   - reservation 使用 owner token、独占 hard-link commit、文件 `fsync` 与目录 `fsync`。
   - state 更新在持久化锁内执行，并绑定 owner token。
   - manifest 先提交 `.miaobi/manifests/<releaseId>-<ownerToken>.json` 不可变记录，再原子更新兼容 manifest。
   - 上传阶段失败时仅当前 owner 可释放未提交 reservation，因此同 release 可恢复重试；进入 manifest-staged 后保持 fail closed。

7. **低风险安全修补**
   - Web FaaS CSP 的 `img-src` 明确允许 self、TOS origin 与 API origin。
   - 文件排序改用稳定 code-point 比较，避免 locale-dependent 发布顺序。

## TDD 证据

先观察到以下真实 RED，再完成实现：

- 复用 FaaS ID：rerun 测试检测到 `--id`。
- `/api/ai-test`：shared router 返回 404；前端 helper 不存在。
- Node image transport：模块不存在，妙笔图片路由无法执行真实公网 transport。
- Hash navigation：jsdom 捕获 pathname navigation，hash 未更新。
- 完整 SPA 资产：build 仍返回 `client/assets`，bundle 保留 public 根路径。
- reservation 恢复：上传失败后的同 release retry 返回 `MIAOBI_RELEASE_RESERVED`。
- immutable manifest：`.miaobi/manifests/` 不存在。

对应 focused tests 均已转 GREEN。

## 验证结果

- Focused API/router/image/security：45/45 PASS
- `tests/miaobi-assets.test.ts`：26/26 PASS
- `tests/miaobi-spa-build.test.ts`：5/5 PASS
- `corepack pnpm test:miaobi`：164/164 PASS
- `corepack pnpm test:webdav`：197/197 PASS
- `corepack pnpm test:resume-import`：13/13 PASS
- `corepack pnpm test:ai`：436/436 PASS
- `corepack pnpm build`：PASS
- `corepack pnpm build:miaobi`：PASS
- `git diff --check`：PASS

构建仍输出既有 Rollup circular-chunk 与 chunk-size warnings；不影响退出状态或本轮契约。

## 外部阻塞

真实生产发布仍由外部平台阻塞：`magic-builder 1.4.0 file upload` 在 TOS transfer 后返回 `E_REQUEST_FAILED: audit confirmation failed`。本轮未绕过该审核、未真实部署。该问题需要平台侧 TOS audit/权限确认后再执行独立生产发布验证。

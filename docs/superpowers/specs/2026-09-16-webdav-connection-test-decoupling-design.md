# WebDAV 测试连接解耦与初始化诊断设计

## 背景与根因

妙笔生产版本在输入合法的坚果云地址、非空用户名、非空密码和默认目录后，点击“测试连接”仍显示 `WD-CLIENT-UNKNOWN`。本地浏览器复现确认：

- 表单值已经写入 `webdav-sync-storage`；
- 页面没有 JavaScript 异常；
- 点击后没有发出 `/api/webdav/jianguoyun` 请求；
- 刷新后重试仍不会发出请求。

当前设置页保存表单后，通过全局 `getWebDavSyncController()` 获取控制器。控制器的创建同时依赖简历 Store 的 `_hasHydrated` 状态和完整同步生命周期；控制器不存在时，设置页直接写入 `{ code: "UNKNOWN", status: null }`。因此连接测试在到达妙笔 API、坚果云认证和目录检查之前就失败了。

## 目标

- “测试连接”只依赖当前已规范化的 WebDAV 设置，不依赖简历 Store hydration 或全局同步控制器。
- 正式同步继续依赖已 hydration 的简历数据和现有 `WebDavSyncController`，不削弱数据一致性门禁。
- 测试连接仍按现有顺序执行 `OPTIONS` 和 `PROPFIND`，继续使用坚果云固定代理及现有错误映射。
- 控制器未就绪时，正式同步显示明确的 `WD-CLIENT-NOT-READY`，不再显示无法定位的 `WD-CLIENT-UNKNOWN`。
- 不记录或展示密码、Authorization、请求正文、上游正文或原始异常。

## 方案选择

### 采用：一次性连接测试客户端

把连接测试提取为独立函数：

```ts
export async function testWebDavConnection(
  settings: WebDavSettings,
  signal?: AbortSignal,
): Promise<void>
```

该函数创建 `WebDavClient`，对 `settings.remoteDirectory` 依次调用 `options()` 与 `propfind()`。设置页在保存规范化设置后直接调用该函数，不再等待 React effect 创建全局控制器。

优点：

- 与测试动作真实所需依赖一致；
- 避免 React effect 时序和 hydration 状态影响；
- 复用现有客户端、坚果云代理、超时与错误分类；
- 不改变正式同步架构。

### 未采用：放宽全局控制器 hydration 门禁

这会让自动同步或下载逻辑在本地简历尚未恢复时启动，存在覆盖或冲突判断错误风险。

### 未采用：轮询等待全局控制器

只能掩盖初始化问题，仍会在 hydration 永不完成时超时，而且增加不必要的时序状态。

## 组件与数据流

### 独立连接测试

1. 设置页规范化地址、用户名和远程目录。
2. 设置页保存规范化后的设置。
3. 设置页进入 `testing` 状态，并创建可取消请求。
4. `testWebDavConnection()` 创建一次性 `WebDavClient`。
5. 客户端执行 `OPTIONS`，再执行 `PROPFIND`。
6. 成功时设置页显示成功；失败时沿用 `WebDavError { code, status }` 和安全诊断码。

### 正式同步

“立即同步”和自动同步继续调用全局 `WebDavSyncController`。若控制器尚未就绪，写入新的安全错误类型：

```text
CLIENT_NOT_READY → WD-CLIENT-NOT-READY
```

中文建议提示刷新页面；若持续出现，说明本地简历数据初始化未完成。该诊断不包含底层异常。

## 生命周期与取消

一次性连接测试使用独立 `AbortController`，并复用 `WebDavClient` 的 15 秒请求超时。组件卸载或用户再次发起动作时，当前请求应被取消。连接测试不创建 repository、coordinator 或自动同步订阅。

## 安全边界

- 坚果云 URL 继续限定为 `https://dav.jianguoyun.com/dav/` 并通过妙笔 API FaaS 代理。
- Basic Authorization 仍只在代理请求 envelope 中传递，并由服务端生成上游请求头。
- UI/store 只保留安全的 `{ code, status }`。
- 不接受旧字符串路径 envelope，不改变路径段协议。
- 不向日志或诊断信息写入任何凭据及原始异常。

## 测试策略

- 新增独立函数测试，确认 `OPTIONS`、`PROPFIND` 顺序和远程目录传参。
- 新增真实设置页集成测试：不注入 controller，填写配置后点击“测试连接”，必须产生代理请求；该测试在修复前应得到 `WD-CLIENT-UNKNOWN` 且请求数为零。
- 验证连接测试不要求 `_hasHydrated=true`。
- 验证“立即同步”仍要求全局控制器，并在缺失时显示 `WD-CLIENT-NOT-READY`。
- 覆盖 `401`、`403`、`502`、timeout 和 abort 的现有安全映射。
- 回归运行 WebDAV、妙笔生产契约、完整妙笔及整仓测试。

## 发布与验收

按现有 fenced 妙笔发布流程发布新 GitHub Pages release、API FaaS 和 Web FaaS，健康检查完成后切换固定页面。生产验收包括：

- 使用安全无效凭据点击“测试连接”时确实发出代理请求并得到 `WD-AUTH-401`，而不是 `WD-CLIENT-UNKNOWN`；
- 固定页面指向新 Web FaaS；
- manifest、资源哈希、API build marker 与源码 HEAD 一致；
- 用户真实凭据仅在用户自己的浏览器中输入。

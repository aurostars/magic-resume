# 坚果云 WebDAV 代理与自动同步默认值设计

## 背景

当前 WebDAV 客户端直接在浏览器中访问远端服务器。坚果云的 WebDAV 地址 `https://dav.jianguoyun.com/dav/` 对跨域预检请求返回 `401`，且不返回浏览器要求的 CORS 响应头，因此妙笔页面无法直接发送带认证信息的 `PROPFIND` 等 WebDAV 请求。

用户输入的地址还可能携带零宽字符等不可见 Unicode 格式字符，例如末尾的 `U+200C`。这会改变实际请求路径并导致难以识别的连接失败。

本次改动只为坚果云提供服务端代理，并将新 WebDAV 配置的自动同步默认值改为开启。已有用户保存的开关状态不得被覆盖。

## 目标

- 让妙笔部署的网站可以使用坚果云 WebDAV 的连接测试和完整同步功能。
- 新创建的 WebDAV 配置默认开启自动同步。
- 保持已有用户明确保存的自动同步开关状态。
- 自动清理 WebDAV 地址首尾的空白和常见不可见格式字符。
- 保持非坚果云 WebDAV 的现有浏览器直连行为不变。
- 代理实现必须固定目标、限制方法、限制数据量并避免凭据泄露。

## 非目标

- 不为任意 WebDAV 服务提供通用服务端代理。
- 不在服务端持久化用户名、第三方应用密码或简历正文。
- 不改变现有 WebDAV 文件结构、冲突策略、删除策略和 JSON 格式。
- 不强制迁移已有用户的自动同步设置。

## 架构

### 请求路径

```text
浏览器中的 WebDAV 控制器
  ├─ 坚果云 → 妙笔 API FaaS → https://dav.jianguoyun.com/dav/
  └─ 其他服务 → 现有浏览器直连 WebDAV
```

客户端根据规范化后的 URL 判断服务商。只有协议为 HTTPS、主机精确等于 `dav.jianguoyun.com`、路径位于 `/dav/` 下的请求才能进入坚果云代理。

### 客户端传输层

在现有 WebDAV 客户端网络边界增加可替换传输层：

- 默认传输层继续使用浏览器 `fetch`。
- 坚果云传输层将 WebDAV 请求转换为同源 API FaaS 请求。
- 控制器、manifest、对象存储、冲突处理和自动同步逻辑不感知传输差异。

客户端在保存和使用设置前执行相同的 URL 规范化：

1. 删除首尾 Unicode 空白；
2. 删除首尾 `U+200B`、`U+200C`、`U+200D`、`U+2060` 和 `U+FEFF`；
3. 对坚果云根地址补齐末尾 `/`；
4. 拒绝 URL 中的用户名、密码、非 HTTPS 协议和非默认端口。

## API FaaS 代理

新增逻辑路由：

```text
POST /api/webdav/jianguoyun
```

采用固定目标的请求封装，而不是接受任意远端 URL。请求体包含：

- `method`：受支持的 WebDAV 方法；
- `path`：相对于 `/dav/` 的规范化路径；
- `headers`：仅允许同步所需的 WebDAV 头；
- `body`：PUT、PROPFIND 等请求所需的正文；
- `username` 和 `password`：坚果云账号与第三方应用密码。

服务端目标始终按以下方式构造：

```text
https://dav.jianguoyun.com/dav/ + validatedRelativePath
```

客户端不能提交或覆盖协议、主机、端口和根路径。

### 方法与响应

仅允许当前同步流程使用的方法：

- `OPTIONS`
- `PROPFIND`
- `MKCOL`
- `GET`
- `PUT`
- `DELETE`
- `MOVE`

代理只转发必要请求头，例如 `Depth`、`Destination`、`Content-Type`、条件请求头和 Basic Authorization。`Destination` 必须重新解析并确认仍位于坚果云 `/dav/` 根路径下。

响应向客户端返回：

- 原始 HTTP 状态码；
- 同步逻辑需要的 DAV、ETag、Last-Modified、Content-Type 等白名单响应头；
- 受大小限制的响应正文；
- `Cache-Control: no-store`。

不透传 Cookie、认证挑战中的敏感信息或其他无关头。

### 安全边界

- 上游 origin 固定为 `https://dav.jianguoyun.com`。
- 禁止用户信息、非 HTTPS、非默认端口和跨 origin 重定向。
- 相对路径解码和规范化后不得包含路径穿越。
- 方法和请求头采用白名单。
- 请求体与响应体设置明确上限；超过上限返回稳定错误。
- 认证信息、Authorization、正文和上游错误正文不得写入日志或客户端错误文本。
- 所有代理响应禁用缓存。
- FaaS 错误统一映射为稳定且不泄露内部细节的业务错误码。

## 自动同步默认值与兼容性

`defaultSettings.autoSyncEnabled` 改为 `true`。

持久化合并必须区分“字段不存在”和“用户保存了 false”：

- 新用户或旧数据中完全没有 `autoSyncEnabled` 字段时使用新默认值 `true`；
- 已保存 `autoSyncEnabled: false` 的用户继续保持关闭；
- 已保存 `true` 的用户保持开启。

不通过版本迁移强制改写现有布尔值。

## 连接测试与错误处理

坚果云连接测试经 FaaS 代理执行：

1. 对 `/dav/` 执行 `OPTIONS`；
2. 对配置的远端目录执行 `PROPFIND`，`Depth: 0`；
3. 根据结果判断认证、目录权限和 WebDAV 能力。

错误至少区分：

- 用户名或第三方应用密码错误；
- 无权限访问远端目录；
- 远端目录不存在且无法创建；
- 坚果云不可达或请求超时；
- 地址格式无效或已被安全规则拒绝；
- 上游不支持所需 WebDAV 方法；
- 未分类的稳定通用错误。

UI 不显示上游响应正文、堆栈、凭据或内部 FaaS 信息。

## 测试策略

### 客户端

- 新配置默认 `autoSyncEnabled: true`。
- 持久化的 `false` 不会被默认值覆盖。
- URL 末尾不可见字符被清理。
- 坚果云 URL 自动选择代理传输层。
- 非坚果云 URL 保持浏览器直连。
- 代理响应可被现有 WebDAV XML、ETag 和冲突逻辑正常消费。

### API FaaS

- 允许七种受支持方法并正确转发状态、正文和白名单头。
- 拒绝非法方法、绝对 URL、非坚果云目标、路径穿越和非法 `Destination`。
- 拒绝超出限制的请求体和响应体。
- 禁止跨 origin 重定向。
- `401`、`403`、`404`、`405`、`5xx` 和超时映射正确。
- 错误结果不包含用户名、密码、Authorization 或上游正文。

### 回归验证

- 原有 WebDAV 单元与行为测试通过。
- 妙笔 API FaaS bundle 在禁止运行时 `require` 的环境中仍可加载。
- 妙笔生产构建和部署健康检查通过。
- 使用坚果云第三方应用密码完成真实连接测试，但不得把凭据写入测试代码、日志或提交。

## 发布与回滚

按现有原子部署流程发布新的 GitHub Pages 资源、API FaaS 和 Web FaaS，健康检查通过后再切换固定妙笔页面。

若代理健康检查或真实坚果云连接验证失败，不切换固定页面。旧 FaaS 与旧 GitHub Pages 资源保留用于回滚。

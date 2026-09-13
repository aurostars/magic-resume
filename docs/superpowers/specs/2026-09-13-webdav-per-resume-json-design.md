# WebDAV 单简历 JSON 多文件同步设计

## 背景

Magic Resume 当前将所有简历及活动简历 ID 打包进单个 `magic-resume.json` WebDAV 快照。该结构适合原子备份，但不便于用户直接在 WebDAV 中查看、整理、单独下载和重新导入某一份简历。

本设计将 WebDAV 持久化改为“中央清单 + 每份简历独立 JSON”。每份简历文件必须与网站当前“导出 JSON”产生的文件在数据结构上完全一致，可直接通过现有导入入口重新导入。同步协议所需的版本、哈希、设备和删除信息只进入独立的 `manifest.json`，不得污染简历文件。

本次不迁移旧版 `magic-resume.json`；用户已确认远端不存在旧文件。

## 目标

- 每份简历在 WebDAV 中对应一个可读、可单独导入导出的 JSON 文件。
- 简历 JSON 顶层保持现有 `ResumeData` 格式，不加入同步元数据。
- 不同设备修改不同简历时自动合并，冲突粒度缩小到单份简历。
- 删除的简历移动到 WebDAV 垃圾箱，避免不可恢复的远端删除。
- 保留现有 WebDAV 的结构验证、哈希校验、ETag/CAS、原子上传和安全错误处理能力。
- 保持现有设置流程简洁，不引入网页端文件管理器。

## 非目标

- 不迁移旧版单文件 `magic-resume.json`。
- 不在应用中实现 WebDAV 垃圾箱浏览、恢复或定期清理。
- 不增加服务端数据库、Cloudflare D1、R2 或账号系统。
- 不改变网站现有手动 JSON 导入导出的业务格式。
- 不实现多人实时协作编辑。

## 远端目录结构

```text
/magic-resume/
├── manifest.json
├── objects/
│   ├── a81f32-full-id/<content-hash>.json
│   └── 72be91-full-id/<content-hash>.json
├── resumes/
│   ├── 产品经理简历--a81f32.json
│   └── 英文简历--72be91.json
└── trash/
    └── 已删除简历--d09c17.json
```

用户仍可在设置中修改根目录。所有路径均相对于该根目录解析。`objects/` 是不可变内容对象的事实源；`resumes/` 与 `trash/` 只是可读、可修复的镜像。

## 简历文件格式

`resumes/*.json` 的顶层数据就是现有 `ResumeData`：

- 与 `exportResumeAsJson` 使用的数据结构一致。
- 可被现有 `importResumeFromJson` 入口直接读取。
- 不包含 `schemaVersion`、`revision`、`parentRevision`、`deviceId`、`contentHash`、ETag 或活动简历 ID。
- 使用稳定的格式化 JSON 序列化，便于人工阅读和版本比较。
- 同步读取时使用比当前手动导入更严格的 `ResumeData` 运行时校验；无效文件不得写入本地 Store。

“格式一致”指业务数据结构一致，而不是要求字节级等同。WebDAV 写入和手动导出必须共用同一个纯数据序列化函数，避免字段、格式化或规范化规则漂移。

## 文件命名

文件名格式：

```text
<安全化后的简历标题>--<简历 ID 前 6 位>.json
```

规则：

- 标题安全化复用现有 `getSafeFileName` 逻辑。
- `/ : * ? " < > |` 等非法字符按现有导出规则替换。
- 简历 ID 是唯一身份；文件名只是可读映射。
- ID 短段用于避免重名，身份判断不得依赖短 ID 或文件名。
- 标题变化时生成新文件名；新文件写入成功后再移除旧路径。
- 标题为空时沿用现有导出文件名的回退规则。

## Manifest 数据模型

`manifest.json` 是同步协议的权威索引，建议采用版本化结构：

```json
{
  "schemaVersion": 2,
  "revision": 12,
  "parentRevision": 11,
  "updatedAt": "2026-09-13T02:00:00.000Z",
  "deviceId": "device-id",
  "activeResumeId": "resume-id",
  "entries": {
    "resume-id": {
      "objectPath": "objects/resume-id/<content-hash>.json",
      "mirrorPath": "resumes/产品经理简历--a81f32.json",
      "contentHash": "sha256-hash",
      "updatedAt": "2026-09-13T01:59:00.000Z",
      "deleted": false
    }
  },
  "manifestHash": "sha256-hash"
}
```

字段语义：

- `schemaVersion`：多文件协议版本，初始为 2。
- `revision` / `parentRevision`：用于清单级三方比较和 CAS 重试。
- `activeResumeId`：全局活动简历；指向不存在或已删除条目时回退到本地有效简历。
- `entries`：以完整简历 ID 为键的文件索引。
- `objectPath`：不可变事实源路径，必须精确为 `objects/<完整简历 ID>/<contentHash>.json`；对象发布后永不覆盖、移动或删除。
- `mirrorPath`：可读镜像路径；live 条目位于 `resumes/`，deleted 条目位于 `trash/`。
- `contentHash`：对纯 `ResumeData` canonical JSON 计算的 SHA-256。
- `deleted`：删除标记；只改变清单状态与 `mirrorPath`，不改变历史 `objectPath`。
- `manifestHash`：对排除自身后的清单 canonical JSON 计算哈希。

ETag 属于一次远端读取获得的传输层 CAS token，不写入 `manifest.json`，避免服务端重写 ETag 后造成陈旧元数据。

## 组件边界

### Resume JSON Codec

负责：

- 将单个 `ResumeData` 序列化成与手动导出一致的 JSON。
- 严格解析和验证远端单简历 JSON。
- 计算 canonical JSON 和内容哈希。
- 提供文件名安全化与短 ID 生成。

手动导出与 WebDAV 必须依赖同一 codec，不允许复制两套格式逻辑。

### Manifest Codec

负责：

- 创建、序列化和严格校验 `manifest.json`。
- 校验 ID、相对路径、哈希、删除状态和活动简历引用。
- 拒绝路径穿越、绝对路径、未知协议版本和重复路径。
- 计算、验证清单哈希。

### WebDAV Repository

在现有 `WebDavClient` 上封装多文件操作：

- 确保根目录、`objects/`、`resumes/`、`trash/` 存在。
- 读取清单与其 ETag。
- 从 `objectPath` 读取权威简历并校验内容哈希。
- 使用临时文件 + 条件 `MOVE` 原子创建不可变对象和发布清单。
- 在清单提交后尽力更新、重命名或移动可读镜像；镜像失败留待后续修复。
- 枚举 `resumes/` 中可人工加入的 JSON 文件。

### Sync Planner

纯函数比较本地状态、上次同步基线和远端清单，输出计划：

- 上传、下载、新增、重命名、移动到垃圾箱。
- 自动合并互不相交的简历修改。
- 生成同一简历的修改冲突或“删除 vs 修改”冲突。
- 决定活动简历 ID。

Planner 不执行网络和 Store 写入，便于完整单元测试。

### Sync Executor

按依赖顺序执行计划：

1. 在任何 repository 调用前校验 `expectedLocalToken`；不匹配则零网络操作并 deferred/replan。
2. 创建必要目录（包括 `objects/`）。
3. 创建并回读验证所有新的不可变 `objects/<id>/<hash>.json`；既有对象只校验、永不覆盖。
4. 下载从 `objectPath` 读取并验证；构造最终清单后，在发布前逐一回读并严格校验其全部 live `objectPath` 的 JSON、完整 ID 与内容哈希。缺失对象触发 `remote-changed` 重规划，损坏或不匹配对象 fail closed。
5. 在发布窗口订阅本地 snapshot token；清单请求发出前，本地变化或外部取消可阻止发布。请求一旦发出，本地变化只记录 `localChanged=true`，不得中止该请求，必须等待成功或明确远端错误。
6. 使用读取清单时获得的 ETag CAS，将本轮专属临时源 `MOVE` 到 `manifest.json`；临时源路径与上传后 ETag 构成本轮 operation handle。发布成功且本地已变化时，重新读取并确认远端仍是本轮 manifest，再用其 ETag CAS 恢复旧清单；首次同步则条件删除。若 `MOVE` 返回不确定网络错误，先以临时源 ETag 条件删除该源：删除成功即证明晚到 `MOVE` 必然失败，旧清单是确定终态；删除返回 404/条件失败时，才读取 destination 并分类为本轮、旧版或第三方。本轮版本按当前 CAS 恢复，第三方绝不覆盖；若 destination 仍是旧版/404 且临时源已不存在，必须保持 `remote-uncertain`、fail closed，后续同步继续 reconcile。任何固定次数即时 GET 都不能证明旧版是终态。恢复 CAS 失败同样视为第三方变化。
7. 仅在清单成功且发布窗口核验稳定后，尽力更新 `resumes/` / `trash/` 可读镜像；对象、移动及镜像修复操作传播调用方 AbortSignal，但已发出的 manifest publish 不再被取消。
8. 原子提交本地 Resume Store 与同步基线。

清单 CAS 失败时不执行镜像操作；本轮新对象只是安全孤儿，旧清单仍完整指向旧对象。镜像失败不回滚清单，因为后续同步可从不可变对象修复镜像。

## 首次同步

远端没有 `manifest.json` 时：

1. 确保根目录及 `objects/`、`resumes/`、`trash/` 四个目录存在。
2. 获取当前本地所有简历。
3. 逐份生成纯 `ResumeData` JSON 和哈希。
4. 原子创建并验证不可变 `objects/<id>/<hash>.json`。
5. 所有对象成功后条件创建初始 `manifest.json`。
6. 清单成功后生成 `resumes/` 可读镜像。
7. 原子保存本地基线。

如果在清单创建前出现失败，远端只会留下未索引的不可变对象；它们不影响旧事实源，也不会被 `resumes/` 人工导入扫描误识别。

## 日常同步

1. 等待 Resume Store hydration 完成并取得稳定本地快照。
2. 读取远端清单和 ETag。
3. 读取上次同步基线。
4. Sync Planner 进行简历级三方比较。
5. 无冲突时执行最小文件操作。
6. 执行期间本地数据变化时，本轮不覆盖新数据，并排队一次后续同步。
7. 清单 CAS 失败时丢弃本轮发布步骤，重新读取远端状态并规划；不得盲目覆盖。
8. 成功后原子提交本地数据和新基线。

未变化的简历不上传、不下载。修改一份简历只传输该简历文件与最终清单。

## 人工添加文件

为了支持用户直接向 WebDAV 放入网站导出的 JSON：

- 同步时通过 `PROPFIND` 枚举 `resumes/*.json`。
- 不在当前清单中的文件先进行严格 `ResumeData` 校验。
- 文件内 `id` 与现有条目不重复时，作为新简历候选导入。
- 文件内 `id` 已存在但路径不同，按同一简历的远端修改处理，不能创建重复简历。
- 同一完整 ID 的多个未索引文件若内容哈希相同，则按路径排序确定性去重；若哈希不同，则报告安全的 ambiguity warning 且本轮不导入该 ID，禁止按枚举顺序 last-write-wins。
- 无效 JSON、无效 `ResumeData`、路径异常或 ID 冲突文件被忽略，并显示不含文件内容或路径的安全提示。
- `trash/` 不参与自动导入，避免恢复已删除简历。

## 重命名

标题变化只改变 `mirrorPath`；内容对应的不可变 `objectPath` 仍由内容哈希决定。新对象（若内容变化）验证完成并成功 CAS 发布清单后，才更新新镜像并清理旧镜像。清理失败只留下可修复的陈旧镜像，不影响清单事实源。

## 删除与垃圾箱

用户在网站删除简历时：

- 清单保留原不可变 `objectPath`、内容哈希和完整 ID，将 `deleted` 设为 `true`，并把 `mirrorPath` 改到 `trash/`。
- 清单 CAS 成功后，才在 `trash/` 写入可读镜像；原对象永不移动或删除。
- 垃圾箱镜像继续保持纯 `ResumeData`，可人工下载并导入恢复。
- 其他设备以清单删除标记为准；`trash/` 不参加人工导入扫描。
- 网页不提供垃圾箱管理；用户在 WebDAV 中自行整理。

垃圾箱目标重名时使用稳定短 ID，并在极端路径冲突时附加确定性哈希后缀。

## 冲突语义

比较单位是完整简历 ID：

- 两侧修改不同简历：自动合并。
- 仅本地修改：上传该简历。
- 仅远端修改：下载该简历。
- 本地删除、远端未修改：移动到垃圾箱。
- 远端删除、本地未修改：删除本地简历。
- 一侧删除、另一侧修改：产生该简历的冲突。
- 两侧同时修改同一简历且哈希不同：产生该简历的冲突。
- 两侧结果哈希相同：视为无冲突。
- 每个冲突携带 `localUpdatedAt: string | null` 与 `remoteUpdatedAt: string | null`。本地值来自 `ResumeData.updatedAt`；远端 live/tombstone 值来自 entry `updatedAt`；远端 hard deletion（`remoteEntry: null`）使用 `manifest.updatedAt`。
- 冲突决策必须同时携带用户看到的 `seenRemoteEtag`（字段必传，可为 `null`）与 `seenManifestRevision`；应用前必须重读并同时校验。缺字段、ETag 不同或 revision 不同（包括 ETag 为 `null` 时 revision 变化）只能 deferred/replan。

冲突对话框展示具体简历标题，并提供：

- 保留本地版本。
- 使用云端版本。

选择只作用于冲突简历，不阻塞其他无冲突简历的合并计划；但清单发布必须等待本轮所有冲突得到解决。

## 本地基线

现有单个 `CloudSnapshotV1` 基线改为多文件基线，至少保存：

- 上次成功清单 revision/hash。
- 每份简历 ID 对应的内容哈希和删除状态。
- 活动简历 ID。

基线与 Resume Store 的应用必须保持原子提交，避免页面刷新后出现简历状态与同步基线不一致。

## 异常与安全

- 简历文件上传失败：不更新清单。
- 下载文件缺失：停止应用该条目并重新读取清单，区分并发移动和损坏状态。
- 内容哈希不一致：不写入本地，提示远端文件被修改或损坏。
- Manifest 校验失败：停止同步，不覆盖远端。
- ETag/CAS 冲突：重新规划，达到有限重试次数后返回可重试错误。
- WebDAV `DELETE` 的非 2xx 响应必须作为安全错误返回；仅普通 repository 临时文件清理可显式捕获并 best-effort。manifest 不确定 `MOVE` 的源撤销必须使用该临时源上传后 ETag 的 `If-Match`，且必须观察结果；首次同步 destination 回滚也使用带 `If-Match` 的条件删除。
- 远端缺少可靠条件请求支持：延续现有 fail-closed 策略，不执行可能覆盖并发数据的写入。
- 错误状态只保存安全 `code/status`；不得包含凭据、完整 URL 查询、响应正文或简历内容。
- WebDAV 必须使用 HTTPS，localhost 开发例外沿用现有规则。

## 设置界面

沿用现有 WebDAV 设置卡片，只补充必要状态：

- 显示“共同步 N 份简历”。
- 显示最近成功同步时间。
- 说明远端使用“每份简历一个 JSON”。
- 冲突对话框显示目标简历标题。
- “清除凭据”只清除浏览器中的连接设置，不删除 WebDAV 文件。

不增加目录浏览、垃圾箱恢复或高级协议选项。

## 测试策略

### Codec

- WebDAV 单简历 JSON 与手动导出数据深度一致。
- JSON 可被现有导入入口接受。
- 字段、格式化、哈希稳定。
- 无效 ResumeData、未知字段策略和结构损坏被正确拒绝。

### 文件名

- 中文、英文、空标题、特殊字符、长标题、重名标题。
- 标题修改时生成确定的新路径。
- 完整 ID 不依赖短 ID 识别。

### Manifest

- 严格 schema 和哈希验证。
- 路径穿越、绝对路径、重复路径、无效活动 ID 被拒绝。
- 删除条目和垃圾箱路径校验。

### Planner

- 新增、修改、下载、重命名、删除和恢复候选。
- 不同简历并发修改自动合并。
- 同一简历双向修改冲突。
- 删除与修改冲突。
- 相同最终哈希去冲突。

### Executor 与协议

- 临时上传、条件 MOVE、ETag CAS。
- 简历操作成功后才发布清单。
- 上传中断、文件缺失、MOVE 失败、清单 CAS 失败和有限重试。
- 孤儿文件识别，不重复导入。
- `trash/` 文件不自动恢复。

### Store、Controller 与 UI

- 本地数据与基线原子提交。
- 自动同步 single-flight、dirty follow-up、离线和可见性恢复。
- 简历级冲突选择仅影响目标简历。
- 真实 DOM 验证同步数量、提示文案和冲突标题。
- 保留并更新现有 WebDAV 回归测试，生产构建必须通过。

## 发布与兼容

- 本次协议直接以空远端为前提创建 schema v2，不读取或迁移旧 `magic-resume.json`。
- 现有 WebDAV 设置字段、凭据存储方式和默认根目录保持不变。
- 发布前运行 WebDAV 专项测试、相关既有测试、生产构建和 `git diff --check`。
- Cloudflare Worker 部署后验证首页、设置页与至少一次真实 WebDAV 测试连接。

## 验收标准

- WebDAV 中每份简历都是可直接下载并通过网站导入的独立 JSON。
- 文件名为“安全标题--短 ID.json”。
- 删除简历移动到 `trash/`，不会被其他设备自动恢复。
- 修改一份简历不会上传其他未变化简历。
- 不同简历的并发修改自动合并；同一简历的真实冲突提示用户选择。
- 任何失败都不会发布引用缺失或未验证文件的清单。
- 现有安全边界、原子性和隐私保护不退化。

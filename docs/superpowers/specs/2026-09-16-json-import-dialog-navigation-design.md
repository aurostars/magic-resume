# JSON 导入弹窗与导航解耦设计

## 背景

旧版魔方简历导出的 JSON 在当前妙笔生产环境中可以成功解析并写入 Store，但导入完成后页面进入错误边界：

```text
Cannot read properties of null (reading 'style')
```

用户提供的旧版文件结构有效，唯一的 `null` 是允许存在的 `draggingProjectId`。同一文件在本地开发环境可正常导入。

## 根因

当前导入成功回调在同一事件周期内依次执行：

1. 写入新简历；
2. 关闭 Radix Dialog；
3. 立即导航到工作台。

妙笔容器在 Dialog 与 scroll-lock effect 完成清理前替换当前文档。第三方清理逻辑随后访问已失效文档的 `ownerDocument.body.style` 和属性，触发 `body === null` 异常。JSON 内容只负责触发成功导入路径，不是错误数据源。

## 目标

- 兼容旧版与当前版本导出的合法简历 JSON。
- 导入成功后先完整卸载弹窗，再导航到新简历工作台。
- 每次成功导入只导航一次。
- 不使用固定毫秒延迟，不依赖妙笔宿主内部实现。
- 不修改 JSON schema、简历内容或其他弹窗行为。

## 方案

在 `ResumeWorkbench` 中增加待导航简历 ID 状态：

1. 导入函数继续解析文件、生成新 ID 并写入 Store。
2. 导入成功后记录待导航 ID，然后关闭导入弹窗；不在回调中直接调用 router。
3. React effect 监听弹窗关闭状态和待导航 ID。
4. 只有在弹窗状态已关闭、Dialog 子树已完成卸载后，才投递一个不依赖页面可见性的异步任务来消费待导航 ID 并导航。
5. 导航前先清空待导航 ID，防止重渲染、Strict Mode 或 effect 重入造成重复导航。

该方案以 React 生命周期作为 Dialog 卸载边界，并使用可取消的 `MessageChannel` 零延迟任务作为异步边界；不使用 `requestAnimationFrame`，因为妙笔生产页面可能处于 `document.visibilityState === "hidden"`，浏览器会暂停 RAF，导致已调度的导航无限期不执行。缺少 `MessageChannel` 时使用带 cancelled token 的微任务降级。方案不采用固定毫秒 `setTimeout`，也不升级或替换全局 Dialog 依赖。

## 错误处理

- JSON 解析或导入失败时保持现有错误提示，不记录待导航 ID。
- 组件在导航前卸载时，不执行额外导航。
- 连续导入由现有弹窗交互串行化；待导航状态只保存一次导入结果。

## 测试

增加真实 UI 行为回归测试：

- 使用用户提供文件的结构特征构造脱敏 fixture。
- 成功导入时，在弹窗仍打开的提交阶段不得调用 router。
- 弹窗关闭并卸载后恰好导航一次，目标 ID 等于新建简历 ID。
- 导入后的简历结构和关键字段保持不变。
- 非法 JSON 继续走现有错误分支且不导航。
- 运行相关 JSON 导入、Resume Store、前端生产契约及妙笔构建测试。

## 生产验收

发布后通过 AIME 本地浏览器在妙笔生产页面导入脱敏旧版 fixture，确认：

- 不出现 `style` / `getAttribute` 空引用错误；
- 不进入错误边界；
- 成功进入对应简历工作台；
- 简历可正常预览；
- 清理验收过程中创建的测试简历和浏览器测试数据。

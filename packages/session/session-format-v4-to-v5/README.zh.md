---
description: "在不更改事件或继承前缀的情况下，将受支持的 V4 Session 日志迁移到 V5 写入格式。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 摘要

当当前写入方新增 `max-steps` 轮次结束原因时，使用此库将 V4 Session 日志迁移到 V5。此相邻迁移只更改头部版本，并保留每个事件和继承前缀。V5 沿用 V4 的物理行编码。完整恢复请使用 Session 格式目录；本包不负责读取或发布文件。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 适用场景

静态 Session 格式目录在 V5 写入方读取已存 V4 Session 时使用此库。调用方使用该目录，不自行组装迁移边。

### 入口

目录构建器使用 `sessionFormatV4ToV5` 取得相邻的头部和正文迁移。直接调用头部转换器不会恢复事件正文：

```ts
const v5Header = sessionFormatV4ToV5.migrateHeader(v4Header)
```

`restoreReleasedV5Artifact(artifact, knownEventTypes)` 会验证完整 V5 产物并返回同一对象。无效头部、事件关系或未知且不可忽略的事件类型会导致恢复失败；发布由持久化后端负责。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

V5 编解码器沿用 V4 的物理行表示并验证 V5 头部。相邻正文阶段原样转发标量事件和紧凑运行，保留继承截点。V5 新增 `turn/end.reason.kind: 'max-steps'`；已有 V4 原因和消息来源元数据保留其记录值。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session 格式目录](../session-format-catalog/README.zh.md)——完整历史恢复和当前写入编解码器。
- [Session 格式版本迁移指南](../../../docs/cookbook/adding-a-session-format-version.zh.md)——版本变更与不可变 generation。
- [Session 格式状态](../../../docs/session-format-status.zh.md)——写入方、接受基线和发布记录。
- [V3 到 V4 迁移边](../session-format-v3-to-v4/README.zh.md)——前序编解码器与迁移。

-----

<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型看到什么

V4 到 V5 迁移会保留模型消息。新增的 `turn/end.reason.kind: 'max-steps'` 属于审计元数据，不会增加提示词内容。

#### Token 效果

迁移不更改模型消息或带 Token 的字段。

#### KV Cache 效果

迁移保留记录的请求前缀。

## 已知限制和待办工作

<a id="known-limitations-and-deferred-work"></a>

- **不支持降级**——V5 generation 不会改写或作为 V4 打开；较早的 generation 保持不变。
- **V4 源覆盖范围**——不支持的物理行仍由 V4 编解码器拒绝，且不会发布部分 V5 generation。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

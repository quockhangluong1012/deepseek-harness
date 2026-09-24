---
description: "把任务内的研究证据与主张写入会话日志，并记录来源引用、信任标签与证据关联状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-evidence

[English](README.md) | 中文

## 概述

通过任务的持久会话日志记录研究观察与主张。`record_evidence` 保存来源引用与可选摘要；`record_claim` 引用同一会话中已记录的证据。两个工具都要求当前任务已挂载 Kernel，`maxTextChars` 会限制写入文本长度。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件挂在 `tools` 旁；它注册两个面向模型的工具，并在调用时通过 `agentKernel` 写入记录。

### 何时选择它

当研究任务需要持久、可追溯的观察与主张，而非只留在对话记录中的结论时选择它。若调用方没有由 Kernel 管理的任务契约，则不要使用。

### 最小配置

在 `cordis.yml` 组合中挂载插件：

```yaml
- name: '@deepseek-ai/dsh-tool-evidence'
  config:
    maxTextChars: 2000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTextChars` | `2000` | 记录内容引用、摘要或主张陈述时允许的最大 UTF-16 字符数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-evidence)列出所有可接受字段。缺少 `agentKernel` 或调用方任务时，每次工具调用都会失败，而不是丢弃记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具在参数边界校验模型输入、限制所记录文本的长度，并调用 Kernel 的任务级记录方法。Kernel 会拒绝引用本会话未记录证据的主张，并追加 `evidence/recorded` 或 `claim/updated`；证据只保存位置与可选摘要，不复制观察内容。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件配置、工具 schema，以及调用 Kernel 的逻辑 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent kernel](../agent-kernel/README.zh.md) — 任务级证据与主张、信任标签及持久事件账本。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-evidence) — 模型可见的精确 schema 与描述。

-----

<a id="model-experience"></a>
## 模型体验

### 证据与主张工具

#### 模型看到什么

模型会看到[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-evidence)中生成的 `record_evidence` 与 `record_claim` schema。证据工具记录来源类型与 `contentRef`，并可带 `digest` 与 `trust`；主张工具记录陈述与置信度，并可带 `evidenceIds` 与状态。工具描述会说明何时记录，并指出没有证据的主张仍只是提议。

#### Token 影响

只要工具可见，两个 schema 就会加入请求。调用会返回所记录的标识及受长度限制的位置或陈述；插件不添加提示文本。

#### KV Cache 影响

只要工具定义与可见性不变，schema 就保持请求前缀稳定。插件生命周期或工具限制可能改变这组 schema。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **引用不会保存内容。** 日志记录位置与可选摘要；供后续复查的文件、结果或 URL 仍须可访问。
- **信任只是元数据，不是权威。** 模型提供的信任标签或摘要不能证明内容为真，也不能授予能力。
- **主张只属于当前会话。** 主张只能引用本任务会话记录的证据；跨会话晋升由单独的准入流程负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

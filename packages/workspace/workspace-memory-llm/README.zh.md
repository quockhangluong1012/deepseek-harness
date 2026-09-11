---
description: "Workspace memory derivation: per-turn output indexing, gated extraction, and on-demand rebuild (ctx.workspaceMemoryExtractor)."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-memory-llm

[English](README.md) | 中文

## 概述

`dsh-workspace-memory-llm` 派生模型维护的记忆文档。每个完成的轮次都会索引产出的文件；满足门控条件的轮次会依据该轮次 transcript 重写整份文档；页面的重新生成控件依据会话历史重建。提取是确定性的（`temperature: 0`，通过 `purpose: 'workspace-memory'` 关闭推理），并且永远不会作为会话错误暴露。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在存储旁挂载本插件。产出索引始终运行；`autoExtract: false` 只为重新生成控件付费。

```yaml
- name: '@deepseek-ai/dsh-workspace-memory-llm'
  config:
    autoExtract: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `autoExtract` | `true` | 完成的轮次是否触发提取；产出索引始终运行 |
| `minTurnTextBytes` | `200` | 跳过琐碎轮次的提取 |
| `cooldownMs` | `60000` | 同一 Workspace 两次提取之间的最小间隔 |
| `maxInputBytes` | `131072` | 每次调用的 transcript 预算 |
| `maxOutputTokens` | `1024` | 输出上限 |
| `timeoutMs` | `60000` | 调用截止时间 |
| `rebuildSessionLimit` | `20` | 一次重建扫描的会话数 |
| `outputTools` | `write`、`edit`、`str_replace_editor` | 哪些成功调用算作产出 |
| `provider` / `model` | 未设置 | 路由覆盖；两者同时给出或都不给出，只给一个会导致插件加载失败 |

transcript 只接纳人类 `user/message` 与 `assistant/message`。路由优先级为配置的 provider 与 model 组合，否则使用会话最后记录的 `request/header` 路由。没有路由的重建以 `workspace-memory/extraction-failed` 拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

未发布不变式伴随包，因为派生除所写入的存储外不持有持久状态。

### 设计理念

对活动会话事件做一次反向扫描、直到最近的 `turn/start`，即可驱动产出索引与提取。工作被排入按 `WorkspaceId` 的 promise 链，因此一个 Workspace 不会同时运行两次提取，轮次也不会被阻塞。销毁会中止所有进行中的提取；`session/disposed` 会中止绑定到该会话的那次提取。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：轮次监听、产出索引、门控提取、重建 |
| [`src/prompt.ts`](src/prompt.ts) | 系统提示词、JSON 框架化、UTF-8 截断辅助函数 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace Memory 规范](../../../specs/workspace-memory.md)——本包实现的行为约定。
- [Workspace 包地图](../README.zh.md)——本组的包及其仓库位置。

-----

<a id="model-experience"></a>
## 模型体验

### 记忆提取调用

#### 模型看到的内容

一次确定性的派生请求，包含 JSON 框架化的 `{ role, text }` 行与当前文档。模型只在 `## Purpose`、`## Preferences`、`## Decisions`、`## References` 标题下返回替换文档。

#### Token 影响

输入受 `maxInputBytes` 限制，输出受 `maxOutputTokens` 限制。`max-tokens` 结束原因会被容忍，并置 `truncated: true`。

#### KV Cache 影响

与实时请求无关：该辅助调用运行在对话请求前缀之外。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了派生在何种情况下不适合使用。它们是本包当前的约束。

- **提取需要路由**——从未发出模型请求的会话没有可复用的路由，因此除非该行指定 provider 与 model，其轮次不会产生记忆。
- **记忆是单一文档**——没有按条目的来源记录、按条目的删除或记忆历史。
- **产出由工具派生**——由 shell 命令写入的文件，或由配置集合之外的工具写入的文件，不会被索引。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

---
description: "库辅助函数：在 Workspace 中创建、挂接、命名并启动一个根会话，由发布 Workspace 会话的各生产者共用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-session

[English](README.md) | 中文

## 概述

`dsh-workspace-session` 只导出一个函数，把生产者的决定——这个工作区、这个标题、这个组合、这条首条消息——变成活着的根会话：它解析 preset、创建 Workspace、创建 Agent、挂接会话、应用权限 preset、设置标题并投递消息，任一步失败就整体回滚。webhook 规则与定时 routine 都调用它，因此先后顺序与回滚规则只有一处。它自身不注册任何工具、提示词或会话事件。

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

从发布无人值守会话的插件调用 `startWorkspaceSession`——webhook 规则、定时 routine，或同类的新生产者。它是库而不是被挂载的插件：不拥有服务，也不需要 `cordis.yml` 行。

```ts
await startWorkspaceSession(ctx, {
  workspacePath: '/srv/projects/app',
  sessionId: brandString<SessionId>(`routine-${randomUUID()}`),
  title: 'Nightly sweep',
  agentPreset: 'standard',
  permissionPreset: 'workspace-write',
  modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  owner: 'schedule-routines',
}, createUserMessage({ content: [{ type: 'text', text: 'Sweep the tree.' }], source: { kind: 'routine', /* … */ } }), signal)
```

消息被投递即视为调用完成。此后所有权结束：Agent 的生命周期属于创建它的 context，调用方无需再安排其他事宜。

### 调用方必须提供的内容

| 输入 | 为何由调用方拥有 |
|---|---|
| `workspacePath` | 会话属于哪个项目由生产者决定；路径必须是绝对路径 |
| `sessionId` | 生产者的身份前缀让会话可追溯到来源（`webhook-…`、`routine-…`） |
| `title` | 在任何模型调用存在之前，生产者就知道该会话是关于什么的 |
| `agentPreset`、`permissionPreset` | 组合与权限是生产者的策略，在任何创建动作之前解析并校验 |
| `modelSelection`、`agentOptions` | 创建时的模型，使会话的首次请求不依赖之后的设置变更 |
| `message` | 首条消息承载的持久来源类型归生产者所有 |
| `owner` | 在回滚警告中点名生产者 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计

- **有真实回滚的有序创建。** 先解析 preset（名字写错在任何副作用之前就失败），再创建 Workspace、Agent，然后挂接；挂接之后的失败会解除 Workspace 挂接并释放 Agent，每个回滚失败都会被单独报告，且不会替换原始错误。
- **创建时的模型会一直固定到请求 header 存在为止。** `agent/request` 上的监听器只在会话尚无持久请求 header 时改写解析出的选择，因此首次请求使用生产者所要求的内容，之后的轮次遵循常规解析。
- **所有生产者共用一份实现。** webhook 路径与 routine 路径只在身份前缀、标题、组合与消息来源上不同；这些是参数，而不是创建序列的第二份副本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `startWorkspaceSession` 与模型选择固定逻辑 |
| — | 不发布运行时不变式伴生入口；该辅助函数的效果就是创建事务本身，其失败顺序由各生产者的测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace 注册表](../workspace/README.zh.md)——创建出的会话所挂接的实体。
- [Webhook](../../webhook/webhook/README.zh.md)——调用本辅助函数的生产者之一，以及它自己负责的规则结果校验。
- [定时 routine](../../schedule/schedule-routines/README.zh.md)——另一个随附的生产者。

-----

<a id="model-experience"></a>
## 模型体验

### 会话创建输入

#### 模型看到的内容

它自身没有贡献。该辅助函数不贡献提示词、工具或 schema：唯一的模型可见效果是调用方的 `user/message`，它作为新会话的首条用户消息、以调用方的持久来源类型投递。标题、权限 preset 与模型固定都是会话设置，不是请求内容。

#### Token 影响

零。`startWorkspaceSession` 不组装任何请求；它投递的消息及之后的轮次属于调用方与新会话的常规成本。

#### KV Cache 影响

无影响。新会话以空的可复用前缀开始，因此不会使任何缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该辅助函数刻意不做的事。它们是当前包约束，不是任务积压。

- **只创建根会话**——该辅助函数创建一个顶层会话；fork、subagent 与父子挂接属于各自的服务。
- **创建后不保留所有权**——需要观察、重试或清理自己所启动会话的调用方必须自行处理；本辅助函数的事务在投递时结束。
- **只固定创建时的模型**——该选择在首个持久请求 header 之前有效；此后需要不同策略的调用方必须自行安装监听器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

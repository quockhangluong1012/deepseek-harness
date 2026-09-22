---
description: "Workspace memory brief injector rendering Instructions, Memory, and Context into agent pre-step."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-memory-context

[English](README.md) | 中文

## 概述

`dsh-workspace-memory-context` 注入一条承载 Workspace brief 的持久 `user/message`：Workspace 标题与目录、用户编写的指令、模型维护的记忆文档，以及附加的上下文条目。对任何 Workspace 之外的会话它不发出内容，当指令、记忆与上下文全为空时也不发出内容。当目录中每个会话都应继承共享知识时，选择本包。

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

在存储旁挂载本插件。部署方必须选定一个 Workspace 每次请求可承担的成本。

```yaml
- name: '@deepseek-ai/dsh-workspace-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-workspace-memory-context'
  config:
    maxBytes: 16384
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | 含框架在内的完整注入 brief 上限 |

在每个符合条件的 pre-step，注入器把记录的摘要与最新的可见 `workspace-memory` 消息比较，先扫描本次声明的批次，再逆序扫描会话界面。摘要相同则不添加任何内容；摘要不同或缺失则追加恰好一条完整的新 brief。该消息携带来源 `{ kind: 'workspace-memory', form: 'instructions', workspaceId, digest }`，因此回放与去重都是精确的。

### 预算与安全

含框架在内的完整产出文本绝不超过 `maxBytes`。压力之下先丢弃末尾的上下文条目，再截断记忆，最后截断指令，并追加一行通知说明丢弃或截断的内容。每个由工作区编写的字符串都会把字面量 `</system-reminder>` 改写为 `<\/system-reminder>`。缺失或不可读的文件条目渲染为 `Context "<label>" is unavailable (<path>).`，步骤照常继续。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计理念

brief 是由 `agent/pre-step` 贡献追加的一条持久 `user/message`，因此可回放、可压缩，并可从会话日志重建。不引入新的会话事件类型。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：成员资格解析、摘要比较、文件物化、pre-step 监听器 |
| [`src/render.ts`](src/render.ts) | 纯 brief 渲染、预算丢弃顺序、框架转义、UTF-8 截断 |

未发布不变式伴随包，因为本插件不持有可与第二个观测核对的持久状态。

### 成员资格

成员资格由 Workspace 记录的 `sessionIds` 解析，回退为对会话 `cwd` 的规范路径匹配。解析结果按会话 id 缓存，并在 `session/disposed` 时失效。任何 Workspace 之外的会话得不到任何内容。监听器不前置，因此它观察的是最终声明的批次，并且会展开决策，使 `startsRequestSeries` 得以保留。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace Memory 子系统](../../../docs/subsystems/workspace-memory.zh.md)——本包实现的行为约定。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-workspace-memory-context)——每个受支持的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### Workspace memory brief

#### 模型看到的内容

每个会话一条以 `<system-reminder>` 为框架的消息，变化时被替换。空小节会被省略；当指令、记忆与上下文全为空时，不发出任何消息。

##### 逐字 brief 框架

```markdown
<system-reminder>
# Workspace memory: <workspace title>
Directory: <canonical path>

## Instructions
<instructions>

## Memory
<memory>

## Context: <label>
<materialized content>
</system-reminder>
```

#### Token 影响

每个会话一条 brief，变化时用一条完整的新消息替换。记录未变化时不添加第二条消息。

#### KV Cache 影响

仅追加；新可见的内容排在可复用的请求前缀之后。替换 brief 会改变其后的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了 brief 在何种情况下不适合使用。它们是本包当前的约束。

- **仅限 Web**——Workspace 只存在于 web 组合中，因此其他 profile 永远不会携带 brief。
- **同一时间只有一条 brief**——变化会追加一条完整的新消息而非差量，因此多次编辑会累积被取代的 brief。
- **文件上下文按请求读取**——较大的附加文件在每次 brief 刷新时都会重新读取；预算约束的是到达模型的内容，而不是读取量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

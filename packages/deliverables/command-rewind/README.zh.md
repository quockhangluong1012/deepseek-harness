---
description: "面向用户与维护者的 /rewind 斜杠命令说明：把工作目录代码恢复为某轮起始时的内容，而不编辑对话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-rewind

[English](README.md) | 中文

## 概述

`dsh-command-rewind` 为用户提供 `/rewind` 命令：它定位一个数字所指名的轮次，并通过 [`dsh-workspace-changes`](../workspace-changes/README.zh.md) 的 `restore()`，把自该轮起始以来改动的每个文件恢复为那一刻的内容。这是“回退到某轮”（§31.1 D3）的代码那一半——对话那一半是既有的 Session “Branch” 动作；把两者合并为一个动作仍是 Client UI 工作。在同时挂载了 `dsh-workspace-changes` 的交互式部署中使用本包；交付的 Web 组合包两者都挂载。

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

### 命令参考

| 输入 | 结果 |
|---|---|
| `/rewind <turn>` | 把工作目录文件恢复为 `<turn>` 起始时的内容 |
| `/rewind --help` | 显示用法，不做任何恢复 |
| `/rewind`（无参数）、非数字参数，或小于 `1` 的轮号 | 直接命令错误，指明期望的形式 |

轮号指的是发起调用的 agent（智能体）自己的会话——与改动文件卡片显示的编号相同。没有记录任何文件改动的轮次（不存在，或没有产生改动）会成为直接命令错误，而不是静默的空操作。

### 组合方式

该命令注入命令注册表与 workspace-changes 服务：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: workspace-changes
  name: '@deepseek-ai/dsh-workspace-changes'
- id: command-rewind
  name: '@deepseek-ai/dsh-command-rewind'
```

交付的 Web 组合包把这一行与 `workspace-changes` 并列挂载在 Host 层，而非按 agent preset 挂载——与它所调用的服务放在同一层。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令如何找到一个轮次并渲染结果；回退语义本身归属 [`dsh-workspace-changes` 自己的 README](../workspace-changes/README.zh.md#rewind)。

### 设计

- **轮号，而非事件序号。** 人类以编号指名一个轮次；命令扫描发起调用会话自己的日志，找到宣告该轮号的最低序号 `workspace/changes` 事件，把该事件的序号传给 `restore()`——与改动文件卡片查找某轮摘要所用的是同一套查找方式。
- **直接命令结果，绝非模型轮次。** 与 `/goal`、`/compact`、`/review` 一样，`/rewind` 在 UI 命令层执行；回退结果绝不会进入父 agent 自身的模型请求。
- **每个跳过项都会被报告，绝不静默丢弃。** 二进制文件、超大文件，或 `restore()` 无法写回的文件都会带着原因出现在渲染结果里，与每个已恢复的文件并列。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令注册、轮号到事件序号的查找、结果渲染 |
| — | 不发布运行时不变式伴生入口；本命令适配器不拥有任何事件序列或状态 projection——派发行为由包测试覆盖，回退操作自身的不变式归属 `dsh-workspace-changes`。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace changes](../workspace-changes/README.zh.md#rewind)——本命令调用的 `restore()` 方法及其完整回退语义。
- [命令服务](../../interaction/commands/README.zh.md)——命令注册表契约与派发方式。
- [产出物子系统](../../../docs/subsystems/deliverables.zh.md)——`WorkspaceChanges` 服务与 `WorkspaceRestoreResult` 词汇。

-----

<a id="model-experience"></a>
## 模型体验

### 人工 `/rewind` 控制

#### 模型看到什么

什么都看不到：斜杠输入、定位到的轮次与回退结果都不会出现在父 agent 的模型请求中。已恢复的文件只有在模型下次读取或编辑它们时才间接触及。

#### Token 影响

`/rewind` 不会给父级自身的模型请求增加任何 token。

#### KV Cache 影响

没有影响——该命令从不改变父级的请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该命令何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **交付应用中仅 Web 命令适配器可用**——headless、ACP 自动化与 JSON-RPC 适配器都不消费 `ctx.commands`，因此目前只能从 Web composer 触达 `/rewind`。
- **只回退代码，不涉及对话**——`/rewind` 从不触碰 Session 日志或模型上下文；若还要把对话也回退到该轮，需另外使用既有的“Branch”动作。合并为一个动作仍是延期的 Client UI 工作。
- **`restore()` 的每条约束都适用**——仅限 git、跳过二进制/超大文件，以及 `dsh-workspace-changes` 文档中的其他限制在此原样适用；本命令不额外增加任何约束。
- **没有模式选择器**——与目标设计中“仅代码、仅对话，或两者皆有”的选择不同，本命令在结构上就是仅代码；没有能同时分支对话的参数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。尚未决定：合并的代码与对话回退，以及在改动文件卡片旁新增 Desktop/Web UI 触发点，都是延期的 Client 工作，不涉及上文所述命令自身契约的变更。

</details>

---
description: "面向用户的 /rewind 斜杠命令：按显式指定的模式回到某个轮次——恢复工作目录中的代码、分支对话，或两者兼有——并可在取分支之前替换开启该轮的消息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-rewind

[English](README.md) | 中文

## 概述

`dsh-command-rewind` 为用户提供 `/rewind`：按模式回到某个轮次——`code` 把工作目录文件恢复为该轮起始时的内容，`conversation` 从紧接该轮之前的位置分支出新会话，`both` 先分支再恢复文件，`--edit <text>` 则在分支中用新文本替换开启该轮的消息。对话回退从不改写源对话——分支是一个新会话，源会话照常继续运行——但会多出一个会话，在被归档前一直留在会话列表里。请在同时挂载 `dsh-workspace-changes` 与 `dsh-api-session-controller` 的交互式部署中使用本包，随附的 Web 组合包正是如此。

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
| `/rewind code <turn>` | 把工作目录文件恢复为 `<turn>` 起始时的内容 |
| `/rewind conversation <turn>` | 从紧接 `<turn>` 之前分支会话，并从分支中丢弃开启该轮的消息及其后的每个轮次 |
| `/rewind both <turn>` | 先分支对话，再恢复文件 |
| `/rewind conversation <turn> --edit <text>` | 同上，并以 `<text>` 替换分支中开启 `<turn>` 的消息，把它发送到该分支 |
| `/rewind --help` | 显示用法与后果，不执行任何动作 |
| 缺少参数、参数未知或多出参数；`code` 搭配 `--edit`；`--edit` 为空 | 直接命令错误，指明期望的形式 |

模式始终必需，绝不推断：`/rewind 3` 会把 `3` 报告为未知模式，而不是自行假定一种。轮号指的是发起调用的 agent（智能体）自己的会话——与改动文件卡片显示的编号相同。

### 模式

- **`code`**——只作用于工作树。没有任何已记录文件改动的轮次，或记录中没有 git 快照的轮次，都会成为直接命令错误。
- **`conversation`**——只作用于对话；完全不动工作树。分支继承到具名轮次 `turn/start` 之前那个事件为止的全部事件，因此分支的历史终止于该轮开始之处。回退到开启该会话的轮次时没有更早的事件可切：分支此时继承开启事件本身，而 fork 机制会把那个仍未关闭的轮次以 `forked` 关闭。
- **`both`**——一次分支加一次文件恢复，按此顺序。两半各自报告结果；失败的那一半会在成功的那一半旁以 `Incomplete —` 标出。

无论具名轮次是否已完成，对话回退都能工作，包括仍在运行的轮次：分支只是前缀副本，源会话照常继续运行。

### 不可回退的内容

- **被替换掉的文件内容不会保留。** `restore()` 把具名轮次的轮次起始树与工作树的新快照做 diff，并直接写入结果。此次回退所替换的内容——未提交的编辑、被它删除的未跟踪文件、只存在于工作树中的内容——两个包都不会保存在任何地方，因此 `/rewind` 无法把它们找回来。只有 git 历史（在本命令之外提交或 stash 的内容）留有副本。命令自身的输出在恢复任何东西后会重申这一点。
- **对话回退不是破坏性操作。** 它从不改变源会话：历史、队列与待处理工作完全保持原样，只追加 `command/run` 与 `command/done` 两条生命周期记录。代价反而是多出一个会话：分支留在会话列表中，直到被归档或删除，而替换消息发送到分支，绝不发送到源会话。
- **两半之间没有事务性。** 在 `both` 模式下，取到分支之后发生的失败会让该分支留在原处；输出会点名这次失败，而不是把它藏起来。

### 组合方式

该命令注入命令注册表、workspace-changes 服务，以及它取 fork 的 Session Controller：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: workspace-changes
  name: '@deepseek-ai/dsh-workspace-changes'
- id: session-controller
  name: '@deepseek-ai/dsh-api-session-controller'
- id: command-rewind
  name: '@deepseek-ai/dsh-command-rewind'
```

交付的 Web 组合包在 Host 层把这一行与 `workspace-changes`、`session-controller` 并列挂载，而非按 agent preset 挂载——与它所调用的服务放在同一层。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令如何找到一个轮次并渲染结果；回退语义本身归属 [`dsh-workspace-changes` 自己的 README](../workspace-changes/README.zh.md#rewind)，分支则归属 Session Controller。

### 设计

- **用轮号，而非事件序号。** 人类以编号指名一个轮次；命令扫描发起调用会话自己的日志，找到宣告该轮号的最低序号 `workspace/changes` 事件，把该事件的序号传给 `restore()`——与改动文件卡片查找某轮摘要所用的是同一套查找方式。对话这一半则解析具名轮次的 `turn/start` 事件，并在它之前切掉一个事件。
- **所有前置条件都在任何动作之前解析完毕。** 模式、轮次与替换文本都被严格解析；该轮的宣告事件与它的 `turn/start` 都被定位；此后命令才分支并恢复。被拒绝的调用不可能只恢复一半文件，也不会留下一个分支。
- **分支先于文件执行。** 分支是非破坏性的一半，因此失败的恢复之前绝不会已有写入；分支失败也绝不会阻止所请求的文件恢复。
- **对话这一半用的是既有分支机制。** `ctx.sessionController.fork()` 负责取分支：它按精确的事件前缀构建 seed，创建带 `parentSession` 的子会话，并把它挂接到源会话的 workspace。命令自己从不编辑日志，也从不另开第二条历史路径。
- **替换消息走准入，而非注入。** 使用 `--edit` 时，命令把替换文本作为分支的下一条提示词，经 `ctx.sessionController.prompt()` 发送，因此它以一条普通的、由循环领取的已记录 `user/message` 落地；模型可见文本与日志在构造上一致。该提示词携带命令生成的 request id。原消息在源日志中不受影响，而完整的输入行由 `command/run` 记录，因此即使分支的提示词失败，替换内容依然可以从日志重建。
- **直接命令结果，绝非模型轮次。** 与 `/goal`、`/compact`、`/review` 一样，`/rewind` 在 UI 命令层执行；结果绝不会进入父 agent 自身的模型请求。
- **每个跳过项都会被报告，绝不静默丢弃。** 二进制文件、超大文件，或 `restore()` 无法写回的文件都会带着原因出现在渲染结果里，与每个已恢复的文件并列。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令注册、输入解析、轮号到事件序号的查找、分支与恢复的编排、结果渲染 |
| — | 不发布运行时不变式伴生入口；本命令适配器不拥有任何事件序列或状态 projection——派发行为由包测试覆盖，回退操作自身的不变式归属 `dsh-workspace-changes`，而分支归属 `dsh-api-session-controller`。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace changes](../workspace-changes/README.zh.md#rewind)——本命令代码半调用的 `restore()` 方法及其完整回退语义。
- [Sessions](../../../docs/subsystems/session.zh.md)——追加式日志、fork 边界与 `buildForkSeed`。
- [Web Chat 轮次尾部](../../client/ui-chat/README.zh.md)——分派本命令的原地回退对话框。
- [命令服务](../../interaction/commands/README.zh.md)——命令注册表契约与派发方式。
- [产出物子系统](../../../docs/subsystems/deliverables.zh.md)——`WorkspaceChanges` 服务与 `WorkspaceRestoreResult` 词汇。

-----

<a id="model-experience"></a>
## 模型体验

### 人工 `/rewind` 控制

#### 模型看到什么

代码这一半与父对话自身都不贡献任何可见内容：斜杠输入、定位到的轮次、分支与文件结果都不会出现在父 agent 的模型请求中。有两条记录留在父会话日志里而不进它的可见面：`command/run`（完整输入行，含任何 `--edit` 文本）与 `command/done`（结果），两者都只写日志。已恢复的文件只有在模型下次读取或编辑它们时才间接触及模型。来自 `--edit` 的替换消息则*在分支中*对模型可见：分支继承到具名轮次之前那个事件为止的前缀，该替换消息作为一条普通 `user/message` 进入，由分支的循环领取并据以推演历史——父对话中永远不含它。

#### Token 影响

`/rewind` 不会给父级自身的模型请求增加任何 token。带 `--edit` 的分支会开启一个新会话，其首个请求会重新读取继承来的前缀；这份成本属于分支，而不属于运行该命令的会话。

#### KV Cache 影响

对父级没有影响——该命令从不改变父级的请求前缀。分支是一个独立会话，拥有自己的请求序列，因此它从继承来的历史自行构建缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该命令何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **交付应用中仅 Web 命令适配器可用**——headless、ACP 自动化与 JSON-RPC 适配器都不消费 `ctx.commands`，因此目前只能从 Web composer 与 Web Chat 的轮次尾部对话框触达 `/rewind`。
- **宿主必须挂载 Session Controller**——没有 `ctx.sessionController` 时对话这一半不可用，且本包在缺少它时不会注册。
- **分支通过会话列表抵达**——命令在其文本中返回分支 id；composer 的对话框不会为你打开它，这与对话内的分支动作不同。切换到它是侧边栏里的选择操作。
- **开启会话的轮次没有干净的对话切点**——分支会继承开启用的 `turn/start` 事件，而 fork 机制把该轮次以 `forked` 关闭，因此分支会在替换消息之前显示一个空轮次。更晚的轮次可以干净地切割。
- **`--edit` 需要一条可服务的模型路由**——替换消息经普通提示词路径准入，因此当部署对源会话所选提供方没有适配器时这一半会失败（分支本身已经取到，输出会说明这一点）。附件不能成为替换内容的一部分：`--edit` 只接受文本。
- **`--edit` 的文本一直延伸到行尾**——没有引号或转义；若替换文本中含有字面量 ` --edit `，第一个出现位置之后的内容都会被保留。
- **`restore()` 的每条约束都适用**——仅限 git、跳过二进制/超大文件，以及 `dsh-workspace-changes` 文档中的其他限制在此原样适用；本命令不额外增加任何约束。
- **文件恢复不受沙箱限制**——它是由人发起的 Host 动作，与 `dsh-workspace-changes` 为 `restore()` 记录的信任边界相同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。尚未决定：一旦 headless 与 ACP 适配器消费 `ctx.commands`，对话回退是否也应在其中提供，以及分派该命令的 Web 对话框是否应自动选中分支。

</details>

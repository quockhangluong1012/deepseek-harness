---
description: "在 harness 运行期间按固定节奏启动新的、挂在 Workspace 上的会话的定时 routine，由人类 /routine 命令管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule-routines

[English](README.md) | 中文

## 概述

`dsh-schedule-routines` 存储 routine——一份保存下来的提示词、一个工作区与一个固定节奏——并在每次到期时启动一个全新会话，因此无人值守的请求会带着自己的标题与历史运行，而不会打断用户正在做的事。routine 保存在一份持久文档中，各自沿用自己的 preset 与权限范围，并通过 `/routine` 命令管理。它们仅在本进程运行期间触发：停机期间错过的到期时刻会被跳过，而不会补跑。

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

在运行无人值守工作的 Host 上挂载 `dsh-schedule-routines`——随附的 Web bundle（因而 Desktop 应用）已经这样做——并让用户用 `/routine` 创建 routine。它需要 Workspace 注册表、存储 domain、agent／preset／权限／标题服务以及命令注册表。

### 命令参考

| 输入 | 结果 |
|---|---|
| `/routine` 或 `/routine list` | 以 `- <id> every <minutes>m: <title> (<next instant>\|paused)` 列出所有已存 routine；没有时返回 `No routines.` |
| `/routine add <minutes> <prompt>` | 在调用会话的工作目录中创建 routine，标题取自提示词，首次到期为一个节奏之后 |
| `/routine pause <id>` | 阻止该 routine 启动会话；其游标保持原位 |
| `/routine resume <id>` | 允许该 routine 重新启动会话 |
| `/routine remove <id>` | 删除 routine；它已启动的会话不受影响 |
| 其他任何输入 | `Usage: /routine \| /routine add <minutes> <prompt> \| /routine pause <id> \| /routine resume <id> \| /routine remove <id>` |

未知 id 报告 `No routine '<id>'.`；不受支持的节奏、相对工作区或空白提示词会报告各自的拒绝原因，绝不静默成功。

### 配置

routine 从本插件继承其组合方式，因此一个部署只需决定一次无人值守工作的组合。所有字段都可选。

```yaml
- id: schedule-routines
  name: '@deepseek-ai/dsh-schedule-routines'
  config:
    tickSeconds: 30
    agentPreset: standard
    permissionPreset: workspace-write
    maxRoutines: 25
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `tickSeconds` | `30` | 两次到期检查之间的秒数 |
| `agentPreset` | `'standard'` | 每个 routine 会话挂载的 agent 组合 |
| `permissionPreset` | `'workspace-write'` | routine 会话运行所用的沙箱与审批 preset |
| `maxRoutines` | `25` | 已存 routine 的上限 |

两个 preset 都在加载时解析，因此写错会让挂载失败，而不是产生永远无法启动可用会话的 routine。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-schedule-routines)是穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计

- **一份持久文档，而非会话事件。** routine 比任何会话都长寿，因此整份列表是 `workspace_routines` 存储 domain 上的一条原子记录。损坏时文档会被移开并从空开始，因为另一种选择——让启动失败——会让无人值守功能拖垮交互式产品。
- **启动会话复用共享创建路径。** `startWorkspaceSession` 解析 preset、创建 Workspace、创建 Agent、挂接会话、应用权限 preset、设置标题，并把 routine 的提示词作为一条带 `routine` 来源的普通用户消息投递。
- **停机被跳过，而非补跑。** 所有已启用的游标若已过期，会在计时器启动前移到下一个未来时刻；到期的 routine 会直接越过其游标与当前时刻之间的所有触发点。重启后的应用绝不会一次性打开一批积压会话。
- **启动失败仍然推进节奏。** routine 是日程表，不是重试队列：失败会被记录，游标继续前进，因此坏掉的 routine 不会让 tick 空转。
- **每个 routine 同时只启动一次。** 已在启动会话的 routine 会被下一次 tick 跳过，而不是排在自己身后。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `RoutineScheduler` 服务：持久列表、tick、到期判定、会话启动与 `/routine` 命令 |
| [`src/spec.ts`](src/spec.ts) | `workspace_routines` domain 声明及其状态 schema |
| [`src/types.ts`](src/types.ts) | routine 记录、创建入参与稳定的拒绝类型 |
| — | 不发布运行时不变式伴生入口；存储是单份文档，其自身 schema 在持久边界校验，且没有第二份观察可与之比对。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话本地提醒](../schedule/README.zh.md)——本包刻意不是的那个功能：那些消息只留在同一个会话里。
- [Workspace](../../workspace/workspace/README.zh.md)——每个 routine 会话挂接的项目注册表。
- [共享会话创建](../../workspace/workspace-session/README.zh.md)——routine 与 webhook 规则共用的创建路径。
- [存储 domain](../../storage/storage-domain/README.zh.md)——routine 列表背后的持久文档约定。
- [命令服务](../../interaction/commands/README.zh.md)——`/routine` 命令接入的命令注册表。

-----

<a id="model-experience"></a>
## 模型体验

### routine 提示词投递

#### 模型看到的内容

routine 的提示词作为新会话首条 `user/message` 的唯一内容，且该会话以空历史开始。该消息携带带标识符的 `routine` 来源，以及点名该 routine 的 `notice` 摘要，因此日志读者可以区分无人值守启动与手动输入。命令自身的输出绝不进入任何请求。

#### Token 影响

每次启动一条用户消息，内容恰为该 routine 的提示词加上常规消息框架。routine 提示词不会被加入创建它的会话，routine 的会话随后自行承担其常规轮次成本。

#### KV Cache 影响

对创建它的会话没有影响。新会话的首次请求没有可复用前缀，因此不会使任何缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明何时不该使用 routine。它们是当前包约束，不是任务积压。

- **进程必须处于运行状态**——routine 由进程内计时器触发；被托盘保活的 Desktop 应用会持续触发，而关闭的应用会跳过期间错过的每一个到期时刻。
- **仅支持固定节奏**——`everyMinutes` 从创建锚点重复；不解析「工作日 09:00」这类日历表达式，也未复用会话本地提醒包实现的本地时间规则。
- **每个 routine 一个工作区，创建后固定**——routine 的工作区路径不可编辑；支持的修改方式是删除并重新添加。
- **启动是即发即忘**——调度器不观察它启动的会话，因此提示词执行失败的 routine 不会被重试、汇总，除失败启动的日志警告外也不会被呈现。
- **尚无客户端界面**——随附的交互面是具备命令能力的客户端中的 `/routine` 与服务 API；没有专门的设置页、列表视图或徽标。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

---
description: "面向用户与维护者的 /cost 斜杠命令说明：按 agent 与 subagent 会话给出基于目录价的美元估算。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-cost

[English](README.md) | 中文

## 概述

`dsh-command-cost` 为用户提供 `/cost` 命令，按 harness 中已安装的 provider 目录价，为调用 agent 及其整棵 subagent 树中的每次计费尝试计价。每个会话单独占一行，因此做委派的 agent 能看出哪个子会话花了多少。模型没有已知价格的尝试会被计数并按 route 列出，而不会被当成免费。总额是基于目录价的估算，绝不作为账单记录。

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

在任何带有命令适配器、且希望看到花费的部署中挂载 `dsh-command-cost`；随附的 Web bundle 会把它挂在用量账本旁边。

### 命令参考

`/cost` 不接受参数。任何非空输入都会返回用法错误 `Usage: /cost`。

| 输入 | 结果 |
|---|---|
| `/cost` | 打印调用 agent 及所有可读取的 subagent 会话的美元估算总额，每个会话一行并按层级缩进，随后列出无法计价的 route |
| `/cost <任意内容>` | 返回 `Usage: /cost`，且不追加任何会话事件 |

### 读取报告

首行固定为 `Cost estimate in USD; provider catalog rates may differ from your invoice.`。随后 `Priced total: $…` 汇总整棵树中所有已计价尝试。接着每个会话各占一行，按其在 subagent 树中的深度缩进，并在有标签时使用该 subagent 的标签：`<label>: $… (<n> priced, <n> unknown)`。

当存在无法解析价格的尝试时，报告会追加 `Unknown-priced attempts: <n>`，并为每个不同 route 列出一行，形式为 `provider/model`；连 route 都缺失时记为 `unknown route`。当某个子会话完全无法读取时，追加 `Unreadable subagent sessions: <n>`。若整棵树都没有计费样本，则打印 `No billed usage samples are recorded for this session tree.`，而不是零总额。

金额固定保留八位小数，因此单次极便宜的请求不会四舍五入成 `$0.00000000`。

### 计入范围

一次尝试指 `assistant/attempt` 或 `assistant/message` 事件上的一个 provider 用量样本；其模型 route 取自该事件自身的消息，或取自它之前最后一个 `request/context`——与用量账本使用同一套词汇。每个会话从它自己拥有的第一个事件开始计数，因此从父会话 fork 出来的子会话只计入它新增的部分，绝不重复计入继承来的前缀。这正是整棵树总额不会重复计算 fork 的原因。

价格来自拥有该 route 的适配器所解析出的模型信息，包含 provider 的用量档位。没有已安装价格的 route 上的尝试计入 unknown；命令既不猜测，也绝不把未知模型当作免费。

### 最小配置

该命令没有配置字段。挂载它注入的四个服务的所有者，以及命令本身：

```yaml
- {name: '@deepseek-ai/dsh-llm'}
- {name: '@deepseek-ai/dsh-session-query'}
- {name: '@deepseek-ai/dsh-subagent'}
- {name: '@deepseek-ai/dsh-commands'}
- id: command-cost
  name: '@deepseek-ai/dsh-command-cost'
```

`dsh-usage-ledger` 是提供共享样本校验与计价算术的库依赖，不是被注入的服务；即使不挂载账本，该命令也能运行。无头、ACP 自动化与 JSON-RPC 应用不注册命令适配器，因此无法使用 `/cost`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计

- **对会话日志只读。** 命令不触碰会话状态，也不追加事件。它通过 `ctx.sessionQuery.readSession` 读取调用会话与每个后代会话，然后在每次调用时把已提交事件折叠成按会话汇总的结果。
- **树的形状来自 subagent 服务。** `ctx.subagents.listDescendants(rootId)` 提供每个后代会话的标签、深度与身份；诊断行与无法读取的会话只会被计数并报告，而不会中断报告。
- **每个 route 只查一次价格。** route 在每次调用中只解析一次并缓存，因此即便一棵会话树在同一模型上有数百次尝试，也只做一次模型信息查询。价格查询失败的 route 按 unknown 处理，而不是报错。
- **跳过继承来的事件。** 每个后代输入以该会话的 `inheritedEventCount` 作为起始偏移，因此 fork 来的历史只在拥有它的那个会话里计价一次。
- **unknown 是一等结果。** 无法归一化的样本、没有已知 route 的事件、以及目录中没有价格的 route，都会进入同一个 unknown 计数，并在输出中保持可见。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令注册、会话树遍历、计价折叠、报告渲染 |
| — | 不发布运行时不变式伴生入口；该命令只读取已提交状态，自身不拥有事件流或投影。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [用量账本](../usage-ledger/README.zh.md)——持久化计费用量账本，以及本命令复用的 `priceSample` 算术。
- [会话查询](../../session-query/session-query/README.zh.md)——返回会话日志快照的读取服务。
- [subagent](../../subagent/subagent/README.zh.md)——会话树构建所依据的后代列表。
- [命令服务](../../interaction/commands/README.zh.md)——命令注册表约定与分发。
- [LLM 服务](../../llm/llm/README.zh.md)——解析后的模型信息，包括本命令用于计价的 provider 成本元数据。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/cost` 观察

#### 模型看到的内容

没有内容。`/cost` 把报告打印到 UI 命令平面，报告不会进入模型请求：该命令不注册提示词区段、消息、工具或 schema，也不追加会话事件。免责声明、会话行与未知 route 列表只存在于适配器的直接输出中。

#### Token 影响

零。任何命令路径都不会组装请求或向请求添加内容；该调用只读取已提交事件，不调用模型。

#### KV Cache 影响

无影响。该命令不改变任何请求前缀，自身也不走任何模型 route。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明报告能告诉读者什么、不能告诉读者什么。它们是当前包约束，不是任务积压。

- **目录价而非账单价**——费率来自已安装的 provider 目录；provider 折扣、议定价格与非美元计费均未建模，打印出的总额只是估算。
- **只覆盖 subagent 服务仍然知晓的会话**——会话树由 `listDescendants` 加每个会话一次读取构建；日志无法读取的后代会计入 `Unreadable subagent sessions`，而不会被计价。
- **未知 route 只报告、不估算**——目录中缺失的模型，或无法归属 route 的事件，其花费按设计不计入总额。
- **没有历史、没有持久化**——每次调用都从日志重新计算；该命令不保存累计总额，也不提供时间范围或按日拆分，那些由用量账本及其仪表盘页签负责。
- **仅支持裸 `/cost`**——没有按 subagent 过滤、范围参数或货币选项；报告始终覆盖整棵树。
- **档位按本次计费输入样本判定**——档位依据该请求自身的计费输入 token 适用，符合 provider 自己的选择规则，而不是依据会话累计值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

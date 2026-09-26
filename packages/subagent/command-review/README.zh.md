---
description: "面向用户与维护者的 /review 与 /security-review 斜杠命令说明：让独立的审查者子 agent 对一份 diff 给出结构化发现，并由客户端审查面板渲染这些发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-review

[English](README.md) | 中文

## 概述

`dsh-command-review` 为用户提供两条审查命令：`/review` 与 `/security-review`。两者都会启动一个独立的审查者子 agent（智能体）——默认是没有父级对话的全新 `spawn` 子 agent，可选使用另一个模型——并把它对一份 diff 的结构化发现直接渲染到界面中。两条命令是同一套实现：spawn 路径、报告 schema、提示词构造与渲染都是共享的，区别只在问题本身。审查从不进入父级自身的模型请求——它像 `/goal` 一样是直接命令结果。在挂载了命令适配器的交互式部署中使用本包。

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

在挂载了命令适配器、并至少注册了一个 `ctx.subagents` 提供方的交互式部署中使用 `dsh-command-review`——交付的 base 组合（`spawn`）是参考实现。

### 命令参考

| 输入 | 结果 |
|---|---|
| `/review` | 审查未提交的工作区改动 |
| `/review <ref>` | 审查工作区与 `<ref>`（分支或提交）之间的 diff |
| `/review --help` | 显示用法，不启动审查者 |
| `/security-review` | 审查未提交的工作区改动中的安全缺陷 |
| `/security-review <ref>` | 审查工作区与 `<ref>` 之间的 diff 中的安全缺陷 |
| `/security-review --help` | 显示用法，不启动审查者 |

`/review` 报告它发现的每一项真实缺陷、安全问题或正确性风险。`/security-review` 只要求安全缺陷——注入、认证或授权被绕过、信任边界缺少校验、泄露的密钥、不安全的反序列化、路径穿越、服务端请求伪造、跨站脚本、不安全的加密或随机数、过于宽松的 CORS，以及不安全的默认值——并在每条发现中点明漏洞类别；样式、性能与一般正确性问题留给 `/review`。

两条命令都不自己计算 diff：它们告诉审查者子 agent 应运行哪个 `git diff` 调用，并让审查者用自己的工具读取 diff 及其所需的任何周边文件上下文。审查者从不做任何编辑——提示词要求它不要编辑，任务本身也不需要具备写入能力的工具。

### 发现

一次完成的审查渲染为审查者给出的一到两句摘要，随后是每条发现——文件、可选的行号或范围、一句话描述——按 `high`、`medium`、`low` 分组排列。没有发现时在摘要后打印 `No findings.`。未能完成的审查者（被取消、超预算、拒绝执行或模型/传输失败）或完成但未给出有效结构化报告的审查者，会成为一条直接命令错误，指名停止原因，若提供方给出了诊断文本也一并显示。

完成的审查还会被持久记录为仅写入日志的 `review/report` 事件，其中带有审查种类、diff 目标、摘要与全部发现。命令结果会引用该记录，因此客户端审查面板可以把同一份报告渲染为结构化界面，而纯文本仍是所有适配器都能显示的输出。

### 组合方式

该命令注入命令注册表与 subagent runtime；它至少需要一个已注册的 `ctx.subagents` 提供方作为委派对象：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: spawn
- id: command-review
  name: '@deepseek-ai/dsh-command-review'
  config:
    subagentProvider: spawn
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 审查委派给的 `ctx.subagents` 提供方名称 |
| `provider` | 继承父级 | 审查子 agent 的 LLM 提供方路由覆盖 |
| `model` | 继承父级 | 审查子 agent 的模型 id 覆盖 |

两条命令都运行在同一套已配置路由下：一个部署，一个审查后端。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-command-review)是每个受支持字段的穷尽式真源。交付的 base 组合包把这一行挂载到 `spawn` 提供方上——一个没有父级对话的全新子 agent，审查运行时对父级已讨论的内容一无所知，这与目标架构中独立审查者的设计相符（§10.6）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令如何构造审查者的任务并渲染其答案；可观察契约见[使用本包](#use-this-package)。

### 设计

- **一条 spawn 路径，两套提示词。** `src/reviewer.ts` 拥有审查者 seam：`runReviewer` 用任务的 label、提示词与输出 schema 启动所配置的提供方，等待运行结束，并且始终释放它；`reviewPrompt(kind, ref)` 依据共享的作用域与目标描述为每种审查构造问题。两条命令只是同一张变体表里的条目，携带身份、种类、描述与用法——绝不存在第二套提示词或第二次 spawn 调用。
- **审查者自行计算 diff。** 命令提示词只指名要运行的确切 `git diff` 调用，让审查者用自己的工具读取它，而不是预先计算 diff 文本并粘贴进提示词——审查者在需要时还能读取周边文件上下文，代价是审查者所在的组合需要具备 shell 与文件读取工具。
- **结构化输出，而非自由文本。** 审查者的最终轮次通过既有的 `SubagentStartRequest.outputSchema` 通道，对照同一份以 object 为根的 `outputSchema`（`summary: string`、`findings: { file, line?, severity, message }[]`）校验——与 `dsh-tool-subagent` 模型调用使用的是同一通道——因此渲染环节永远不需要解析散文。
- **直接命令结果，绝非模型轮次。** 与 `/goal`、`/compact` 一样，两条命令都在 UI 命令层执行；diff、审查者的工具调用及其发现从不进入父 agent 自身的模型请求。
- **报告是持久化的。** 完成的审查会作为仅写入日志的 `review/report` 事件追加，并由命令结果引用，因此结构化界面在重载后仍能渲染它。该事件从不进入模型请求。
- **运行始终会被释放。** 无论审查者完成、失败，还是命令处理函数自身抛出异常，已启动运行的 `dispose()` 都会在 `finally` 块中执行。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、审查变体表、命令注册、持久记录与结果渲染 |
| [`src/reviewer.ts`](src/reviewer.ts) | 共享的审查者 seam：提示词构造、报告 schema、spawn 路径与 `review/report` 事件声明 |
| — | 不发布运行时不变式伴生入口；本命令适配器不拥有任何事件序列或状态 projection——派发行为由包测试覆盖，审查子 agent 自身的生命周期不变式归属 `dsh-subagent`。 |

其他包通过包根访问同一个审查者：`runReviewer`、`reviewPrompt`、`REVIEW_OUTPUT_SCHEMA` 以及 `ReviewFinding`/`ReviewReport` 类型都对外导出，供拥有自己审查者端口的调用方使用。`dsh-agent-kernel` 的编码生命周期就是这样的调用方之一。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

命令是 subagent seam 之上的薄适配层；以下页面说明委派契约与它所接入的注册表。

- [Subagent 服务](../subagent/README.zh.md)——`ctx.subagents` seam、`outputSchema` 与这些命令直接驱动的一次性运行契约。
- [Subagent spawn 提供方](../subagent-spawn-in-process/README.zh.md)——参考后端：没有父级对话的全新子 agent。
- [面向模型的委派工具](../tool-subagent/README.zh.md)——同一 seam 的兄弟消费方，服务于模型发起的委派路径。
- [命令服务](../../interaction/commands/README.zh.md)——命令注册表契约与派发方式。
- [审查结果面板](../../client/ui-review/README.zh.md)——把持久报告渲染为结构化界面的浏览器端界面。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-command-review)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 人工审查控制

#### 模型看到什么

从父 agent 的视角看不到任何东西：斜杠输入、审查者的任务提示词、其工具调用与渲染后的发现，都不会出现在父级的模型请求中。审查子 agent 是拥有自己模型请求历史的独立 agent，作用域限于自己的会话。

#### Token 影响

两条命令都不会给父 agent 自身的模型请求增加任何 token。审查子 agent 的工具调用与轮次消耗它自己的预算，取决于 `provider`/`model` 解析出的路由。

#### KV Cache 影响

对父级没有影响——两条命令从不改变父级的请求前缀。审查子 agent 遵循其所配置提供方的全新子 agent KV Cache 行为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明这些命令何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **交付应用中仅 Web 命令适配器可用**——headless、ACP 自动化与 JSON-RPC 适配器都不消费 `ctx.commands`，因此目前只能从 Web composer 触达这两条命令。
- **发现只读**——面板渲染审查者报告的内容；采纳、驳回或批注某条发现尚未实现。
- **审查者需要自己的工具**——若某组合没有给 `spawn`（或所配置的）提供方的子 agent 提供 shell 或文件读取工具，就无法产出真正的审查；命令本身不会在启动运行前校验工具可用性。
- **每个部署只有一条路由**——两条命令都运行在所配置的 `provider`/`model` 下，因此无法在同一次调用中向第二个后端索要第二意见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。报告以仅写入日志的 `review/report` 事件抵达客户端：面板所需的任何新字段都属于该事件，而不属于渲染出的命令文本。

</details>

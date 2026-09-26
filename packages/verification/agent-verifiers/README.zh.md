---
description: "面向 agent-kernel 完成门禁、由独立子代理裁决的验收标准验证器：security、browser、review 三族各由一个全新上下文的子代理裁决，供需要任务「完成」建立在全新上下文结论之上的使用者采用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-verifiers

[English](README.md) | 中文

## 概述

当某条验收标准无法由一条 shell 命令回答时，使用本包。`security`、`browser`、`review` 三族各自提出的问题只有全新上下文才能回答：这次改动是否可被利用、该场景是否仍然可用、独立审查者是否看到缺陷。本插件会为这类标准各启动一个审查者子代理，消费其结构化报告，并把结论记录为内核完成门禁据以裁决的判定。所有族都经由审查命令共用的审查者辅助函数启动子代理，因此 `/review`、`/security-review` 与本包各验证器在同一处提出同一个问题。本包不回答的族则保持未决。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [维护者笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件与 `@deepseek-ai/dsh-agent-kernel`、agent 注册表以及一个子代理服务挂载在一起。内核会注入其验证器注册表，因此挂载顺序无关紧要；注册表则提供每个审查者启动所依据的 Agent。本插件不认领其他任何内容：属于其他族的验收标准留给回答它的验证器。

### 最小组合

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    acceptance:
      - id: code-review
        description: an independent reviewer finds no high-severity defect in the change
        verifier: review
        required: true
      - id: settings-scenario
        description: the settings page saves without a reload, at http://localhost:3000/settings
        verifier: browser
        required: true
- name: '@deepseek-ai/dsh-agent-verifiers'
  config:
    subagentProvider: spawn
    minSeverity: high
    reviewRef: HEAD
```

### 本包回答的族

| 族 | 审查者裁决什么 | 返回的报告 |
|---|---|---|
| `security` | 改动行是否引入或暴露可被利用的缺陷 | 缺陷列表，各带严重度 |
| `browser` | 审查者实际操作时，标准描述的场景是否成立 | 是否通过，附带观察记录 |
| `review` | 独立审查者是否发现真实缺陷或正确性风险 | 缺陷列表，各带严重度 |

### 审查者回答哪条标准

验收标准仅由其 `verifier` 族认领：本插件回答族为 `security`、`browser` 或 `review` 的每一条标准，其余一概不答。它不读取任何按标准区分的配置，因此希望某条标准由特定 provider 审查的部署应再挂载一套组合，而不是在此新增字段。属于其他族的标准保持未决，内核将其报告为 `unknown`，而不会将其判为通过。

### 配置

| 字段 | 必填 | 含义 |
|---|---|---|
| `subagentProvider` | 否 | 每个审查者启动所用的 `ctx.subagents` provider 名。默认 `spawn`，即不带父级历史的全新上下文。 |
| `provider` | 否 | 审查者子代理的 provider 路由覆盖。缺省时继承父 agent 的路由。 |
| `model` | 否 | 审查者子代理的模型 id 覆盖。缺省时继承父 agent 的模型；在此指定不同模型即 §10.6 所要求的独立审查者。 |
| `minSeverity` | 否 | 会使 `security` 或 `review` 标准失败的最低缺陷严重度：`high`、`medium` 或 `low`，默认 `high`。 |
| `reviewRef` | 否 | 审查者对工作树做 diff 所依据的 ref，默认 `HEAD`，其 diff 即未提交的改动集。 |

所有可接受字段列于生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-verifiers)。

### 你会得到什么

| 审查者结果 | 判定 |
|---|---|
| 完成并给出报告，其中最严重缺陷低于 `minSeverity` | `pass`，附带摘要、缺陷列表及其所指文件 |
| 完成并给出达到或超过 `minSeverity` 的缺陷 | `fail`，附带报告并指明所越过的阈值 |
| `browser` 标准下返回 `passed: false` | `fail`，附带审查者的观察记录 |
| 未完成，或完成时缺少该族的报告 | `fail`，指明停止原因或缺失的报告 |
| 无法启动，或没有可据以启动的 Agent | `fail`，指明为何没有发生审查 |

每个判定都记录标准 id、报告原文以及判定所依据的引用，因此会话日志的读者可以重建审查者被问了什么、标准为何如此裁决。审查者子代理自身的会话保存着提示词与子代理的工作内容。

---

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本节说明一条标准如何变成判定；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

一个族是一个问题而非一条命令，因此验证器不持有任何 shell 命令行、也没有按标准区分的表：`supports()` 匹配标准的族，`verify()` 则通过 `@deepseek-ai/dsh-command-review` 的 `runReviewer` 恰好启动一个审查者。该辅助函数是唯一的启动路径——`/review`、`/security-review`、内核生命周期审查者与本插件都经由它抵达 `ctx.subagents.start`——因此审查者启动方式的改动，或缺陷类族所返回报告模式的改动，只需落地一处。提示词是该族面向模型的全部契约，并携带标准的 id 与陈述，这正是以 diff 为范围的审查者也能给出以标准为范围的判定的原因。审查者的结构化输出是模型生成的 JSON，因此每个字段都会在判定依据它之前受到校验。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`、注入项、`Config` 以及注册 effect |
| [`src/families.ts`](src/families.ts) | 本包回答的族，作为一份部署可直接读取的清单 |
| [`src/contracts.ts`](src/contracts.ts) | 每个族的提示词与所要求的报告模式 |
| [`src/verifier.ts`](src/verifier.ts) | `CriterionVerifier`：族匹配、审查者启动与判定 |
| [`src/types.ts`](src/types.ts) | 族词汇表与 browser 族的报告 |
| — | 不发布运行时不变式伴随包；验证器除配置外不持有状态，每个判定都源自一个审查者的报告，因此第二次观察不可能与之分歧。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不足时，请阅读以下页面。它们从族的裁决走向消费其判定的门禁，以及它所启动的审查者机制。

- [Agent kernel 子系统参考](../../../docs/subsystems/agent-kernel.zh.md) —— 验收标准、完成门禁，以及验证器注册表施加于已注册验证器的排序与超时。
- [审查命令](../../subagent/command-review/README.zh.md) —— `runReviewer`，本包启动审查者所用的共享启动路径与报告模式。
- [Subagent 子系统参考](../../../docs/subsystems/subagent.zh.md) —— provider 注册表、一次性运行句柄，以及判定所读取的结构化结果。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-verifiers) —— 本插件的所有可接受字段。

-----

<a id="model-experience"></a>
## 模型体验

### 审查者的任务提示词

#### 模型看到什么

本包回答的每条标准都会在一个全新子上下文中变成一次模型请求：该族的审查指令、diff 目标（`reviewRef`）以及标准自身的 id 与陈述，作为子代理的用户消息投递。子代理看到的是仓库及其工具，而不是父级的对话，并通过该族的输出模式回报——带严重度的缺陷列表，或场景是否成立。父级模型只能从标准记录的判定看到子代理的报告，以及标准失败时内核的修复消息。

#### Token 影响

增量且受部署声明约束：该族每条标准一次子代理回合，其输入为提示词加上子代理读取的内容，输出为一份报告。父级自身的请求不增加任何内容。

#### KV Cache 影响

相互独立：父级不注册任何提示词分节与工具模式，因此其请求前缀从不变动。每个审查者都在自己的上下文中运行，拥有各自的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本插件何时不适合使用。它们是当前的包级约束，而不是待办清单。

- **验证接缝不携带 `AbortSignal`** —— `VerificationRequest` 没有取消通道，因此审查者以一个永不触发的控制器启动，只能靠完成、靠内核的 `verifierTimeoutMs` 上限（它放弃判定但不终止子代理）或靠组合拆除来停止。
- **审查者必须从某个 Agent 启动** —— `ctx.subagents.start` 需要一个父 Agent，验证器从 agent 循环围绕每一回合建立的当前发起者边界读取它。在此类边界之外驱动的验证（host 直接调用 `agentKernel.verify`、重放）会以该原因使标准失败，而不会猜测父级。
- **一条标准一个审查者** —— 声明十条 `review` 标准的任务会启动十个子代理，各自拥有上下文；不存在跨标准的批处理或共享审查。
- **严重度阈值是唯一的通过规则** —— 只要没有缺陷达到 `minSeverity`，`review` 标准即通过；需要排除特定缺陷类别的部署必须在标准描述中写明，该描述会作为提示词的一部分送达审查者。
- **`browser` 标准需要可达的应用** —— 审查者只能操作其工具可达的内容，因此标准必须写明启动应用的 URL、命令或 fixture；应用不可达会使标准失败，而不会判为通过。
- **标准无法指定各自的审查者路由** —— provider 与模型覆盖属于插件配置，因此该族中每条标准都以同一路由进行审查。
- **审查者失败会阻塞完成** —— 判定是 `fail` 而非 `unknown`，因此审查者未能运行的任务会一直未完成，直到原因被修复。这是有意为之：没有审查者裁决过的标准绝不能看起来像通过。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

本维护者笔记是维护者的工作上下文：其中是尚未决定的问题与方向，明确不具权威性 —— 已发布行为、限制与已接受的理据见上文各节、包代码以及所链接的 Agent Notes。

备选方案是由单个 `agent-verifiers` 族从标准文本推断其问题，以及在本包内再提供一个审查者子代理 provider。前者把部署意图变成对提示词的解析猜测，并用一个名字掩盖了三个问题；后者正是 §10.6 与审查者抽取要避免的第二条启动路径。在共享的 `runReviewer` 之上设置三个具名族，让每个问题在标准中可见，并让审查者启动及其报告模式仍归审查命令所有。

</details>

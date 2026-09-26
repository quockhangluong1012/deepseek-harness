---
description: "研究质量控制回路（ctx.research）：从问题到认识论复核的十个持久阶段、由机制实现者承担的阶段提供者接缝，以及六类答案契约。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-controller

[English](README.md) | 中文

## 概述

把研究任务作为一条持久的十阶段回路来运行：question、decompose、research-plan、search、source-triage、claim-extraction、evidence、contradiction-search、synthesis、epistemic-review。每个阶段的状态与产出都存入 `research` 域，因此运行可跨上下文中断存续，而无法运行的阶段会带上它缺少的引用被拒绝。回路自身的阶段由模型通过 `research_advance` 工具完成；search、source-triage 与 contradiction-search 由提供者完成。观察与主张始终是 Agent Kernel 的记录。

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

把插件挂到已带 `agentKernel`、`tools` 与 `storageDomain` 的组合中；它会注册 `ctx.research` 与两个面向模型的工具。

### 能力接缝

- **服务定义**——本包的 `ResearchController`（`ctx.research`）：阶段词表、运行的持久状态、顺序规则与答案契约。
- **服务提供者**——为某个机制阶段调用 `ctx.research.registerStageProvider(provider)` 的包：`search`、`source-triage` 与 `contradiction-search`。一个阶段只有一个提供者；当运行的下一个阶段属于提供者却没有提供者时，推进会被拒绝。来源分级与矛盾检索是各自包拥有的机制。
- **消费者**——`research_advance` 与 `research_state` 工具，它们承载 Agent Loop 的阶段工作并读回运行。

没有活动 Agent 的读取方——例如对回路已记录内容做评估遍历——可通过 `runs(sessionId?)` 读取已存储的运行，最新在前，可选地限定到某一个会话。运行记录是一次运行的全部持久状态；它的证据与主张都是 Kernel 身份，调用方应通过会话日志解析，而不是通过本服务。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-research-controller'
  config:
    maxTextBytes: 4096
    maxItems: 16
    maxRuns: 50
```

| 字段 | 含义 |
|---|---|
| `maxTextBytes` | 任一陈述文本的 UTF-8 字节上限：问题、阶段输出行、主张、答案陈述 |
| `maxItems` | 任一列表的上限：子问题、计划步骤、阶段输出行、主张、答案陈述 |
| `maxRuns` | 每个会话保留的已判定运行数；写入新运行时会丢弃更早的已判定运行 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-research-controller)列出所有字段。三项均为必填，因此遗漏其一的组合在加载时失败，而不会无界运行。

研究运行还要求会话的 Kernel 任务属于 `research` 类：该类来自调用方自己的陈述、任务类为 `research` 的 Agent 角色，或部署默认值。在其他类别下启动的运行会被拒绝，并说明它实际发现的类别，而不是把研究阶段记到一次会话式任务上。

### 注册阶段提供者

```ts
import type { ResearchStageProvider } from '@deepseek-ai/dsh-research-controller'

const provider: ResearchStageProvider = {
  id: 'web-search',
  stages: ['search'],
  async run(request, signal) {
    return {
      output: [`searched for "${request.question}"`],
      observations: [{ kind: 'web', contentRef: 'https://example.test/spec', sourceRef: { source: 'web', locator: 'spec' }, trust: 'untrusted' }],
    }
  },
}

ctx.effect(() => ctx.research.registerStageProvider(provider), 'web-search.stageProvider')
```

返回的 disposer 会移除该提供者；当它声明的阶段已有提供者，或该阶段的工作属于 Agent Loop 时，注册会被拒绝。提供者返回的每个观察都通过 `ctx.agentKernel.recordEvidence` 记录，因此运行引用的是 Kernel 自己的记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

控制器在 `research` 域中为每次运行保存一条持久记录（`src/spec.ts`），纯转换规则位于 `src/pipeline.ts`：哪个阶段可以推进、阶段记录什么、六类桶如何归类，以及认识论复核拒绝哪些违规。`src/index.ts` 负责这些规则无法承担的 I/O：提供者、Kernel 记录与域写入。

阶段以三种状态之一落地。`pending` 表示尚未尝试；`produced` 携带产出与该阶段记录的引用；`failed` 携带原因，运行停留在该阶段，下一次推进即重试。被拒绝的答案通过再次推进 `synthesis` 修订，这会重新开启拒绝它的那次复核。

观察与主张不会被复制：`claim-extraction` 通过 `ctx.agentKernel.recordClaim` 记录每条主张，提供者的观察通过 `ctx.agentKernel.recordEvidence` 记录，而 `evidence` 阶段要求运行自身至少有一条由检索阶段记录的观察。`evolution-graph` 保存的跨会话主张是另一套、面向晋升的记录；本包从不写入它。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.research` 服务、两个工具、Kernel 与域的 I/O |
| [`src/types.ts`](src/types.ts) | 阶段词表、运行与阶段记录、答案契约、提供者接缝 |
| [`src/stages.ts`](src/stages.ts) | 有序阶段表，以及哪些阶段由提供者执行 |
| [`src/pipeline.ts`](src/pipeline.ts) | 纯转换：顺序门禁、阶段落地、答案归类、复核 |
| [`src/spec.ts`](src/spec.ts) | `research` 域声明及其 zod 记录 schema |
| [`src/caps.ts`](src/caps.ts) | 配置上限，拒绝时给出实测大小 |

**不发布不变式伴随包。** 域层已经发出 `domain/changed`，并在打开时校验每条已存记录；本包内再加一个观察者只会读到它刚写入的同一份内存表，无法独立地产生分歧。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent kernel](../../runtime/agent-kernel/README.zh.md) — 任务契约、它命名的任务类别，以及本回路写入的 `evidence/recorded` 与 `claim/updated` 记录。
- [存储子系统](../../../docs/subsystems/storage.zh.md) — 运行记录所采用的域形式。
- [研究子系统](../../../docs/subsystems/research.zh.md) — 回路参考：阶段语义、持久记录与答案契约。

-----

<a id="model-experience"></a>
## 模型体验

### 研究回路的两个工具

#### 模型看到什么

模型会看到生成的 `research_advance` 与 `research_state` schema。`research_advance` 接收 `stage`（封闭为十个阶段名）、可选的 `items`、`claims` 与 `sections`；`research_state` 接收可选的 `runId`。两者都以行文本返回运行，因此模型在一次结果中读到每个阶段的状态与产出、下一个要推进的阶段，以及已接受的答案。工具描述说明了回路的顺序、阶段不可跳过、失败的阶段会被重试、被拒绝的答案通过再次推进 synthesis 修订、每项输入属于哪个阶段，以及复核的两个条件。

#### Token 影响

只要工具可见，两个 schema 就会加入请求。阶段表、答案桶与回路顺序是固定的 schema 文本；调用返回的运行文本随已产出的阶段及其输出行增长，每行受 `maxTextBytes` 与 `maxItems` 限制。

#### KV Cache 影响

只要工具定义与可见性不变，schema 就保持请求前缀稳定。运行文本作为工具结果到达，因此绝不会重写请求前缀；插件生命周期、Agent 限制或变更的阶段表可能改变这组 schema。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **机制阶段需要部署自己的提供者。** `search`、`source-triage` 与 `contradiction-search` 阶段在没有提供者时会显式失败；拥有来源分级与矛盾检索的包提供它们，本包不提供任何实现。
- **桶是声明出来的，未与主张类型比对。** Kernel 的主张记录目前没有 `type` 枚举，因此复核只检查每条已记录主张都在某个桶中陈述，且 `unresolved` 之外的陈述都不缺少主张；它无法检查某条陈述究竟是被记载的还是被推断的。
- **运行状态位于 Host 侧。** `research` 域是进程内状态：第二个进程只能读到自己打开的内容，且列出的观察受上限限制，而已记录的标识不受限。
- **引用按值保存。** 运行按值保存会话记录过的证据与主张标识；删除或迁移会话日志会使这些标识无法解析，本包不会重新校验它们。
- **保留策略从不删除未判定的运行。** `maxRuns` 限制每个会话的已判定运行数；未判定的运行会一直保留到判定为止，因此放弃运行的会话会留下它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

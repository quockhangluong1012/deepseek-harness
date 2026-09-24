---
description: "上下文编译器：把每条提示词贡献与持久任务事实包装成来源信封，为其排序与计价，记录一次模型步骤所依据的放置摘要，并且只丢弃超出 token 上限的可压缩来源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-context

[English](README.md) | 中文

## 概述

当需要从会话日志回答"某一步究竟依据什么编译出来、重放能否复现它"时，就挂载本包。它把组装出的每条提示词 section 与运行时 context，加上 Kernel 推导出的持久任务事实，包装成来源信封；按可信度、种类与相关性排序，用 token meter 计价，并为每个不同的放置追加一条仅日志的 `context/compiled` 记录（摘要值重复时不追加）。`mode: 'shadow'`（默认）记录放置结果且不改变任何东西；`mode: 'apply'` 还会丢弃被上限切掉的可压缩来源。`policy`、`task`、`plan` 与 `evidence` 来源永不被丢弃。

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

当一个步骤编译出的上下文必须可归因、可重放时，在 profile 中挂载该插件。不做任何配置地挂载时，它以 shadow 模式、不设 token 上限地记录每次放置，因此在部署量出上限之前不会有任何东西被丢弃。

### 何时选择它

当上下文来源或上下文 token 上限必须成为运行时契约时选择它：事后必须重建其提示词的无人值守运行、按输入 token 计费的部署，或必须精确复现一次放置的重放。当组装出的提示词很小且完全可信时请避开它，因为编译器为每次组装追加一条仅日志记录，并在 `apply` 模式下移除贡献。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-agent-context'
  config:
    mode: shadow
    maxContextTokens: 64000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `shadow` 记录放置结果并原样返回组装；`apply` 还会返回移除了放置所遗漏的每个来源之后的组装 |
| `maxContextTokens` | 未设置（无上限） | 放置所拟合的 token 上限，由 token meter 的固定启发式估算器计价 |

每个被接受的字段都列在生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-context)中。

### 你会得到什么

在每次指名了某个 agent、且编译出的摘要值尚未被本会话记录过的 `system-prompt/assemble` waterfall 之后，服务记录一条 `context/compiled` 事件，记录中包含放置摘要、声明的编译器版本、所拟合的上限、放置的 token 价格、每个被放置来源的条目（id、kind、trust、retention、价格、相关性）、每条遗漏及其原因，以及每个被保留的冲突。提示词文本本身留在 `system/message` 面上，因此该记录是重放必须复现的身份，而不是提示词的第二份副本。

有两个决策被刻意分开。编译器决定一个步骤依据什么编译，并在 `apply` 模式下决定上限切掉了哪些可压缩来源；它从不决定某条贡献说了什么，从不编辑提示词文本，也从不调用模型。

### 来源归属

组装出的贡献按其注册名的前缀分类，未列出的前缀被视为不可信的仓库内容——数据，绝不是指令权威。

| 名前缀 | Kind | Trust | 归属 |
|---|---|---|---|
| `harness:`、`deployment:`、`plan:`、`team:`、`sandbox:`、`approval:` | `policy` | `trusted` | `policy` |
| `subagent:` | `policy` | `trusted` | `subagent` |
| `tool:`、`tools:` | `tool` | `trusted` | `tool` |
| `context:`、`ui:`、`app:` | `artifact` | `trusted` | `repo` |
| 其他任何前缀 | `artifact` | `untrusted` | `repo` |

从 `ctx.agentKernel.state.view(session)` 读到的持久任务事实始终是 `trusted`、始终是 `required`，并归属 `kernel`：目标、每个验收标准一条来源、每条约束一条、最新计划修订、每个未结动作一条，以及每个未解决失败一条。

### 注册一个动态来源（S2）

`ctx.agentContext.register(descriptor, provide)` 是前置步骤的产出者用来替代直接追加提示词 section 的接口：`provide(agent, signal)` 为一次编译返回若干条目，编译器把每条包装成一个 `ContextSource`（`id: '<producer>:<itemId>'`），与组装内容及 Kernel 的任务事实一起排序定价，并计入同一份摘要。调用会返回一个撤销函数；调用它之后，该产出者的条目不再出现在任何后续编译中。

```ts
const stop = ctx.agentContext.register(
  { producer: 'goal', kind: 'task', trust: 'trusted', placement: 'stable-core', maxBytes: 4000 },
  async (agent, signal) => [{ id: 'objective', text: currentGoalText(agent), relevance: 1 }],
)
```

`placement` 同时决定保留等级与重复方式，对应 S1 修正案第 3 点与 S2：

| Placement | 保留 | 重复方式 |
|---|---|---|
| `stable-core` | `required` | 每次编译都无条件出现——产出者自身不变的身份简介 |
| `delta` | `compressible` | 每个条目 id 每个会话只出现一次；此后每次编译都被压下，直到该会话上出现 `compaction/end` 事件才清空 |
| `tail-reminder` | `compressible` | 每次编译都出现——随 turn 变化的提醒文本，是上限最先切掉的一类 |

过了自身 `expiresAt` 的条目会在放置前被丢弃，条目文本会在成为来源前按描述符的 `maxBytes` 截断。这个注册表是纯增量的：目前没有任何随包产出者迁移出 `core/system-prompt` section 改用它，因此在没有任何注册的情况下挂载本插件，行为与之前完全一致。

### 保留与排序

保留等级随 kind：`policy`、`task`、`plan` 与 `evidence` 是 `required`，因此即使它们单独就超出上限也仍被放置；`memory`、`artifact`、`history` 与 `tool` 是 `compressible`。

放置顺序是全序，因此重放能复现它：先是可信度层级（`trusted`、`unknown`、`untrusted`），再是 kind（`policy`、`task`、`plan`、`evidence`、`memory`、`artifact`、`history`、`tool`），再是与任务目标的词面重叠度，最后是来源 id 的码元顺序。上限切掉该顺序的一个前缀：一旦某条可压缩来源放不下，其后每条可压缩来源都以 `reason: 'budget'` 被省略。内容已被某个已放置来源承载的可压缩来源以 `reason: 'duplicate'` 被省略；无论哪种情况，required 来源都不会被丢弃。

两条被放置的 `required` 来源若声明同一个 `subject` 且内容互不相同，会产生一条 `ContextConflict`，指名该 subject 与相关来源。编译器报告冲突，但不裁决冲突。

摘要（digest）覆盖编译器版本、上限、每个被放置来源的 id、kind、trust、retention、价格、相关性与内容哈希，以及每条遗漏与每个冲突。它排除时钟与一切生成式身份。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

本节说明一次放置从何而来，以及编译器拒绝做什么；可观察行为已完整覆盖在[使用本包](#use-this-package)中。

### 设计理念

编译器建立在四项承诺之上：

- **是 facade，不是汇编器。** 它读取的每条贡献都由 `core/system-prompt` 注册，每条任务事实都来自 Kernel 对会话日志的折叠。编译器不组装任何提示词，也不持有任何真相来源。
- **必需先于最优。** 关于任务本身的权威——适用的权限、契约、其验收标准、其计划、其证据、其未解决失败——在考虑预算之前就被放置。
- **构造上确定。** 排序是全序，摘要使用内容哈希而非时间戳，因此相同输入在任何机器上产生相同摘要。
- **先 shadow 再 apply。** 默认模式先对着真实流量度量一个上限，之后部署才会让它移除某条贡献。

### 每个决策在哪里做出

| 关注点 | 归属 |
|---|---|
| 存在哪些贡献、它们说了什么 | `core/system-prompt` 的 section 与运行时 context |
| 任务是什么、其计划、未结动作、失败 | `dsh-agent-kernel` 对会话日志的折叠 |
| 一条贡献的 kind、trust 与归属 | `src/classify.ts` |
| 放置顺序 | `src/rank.ts` |
| token 价格与上限切分 | `src/budget.ts` 基于 `dsh-token-meter` 的固定估算器 |
| 放置身份 | `src/digest.ts` |
| 持久记录与 `apply` 过滤器 | `src/index.ts` |

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、服务与组装监听器 |
| [`src/compile.ts`](src/compile.ts) | 纯流水线、来源集合断言、去重与冲突，以及 `recordOf()` |
| [`src/sources.ts`](src/sources.ts) | 两个来源族：组装出的贡献与 Kernel 任务事实 |
| [`src/classify.ts`](src/classify.ts) | 前缀、trust、归属与保留等级表 |
| [`src/rank.ts`](src/rank.ts) | 目标词项提取、相关性打分与全序放置顺序 |
| [`src/budget.ts`](src/budget.ts) | 固定启发式计价与 required 优先的前缀切分 |
| [`src/digest.ts`](src/digest.ts) | 内容哈希与规范化放置摘要 |
| [`src/types.ts`](src/types.ts) | 全部编译器契约与 `context/compiled` 的 `SessionEventMap` 合并 |
| — | 不发布运行时 invariant 配套组件；该记录是其所指名的组装与 Kernel 视图的纯函数，因此对同一步骤的第二次观察不可能与之分叉。 |

### 流水线

```text
collect the assembled contributions
  -> wrap each in a source envelope (kind, trust, provenance, retention)
  -> append the kernel view's required task facts
  -> reject an empty or duplicated source id
  -> price with the token meter's fixed estimator
  -> score lexical overlap with the task objective
  -> sort by the total placement order
  -> drop compressible duplicates
  -> cut a compressible prefix at the ceiling
  -> report conflicts among placed required sources
  -> digest the placement
  -> append context/compiled; apply mode removes the rest from the assembly
```

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时，读这些页面。

- [上下文编译器子系统参考](../../../docs/subsystems/agent-context.zh.md) — 来源信封、放置记录与生成的 Cordis API。
- [Agent Kernel 子系统参考](../../../docs/subsystems/agent-kernel.zh.md) — 编译器所读取的任务契约、计划、未结动作与未解决失败。
- [System prompt 包](../../core/system-prompt/README.zh.md) — 编译器所分类的组装与贡献名。
- [Session 子系统参考](../../../docs/subsystems/session.zh.md) — `context/compiled` 所扩展的事件映射，以及保留提示词文本的 `system/message` 面。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-context) — 每个被接受的字段及其来源声明。
- [runtime 分组地图](../README.zh.md) — 同组的 runtime 包。

-----

<a id="model-experience"></a>
## 模型体验

### apply 模式的省略

#### 模型看到什么

在 `shadow` 模式下什么也看不到：编译器追加其记录，并原样返回 `core/system-prompt` 产出的组装。在 `mode: 'apply'` 下，模型看到的 section 与运行时 context 与原来相同，但缺少放置所遗漏的每个来源——被上限切掉的可压缩贡献（`reason: 'budget'`），或内容已被某个已放置来源承载的贡献（`reason: 'duplicate'`）。Required 来源，包括每条持久任务事实，始终在场。

#### Token 影响

直接的 token 影响为零。`shadow` 模式不移除任何 token；`apply` 模式移除记录在 `omitted` 中报告的那些 token 价格，并且当 required 来源单独就超出上限时，放置的价格可以高于其上限。

#### KV Cache 影响

在 `shadow` 模式下独立——它不改变任何请求。在 `apply` 模式下为替换式：被移除的贡献在请求中消失，因此从第一个发生变化的位置起复用失效，而第一个被省略贡献之前的请求前缀仍可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定编译器何时不合适。它们是当前包的约束，不是任务清单。

- **没有 profile 挂载它，也没有投影读取 `context/compiled`** — 记录是持久且可重放的，但没有任何已发布的 profile 启用该插件，也没有任何东西渲染放置结果，因此部署需要自己去读日志。
- **重复的来源 id 会使那次组装失败** — 以同一个名字注册的一个 section 与一个运行时 context 会以同一个 id 两次抵达编译器，`assertSources()` 会拒绝这次编译，从而使该步骤的提示词组装失败。贡献名必须在两个注册表之间唯一。
- **冲突检测需要声明的 subject** — 只有编译器自身来自 Kernel 视图的来源会声明它（`objective` 与 `plan`，各自至多出现一次），而没有任何组装出的贡献会声明，因此在每个已挂载的组装中 `conflicts` 都为空；要通过 `ctx.agentContext.compiler.compile()` 自带信封的调用方才能触发这份报告。
- **目前没有计划来源抵达** — `task/plan` 已被声明并被 Kernel 折叠，但没有任何东西追加它，因此本编译器从视图投影出的计划信封，要等到某个产出者记录一次修订后才会出现。
- **相关性是词面的** — 与目标中长度三个字符及以上词项的重叠，没有词干化、同义词或 embedding 阶段，因此用不同措辞回答目标的来源得分为 0。
- **token 价格是估算** — 上限比较的是 token meter 的固定启发式估算——与为请求内容块计价的是同一个估算器——而不是提供方实际的 token 计数。
- **保留等级由 kind 固定** — 每条组装出的 `tool:`、`context:`、`ui:`、`app:` 贡献都可压缩，无论它读起来多像指导；未列出的前缀是不可信数据；二者都无法从配置改变。
- **apply 按步骤生效** — `apply` 模式只过滤交给它的那次组装，因此被丢弃的贡献会在下一次能容纳它的组装中回来；编译器不在步骤之间保留记忆。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发笔记是面向维护者的工作上下文：尚未决定的问题与方向。它明确不具权威性——已发布的行为、限制与被接受的理据位于上文各节、包代码与所链接的 Agent Note。

编译器是[演进式 agent 运行时规范](../../../specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md)的 Phase 2 切片。对该规范字面文本的两处偏离是刻意的。第一，`CompiledContext` 不携带 `messages`：由循环渲染组装，因此编译器返回放置结果，并让 `core/system-prompt` 保留渲染后提示词的所有权。第二，必需事实不会被复制进 compaction 检查点；编译器在每次组装时从 Kernel 视图重新推导它们，因此移除了转录文本的 compaction 无法把任务的目标、验收标准、计划或未解决失败从下一次请求中移除。模型路由、证据图、workflow 检查点与演进提升门禁属于后续阶段，这里完全没有体现。

</details>

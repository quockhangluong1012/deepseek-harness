---
description: "具名的 ICT 分析师与魔鬼代言人作答约定：每个 profile 一个 preset、固定的段落列表，以及一个在调用方使用答案前就拒绝它的校验器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-analyst-profiles

[English](README.md) | 中文

## 概述

让一个会话扮演两种分析角色之一，并得到一份程序可以检查的答案。每个 profile 固定一份有序的段落列表，且每条主张都标注为 observed 或 inferred，因此解读无法冒充观察。调用方先取该 profile 的结构化输出 schema 用于委派，再用同一个 profile id 校验返回结果，之后才据以行动。ICT 分析师从 OBSERVATIONS 作答到 MISSING EVIDENCE；魔鬼代言人从 Thesis 作答到 Confidence——这正是 mentor 循环的 advocate 阶段与研究循环的矛盾步骤所消费的形状。

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

先挂载一次服务行，再为部署要提供为可选 Agent preset 的每个 profile 挂载一行 preset。

### 何时选择它

当调用方必须以程序方式据分析结果行动时选择它：profile 规定了答案必须携带哪些段落、其中哪些是观察、答案如何表达不确定性，因此消费方可以拒绝不完整或混杂的答案，而不必解析散文。当每一轮都需要同一份批评时使用它，例如 mentor 循环的 advocate 阶段或研究循环的矛盾步骤。不要把它用于开放式讨论：只需要分析师口吻的会话，用人设行即可；而给没有产物要生成的对话强加固定段落列表，只会束缚它。

### 最小配置

```yaml
# The profile directory every consumer reads by name.
- name: '@deepseek-ai/dsh-analyst-profiles'

# One row per profile the deployment offers as a preset.
- name: '@deepseek-ai/dsh-analyst-profiles/preset'
  config:
    profile: devil-advocate
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profile` | 必填 | 本行注册为 preset 的已声明 profile；未声明的 id 在加载时明确报错且不注册任何 preset |

已声明的 id 就是 `ctx.analystProfiles.list()` 返回的值，目前为 `ict-analyst` 与 `devil-advocate`。该 preset 以 profile 的标题出现在 roster 中；选择它的会话会把 profile 提示词组装为自身的人设前缀。

### 调用方如何处理结果

调用方以 profile 的 schema 作为本次运行的 `outputSchema` 来委派——即 `ctx.analystProfiles.outputSchema('devil-advocate')`——并用同一个 profile id 校验 `result.structured`。校验器是纯函数，因此可用于调用方已解析出的任何产物：

```ts
import { getProfile, validateProfileArtifact } from '@deepseek-ai/dsh-analyst-profiles'

/** Report what a delegated advocate answer breaks, or nothing when it satisfies the contract. */
function advocateProblems(answerFromTheRun: unknown): string[] {
  const verdict = validateProfileArtifact(getProfile('devil-advocate'), answerFromTheRun)
  return verdict.ok ? [] : verdict.violations.map(violation => `${violation.at}: ${violation.message}`)
}
```

值得据以分流的段落：魔鬼代言人的 `Falsifiers` 与 `Counterarguments` 是矛盾步骤要归档的反证，而其 `Confidence` 为该产物携带的数值 `confidence` 说明理由。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

profile 是数据，不是行为：一个 id、一个标题、一段方法说明，以及一份有序的段落列表，其条目把一个标题与它必须携带的依据配对。其余一切都由该记录派生。提示词是方法说明加共享作答规则加编号段落，并成为该 profile 之行在 agent-preset seam 上注册的 preset 的人设前缀。结构化输出 schema 为委派枚举同一组 id、标题与依据，校验器则遍历同一份列表，报告缺失、意外、重复、错位、为空或混杂的段落。段落列表没有第二份副本需要同步。

| 文件 | 职责 |
|---|---|
| [index.ts](src/index.ts) | `ctx.analystProfiles`：`list`、`get`、`outputSchema`、`validate` |
| [profiles.ts](src/profiles.ts) | 两个 profile 记录、提示词、schema 与 preset 声明 |
| [validate.ts](src/validate.ts) | 纯段落校验器及其违规词汇 |
| [preset.ts](src/preset.ts) | preset 行：`ctx.agentPresets.register` 及其反注册清理器 |
| [types.ts](src/types.ts) | 仅含约定类型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Persona](../persona/README.zh.md)——每个 profile preset 用来挂载其提示词的行。
- [Agent presets](../agent-preset-registry/README.zh.md)——本包声明进的 preset 注册表、其 roster 与修订保留。
- [Agent preset](../agent-preset/README.zh.md)——profile 声明所镜像的声明式行。
- [Subagent](../../subagent/subagent/README.zh.md)——本校验器所消费 `structured` 结果的 `outputSchema` 委派。
- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)——profile 提示词所占据的人设槽位。
- [工具](../../core/tools/README.zh.md)——输出 schema 所采用的 JSON Schema 子集。

-----

<a id="model-experience"></a>
## 模型体验

### profile 提示词

#### 模型看到什么

preset 为某 profile 的会话，会把该 profile 的提示词作为 `deployment:persona-prefix` 段落接收，替换部署级人设。提示词陈述角色、观察／解读规则、`confidence` 要求，以及答案必须携带的编号段落。两个 profile 只在方法说明与段落列表上不同；下文原样给出 ICT 分析师的提示词。

##### ICT analyst prompt

```markdown
You are an ICT (Inner Circle Trader) market analyst. Work only from the market data the task supplies: price action, timeframes, levels, sessions, and any volume series. When the inputs do not support a statement, record the gap in MISSING EVIDENCE instead of inventing it.

Separate observation from interpretation. A claim carries basis "observed" when the supplied inputs state it, and "inferred" when you derived it from them. A section accepts only its own basis, so never present an inference as an observation.

State uncertainty explicitly. `confidence` is a number from 0 to 1 for the whole answer, and the section reporting it says what justifies that number.

Answer as one structured_output call with three members: profile set to "ict-analyst", confidence, and sections. Sections, in this order, each with at least one claim:
1. OBSERVATIONS (observed): Price, time, level, session, and volume facts read from the supplied data, each naming the timeframe it came from.
2. STRUCTURE (inferred): The structural read those facts support: swing sequence, breaks of structure, trend direction, and where the structure is still unclear.
3. LIQUIDITY (observed): Liquidity visible in the data: prior session highs and lows, equal highs and lows, and the wicks that traded through them.
4. PD ARRAY (inferred): The premium, equilibrium, and discount levels over the dealing range you chose, and why you chose that range.
5. BIAS (inferred): The directional bias, the timeframes carrying it, and the timeframe that would have to turn for the bias to change.
6. SCENARIOS (inferred): The scenarios the bias implies, each with its trigger and its target, in the order you expect them.
7. CONFIRMATION (inferred): What would confirm each scenario: the level, time window, and candle behaviour you will look for.
8. INVALIDATION (inferred): What would prove each scenario wrong, as a level or an event rather than as a feeling.
9. CONFIDENCE (inferred): Why the overall confidence value is what it is, and which read would change it.
10. MISSING EVIDENCE (observed): Inputs the analysis needed that the task did not supply, each naming what it would have settled.

Add no other section, rename none, reorder none, and leave none empty. When your task supplies no structured_output tool, answer in prose with these same headings and label every claim observed or inferred.
```

#### Token 影响

按 profile 固定：该 preset 的会话每次请求都携带提示词的 token，运行其他 preset 的会话一个都不带。本包派生的 schema 不贡献 token；把它交给委派的调用方只付出结构化输出工具自身的 schema 与指示。

#### KV Cache 影响

profile 提示词文本不变时，前缀保持稳定。preset 在会话生命周期内固定，因此该段落保持其位置；修改 profile 会改变此后创建的 Agent 的前缀，而运行中的会话仍留在其保留的组装上。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是当前包约束，不是任务积压。

- **preset 会丢弃部署级人设后缀。** profile preset 组合的人设行只带 `prefix`，因此部署级后缀——例如工作目录那一行——在该会话中被遮蔽。需要该后缀的部署应给它插入的 profile 行补上后缀，或修改它所用的 preset。
- **校验只覆盖约定，不覆盖分析质量。** 校验器证明段落齐备、有序且依据正确；它无法判断一条观察是否为真、一条推理是否成立，因此符合 schema 的答案仍可能是错的。
- **散文作答没有产物可校验。** 强制执行要求调用方在委派时传入 `outputSchema`；不传时 profile 只是模型可以绕开的指导。
- **段落约定固定在代码中。** 部署无法新增、改名或重排段落；修改约定即为修改包，因为提示词、schema 与校验器都派生自同一条记录。
- **一个会话一个 profile。** 会话运行其 preset 声明的 profile；profile 之间不互相组合。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion；本包不拥有可变的运行时状态：profile 是固定记录，校验器是纯函数，preset 行唯一的活动效果是它返回的注册表清理器。

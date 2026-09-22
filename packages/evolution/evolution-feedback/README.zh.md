---
description: "按会话记录失败观测：把失败的工具结果记录、去重并汇总成学习回路可读的自然语言反馈（ctx.evolutionFeedback）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-feedback

[English](README.md) | 中文

## 概述

`dsh-evolution-feedback` 把失败的工具结果变成按会话持久化的观测，并汇总为学习回路所读取的自然语言反馈；此处不调用任何模型。它只记录其工具调用已被看见的失败 `tool/result`，重复出现时累加计数而不追加第二条，并按会话保留最新的 `maxEntries` 条。`summary` 按工具与消息合并多个会话，因此在四个会话各出现一次的故障排在单个会话重复四次之前；`signals` 在 `triggerReviewSessions` 个不同会话报告同一失败时触发复审。`reflectSignals` 把每个关键失败的纠正启发式写成结构化反思，`reflections` 按会话把反思读回，`reflect` 再把两半与任何 `recordReflection` 的阅读合并。

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

挂载本插件即可，观测无需额外接线。用 `entries` 读取单个会话的失败，用 `summary` 读取多个会话合并后的失败，用 `signals` 读取决策所消费的分级信号。

```ts
const failures = ctx.evolutionFeedback.summary(workspace.sessionIds, 10)
for (const failure of failures) {
  console.log(`${failure.tool ?? 'unknown'} ×${failure.count} (${failure.sessions} sessions): ${failure.message}`)
}
```

```ts
const signals = ctx.evolutionFeedback.signals(workspace.sessionIds, 10)
const decisive = signals.find(signal => signal.actionability === 'trigger_review')
```

```ts
const reflections = ctx.evolutionFeedback.reflect(workspace.sessionIds, 10)
for (const reflection of reflections) {
  console.log(`${reflection.symptom}: expected ${reflection.violatedExpectation} (confidence ${reflection.confidence})`)
}
await ctx.evolutionFeedback.recordReflection(reflections[0]!.failureId, {
  rootCause: 'the skill suggests a flag this shell lacks',
  correctedStrategy: 'probe the flag before using it',
})
```

```ts
const written = await ctx.evolutionFeedback.reflectSignals(10, new Date().toISOString())
const remembered = await ctx.evolutionFeedback.reflections(workspace.sessionIds, 10)
console.log(`${written.length} authored, ${remembered.length} retrievable: ${remembered[0]?.antiPattern ?? 'nothing stored'}`)
```

反思的分析字段在有人写下之前始终为空，因此读者绝不会把缺失的分析误当成测得的事实。输入中重复的会话标识只计数一次，未知的标识不报告任何内容。

`reflectSignals` 遍历存储自身的会话，已有反思的信号会被跳过，因此证据未变时第二趟不写入任何内容；`reflections` 是 §4.1「失败 → 解释 → 纠正启发式 → 事后检索」关联中的检索那一半，按会话报告最晚写入在前的已存反思，无论它是哪一趟写入的。此处不调用任何模型：写下的那一半只是围绕已观察失败及其复发情况的模板。

其 `tool/call` 从未被看见的失败结果记为空工具名；既无文本也无失败码的结果记为空消息——两者都是真实状态，而非错误。成功的结果不记录任何内容。`signals` 对分级后的汇总排序，因此关键信号不会被仅凭计数的条目挤出上限；`summary` 保持按计数排序。

### 配置

观测默认开启；每个字段都是可在 `cordis.yml` 中修改的、经过校验的 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-feedback'
  config:
    maxEntries: 50
    maxMessageChars: 300
    triggerReviewSessions: 3
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否观测失败的工具结果；无论开关如何，读取始终可用 |
| `maxEntries` | `100` | 每个会话保留的观测条数，最新在前 |
| `maxMessageChars` | `500` | 单条失败消息记录的字符预算 |
| `triggerReviewSessions` | `2` | 同一失败需被多少个不同会话报告才触发复审 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-feedback)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

每个会话在存储域 `evolution_feedback`（版本 `2`、布局 `per-record`、表 `records`）中占一条持久记录，以会话标识为键。记录持有该会话按最新在前保留的观测，以及其最后一次写入的时刻。第二张表 `reflections` 按失败合并键保存一份结构化反思中由分析者提供的那一半——根因、纠正策略、适用条件、反模式与候选测试——以及其最后一次分析写入。观测是派生状态：插件启动时不重建任何内容，因此宿主重启只是停止观测已经结束的会话，并接着观测之后的会话。

一条观测以"工具 + 消息"为键。重复出现会让 `count` 加一、把该条移到最前，并让先前那条不再保留，因此一个反复撞上同一故障四十次的会话只留一条、计数为四十。

### 反思撰写

`reflectSignals` 仅凭台账为关键失败撰写分析那一半。纠正策略就是观察到的复发事实——原样重试该调用会重现同一失败；适用条件与反模式把这种误用连同其触发条件一起写出；候选测试就是 §21 要求的回归用例。`rootCause` 与 `whatWorked` 保持为空，因为模板无法命名原因、也看不见已经奏效的部分；`recordReflection` 仍是分析者陈述这两项的方式，它合并到撰写出的那一半之上而不会将其清空。

置信度衡量失败背后的证据（§20）：当失败调用从未被观测到时为 0.25，否则四分之三取 `triggerReviewSessions` 个不同会话的占比，四分之一取每会话观测数相对同一阈值的占比。因此独立支持占主导，同一会话内反复出现同一失败无法替代第二个会话。

### 写入顺序

同一步骤的工具结果会一起到达，因此朴素的"先读后写"会与自身竞争并丢失观测。于是每个会话独占一条写入链：一条记录排在该会话上一次写入之后，因此单条观测内部的先读后写决策绝不会与另一条重叠。该链在作为队尾落定后即删除自己的映射项，因此不再失败的会话不会留下任何残留。

### 失败与恢复

无效记录会让域打开时大声失败：丢失 `count` 会悄悄改变学习回路认定何者为主的结果。存储启动前的读取会抛错。无法落盘的写入只记录一条警告并丢弃该条观测，而不会作为会话错误浮现。

不发布 invariant 伴生包：域表是这份状态的唯一副本，不存在可供核对的第二个独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md)——自学家族背后的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [`dsh-evolution-reviewer`](../evolution-reviewer/README.zh.md)——从同一回合流中提炼经验的同类观察者。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-feedback)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无：本存储不注册任何模型可见内容。

#### KV Cache 影响

此处没有任何东西进入模型请求，因此 provider 缓存复用不受影响。把已记录失败渲染进提示词的消费者自持该请求的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本存储不适合的场景。它们是当前包约束。

- **仅限工具失败**——用户纠正、部分成功与非工具类失败都不会被观测；只有被标记为错误的 `tool/result` 才会记录内容。
- **每会话一条记录且从不清理**——单个会话自身的观测有上界，但域会为每个曾经失败过的会话保留一条记录。
- **观测不追溯**——只记录插件挂载期间投递的事件；挂载之前就已失败的会话不可见。
- **工具名是尽力而为**——`tool/call` 未被看见、或在其回合结束之后才到达的结果，记为空工具名。
- **消息是裁剪而非摘要**——过长的失败只保留前 `maxMessageChars` 个字符，因此两条不同的长失败可能在同一条上相撞。
- **根因需要作者**——`reflectSignals` 从证据撰写纠正的那一半，但 `rootCause` 与 `whatWorked` 保持为空：模板无法诊断原因，因此 `recordReflection` 仍是分析者阅读的路径。
- **反思按会话检索**——只有当调用方给出的会话确实报告过该失败时，`reflections` 才会报告对应反思，而本包不向调用方枚举存储中的会话；调用方无法命名的会话，其反思也就取不到。
- **仅存于本机**——记录位于 `$DSH_HOME` 之下，绝不写入项目目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

`summary` 只用于整理器的观测提示与 dreaming 的 light 阶段展示，真正把 `signals` 变成决定的是整理器趟次：可归因的失败会把它所关联的技能降级。该消费者设置 `triggerReviewSessions`；默认值 2 避免单个坏会话就降级一个技能。

`reflectSignals` 是唯一无需分析者驱动的反思写入路径，因此定时任务可以调用它，之后的检索读取它所存下的内容；`dsh-evolution-curriculum` 是第一个生产消费者，它把缺口证据匹配到已存症状，并把 §21 的反模式与候选测试带进暂存的提案。

</details>

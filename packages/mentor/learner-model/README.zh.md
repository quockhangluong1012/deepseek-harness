---
description: "每个学习者一份的持久记录：概念知识、应用能力、误解、重复性错误、信心、案例历史，以及下一步学习目标（ctx.learnerModel）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-learner-model

[English](README.md) | 中文

## 概述

`dsh-learner-model` 为每个学习者保存一份持久记录：学习者在谈论概念时表现出的熟悉度、评分过的应用所测得的能力、误解与错误及其复发次数、自述的信心、评审过的案例，以及下一步学习目标。记录以稳定的学习者 id 为键，因此能跨会话边界存活。自述熟悉度与应用掌握度是两份互不合并的条目列表，每次写入都带上其内容来源的信任标签。这里不调用模型。

## 目录

- [使用本包](#use-this-package)
- [如何区分两个轴](#reading-the-two-axes)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将插件与存储域一起挂载，并用部署方自己拥有的稳定 id 指向一个学习者——用户 id、账号 id，任何比会话活得更久的值。

```ts
const learner = LearnerId('user-1')
const concept = ConceptId('pd-array-pip')

await ctx.learnerModel.recordConcept(learner, {
  conceptId: concept,
  familiarity: 0.8,
  observations: 3,
  trust: 'trusted',
})
await ctx.learnerModel.recordApplication(learner, { conceptId: concept, succeeded: false, trust: 'trusted' })
const axes = ctx.learnerModel.axes(learner, concept)
```

读取是同步的，并且与存储分离：`read(learnerId)` 返回整条记录（尚无记录的学习者得到一条 `updatedAt: null` 的空记录），`axes(learnerId, conceptId)` 返回某个概念的两个知识轴，`misconceptions`、`mistakes`、`objectives` 返回对应列表，`applicationMastery(entry)` 推导出应用成功率。

写入是持久的，并返回更新后的记录。`recordConcept` 替换该概念的自述熟悉度及其观察次数；`recordApplication` 增加一次评分应用并累加 `attempts`/`successes`；`recordConfidence` 替换学习者的自述信心；`recordMisconception` 计入一次检出，并把已解决的信念退回 `detected`；`setMisconceptionStatus` 迁移一个已知信念的状态；`recordMistake` 计入一次发生并合并它涉及的概念；`setObjectives` 替换目标列表，同一 id 上继续存在的目标保留其原始时间点；`applyCase` 按案例引用就地写入一条案例历史条目。

### 配置

无。记录结构由域声明固定，部署相关的值都通过调用方提供的证据条目进入存储。

### 可观察行为与失败

存储启动前读取会抛错。每次写入在落库前都通过域记录 schema 校验，因此超出 `[0, 1]` 的熟悉度或未知的信任标签会在这里被拒绝，而不是等到下一次域打开才失败。已存记录不再匹配 schema 时，打开会以 `invalid-record` 明确失败——这是权威状态，因此存储不会把它备份后跳过。`setMisconceptionStatus` 作用于未知信念时按 id 报错，被拒绝的写入不会改动记录。

-----

<a id="reading-the-two-axes"></a>
## 如何区分两个轴

2.0 evolution spec 的 §12.8 禁止把概念熟悉度等同于应用掌握度，因此记录把二者分开保存，调用方按字段区分，而不是按判断区分：

| 问题 | 读取 | 字段 |
|---|---|---|
| 学习者在谈论该概念时表现出了什么？ | `axes(learnerId, conceptId).concept` | `familiarity`（0 到 1）及其背后的 `observations` 次数 |
| 学习者在实际应用时表现出了什么？ | `axes(learnerId, conceptId).application` | `attempts`、`successes` 与 `applicationMastery` |

`conceptKnowledge` 与 `applicationAbility` 是按概念 id 键控的两份独立列表；只有 `recordApplication` 写应用轴，只有 `recordConcept` 写自述轴，二者互不读取。想判断学习者能否应用该概念的调用方读取 `application`，并把 `concept` 当作学习者自己的看法。`application` 在至少一次应用被评分前为 `undefined`：未测量的轴不是零。`confidence` 是第三个独立读数——学习者对自己掌握程度的说法——任何变换都不会把它并入上面任一轴。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计要点

- **每个学习者一条持久记录。** `learner_model` 域持有一张以学习者 id 为键的 `learners` 表，因此会话在记录中途结束不会改变状态所在的位置（§27 Mentoring：学习者状态跨会话持久）。
- **两个轴，分开保存。** `conceptKnowledge` 与 `applicationAbility` 是独立列表、独立变换。应用列表存储 `attempts` 与 `successes`；比值由 `applicationMastery` 在读取时推导，因此存储的分数永远不会与其背后的计数不一致。
- **复发是计数的，不是推断的。** 同一 `misconceptionId` 或 `mistakeId` 被再次检出时递增计数并追加来源案例引用，因此复发情况与案例出处无需调用方重放历史即可保留。
- **信任随条目同行。** 每个条目存储其内容来源的 `TrustLabel`，因此由不可信材料推导出的内容在其被读取的任何地方都保持标注（RUNTIME-SPEC S11）。
- **写入要么整体落库，要么完全不落。** 每个变换在域的写链槽位上对当前记录执行，并在落库前通过域 schema 校验，因此并发写入不会交错，超出约定的值也不会到达介质。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`LearnerModel`、id 工厂，以及记录读取 |
| [`src/types.ts`](src/types.ts) | 记录、其条目类型，以及调用方提供的证据类型 |
| [`src/spec.ts`](src/spec.ts) | 域声明、记录 schema、持久 id 与信任形式 |
| [`src/record.ts`](src/record.ts) | 纯记录变换与轴读取 |

### 不发布 invariant 伴随包

本包不发布运行时 invariant 伴随包，因为域表是本状态的唯一副本：没有第二个独立观察可供对照，而 `domain/changed` 事件与记录 schema 已覆盖 invariant 会断言的内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §12.8 与 §27——本记录所回应的学习者属性清单与辅导准则。
- [存储子系统](../../../docs/subsystems/storage.zh.md)——记录所经由的域契约。
- [`dsh-storage-domain`](../../storage/storage-domain/README.zh.md)——这里每次写入都依赖的表、写链与 schema 校验语义。
- [`dsh-case-store`](../../research/case-store/README.zh.md)——`applyCase` 记录其评审摘要、并由 `forLearnerMemory` 提供给本记录的案例工件。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本存储在 `ctx.learnerModel` 之后保存宿主侧持久状态，不注册任何工具、提示词或会话事件；读取该记录的辅导包负责其任何模型可见的呈现。

#### KV Cache effect

这里没有任何内容进入模型请求，因此 provider 的缓存复用不受影响。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制说明记录在什么情况下不合适。它们是本包当前的约束。

- **概念 id 是不透明字符串** —— 存储记录调用方传入的任何 id，且不持有目录，因此同一概念的两种拼写会静默变成两条条目。目录属于教授这些概念的包。
- **存储从不判定掌握** —— 它记录尝试、成功与熟悉度；把记录的比值变成关于学习者的结论的那条门槛，属于读取它的辅导逻辑。
- **信心每个概念只保留一条读数** —— 更新的说法替换旧的，因此学习者信心的变化轨迹只能从案例历史中还原。
- **目标是替换而非版本化** —— `setObjectives` 存储当前列表并保留继续存在的目标的原始时间点；被移除的目标不留下曾被提出的记录。
- **这里不做清理** —— 已解决的误解与不再复发的错误都留在记录中，想要近期状态的消费者需自行按 `updatedAt` 或 `lastAt` 过滤。
- **一个作用域一个学习者，没有名册** —— 读取只接受一个学习者 id；没有跨学习者的查询、聚合或列举。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

写入会先读表再决定怎么写：已有记录的学习者通过 `update` 变换，该变换在域的写链槽位上执行；尚无记录的学习者则存入空记录变换后的结果。变换作用于写链槽位持有的记录，而不是调用方可能读到的副本，因此同一学习者的两次写入不会丢失任何计数。每个变换的结果在 `put`/`update` 落库前都会通过 `learnerRecord.parse`：域只在打开时校验已存记录，若没有这一步，超出 schema 的调用方取值会被写入、被每个消费者读到，直到下次进程启动才失败。

</details>

---
description: "每个学习者一份的持久 ICT 案例研究工件：§21 字段集合、观察与解读分离、证据按引用保存，以及面向四类消费者各自的读取路径（ctx.caseStore）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-case-store

[English](README.md) | 中文

## 概述

`dsh-case-store` 持久保存 §21 的 ICT 案例研究工件——标的、周期、观察、用户论点、证据、智能体审计、魔鬼代言人、备选情景、结果、错误、教训、受检概念与学习者影响——每个学习者一条记录，因此案例比产生它的会话活得更久。观察字段保存图表呈现的事实，每条解读引用它所读取的观察，二者因此不会混淆；内核证据引用只携带证据 id。四条读取路径分别服务于学习者模型、误解检测、基准数据集与下一次辅导干预。这里不调用模型。

## 目录

- [使用本包](#use-this-package)
- [观察与解读](#observations-and-interpretations)
- [证据按引用保存](#evidence-by-reference)
- [四条读取路径](#the-four-read-paths)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将插件与存储域一起挂载，为某个学习者打开一个案例，随后在评审过程中不断修订。案例 id 由存储生成。

```ts
const opened = await ctx.caseStore.createCase(LearnerId('user-1'), {
  symbol: 'EURUSD',
  timeframes: ['D1', 'H1', 'M5'],
})
const reviewed = await ctx.caseStore.amend(LearnerId('user-1'), opened.caseId, {
  observations: [{
    observationId: ObservationId('obs-1'),
    statement: 'D1 closed above the PD array high',
    timeframe: 'D1',
    evidence: [EvidenceKey('ev-1')],
    trust: 'trusted',
    observedAt: '2026-03-11T00:00:00.000Z',
  }],
  agentAudit: [{
    interpretationId: InterpretationId('audit-1'),
    kind: 'audit',
    statement: 'MSS is not a standalone entry trigger',
    basis: [ObservationId('obs-1')],
    trust: 'trusted',
    at: '2026-03-11T04:10:00.000Z',
  }],
  conceptsTested: [ConceptId('mss-entry')],
})
const record = ctx.caseStore.get(LearnerId('user-1'), opened.caseId)
```

`createCase(learnerId, { symbol, timeframes })` 打开记录，其余字段为空且尚无结果。`amend(learnerId, caseId, amendment)` 应用被点名的字段：每个数组追加其条目，同一标识的条目就地替换，受检概念取并集，未在修订中点名的字段保留已有值。`get(learnerId, caseId)` 与 `cases(learnerId)` 读取单条记录或某个学习者的记录。

### 配置

无。工件的字段集合由规范固定，作用域与标识规则由域声明规定。

### 可观察行为与失败

存储启动前读取会抛错。对本学习者并不持有案例调用 `amend` 会被拒绝：该案例在此作用域内不存在，其余内容不会被改动。每次写入在落库前都通过工件 schema 校验，因此超出 schema 的条目——未知字段、缺少 `basis`、与所在字段不一致的 `kind`——会在这里失败，而不是等到下一次域打开。已存记录不再匹配 schema 时，打开会以 `invalid-record` 明确失败，因为每条读取路径都会把读到的内容交给据此行动的消费者。

-----

<a id="observations-and-interpretations"></a>
## 观察与解读

规范的研究规则禁止把观察与对它的解读混为一谈，因此这里的分离是结构性的，而非文风上的：

| 字段 | 保存 | 携带 |
|---|---|---|
| `observations` | 图表呈现的事实，以及读取它所用的周期 | 它读取所用的 `evidence` 键 |
| `agentAudit`、`devilAdvocate`、`alternativeScenarios` | 对这些观察的解读 | `basis`：该解读所依据的观察 id |
| `userThesis` | 学习者提出的主张 | 该主张自身的时间点 |
| `mistakes`、`lessons` | 评审发现的内容 | `basis` 观察 id 及其涉及的概念 |

观察条目没有 `basis` 字段，也不会获得一个：工件是严格 schema，携带解读结构的观察会被拒绝。解读始终引用 `basis`；空的 basis 表示一条没有依据的解读记录，而不是一条观察。解读上的 `kind` 表明这是谁的解读——`audit`、`devil-advocate` 或 `scenario`——且它必须与所在字段一致，因此批评不可能落进 `agentAudit`。

-----

<a id="evidence-by-reference"></a>
## 证据按引用保存

`evidence` 保存引用，从不保存内容。在会话内观察到的条目只携带内核的证据 id，别无其他，因此案例不会与它所引用的观察发生偏移：

```ts
{ evidenceKey: EvidenceKey('ev-1'), kind: 'kernel', evidenceId: EvidenceId('ev-1') }
```

会话之外阅读的图表或回测没有内核记录，因此改为记录位置，并带上该位置所指内容的信任标签：`{ evidenceKey, kind: 'external', locator: 'backtest-2024-03.csv', trust: 'untrusted' }`。观察通过 `evidence` 引用这些键，因此读者能分辨某条观察来自哪个条目，而案例本身并不保存该条目。

其余每个条目都携带自己的 `trust` 标签，因此由不可信材料推导出的内容在其被读取的任何地方都保持标注（RUNTIME-SPEC S11）。

-----

<a id="the-four-read-paths"></a>
## 四条读取路径

| 消费者 | 读取 | 投影 |
|---|---|---|
| 学习者记忆 | `forLearnerMemory(learnerId)` | 要记到学习者身上的评审摘要：标的、结果、受检概念、错误、教训、学习者影响 |
| 误解检测 | `forMisconceptionDetection(learnerId)` | 学习者提出的主张、智能体审计、魔鬼代言人的批评，以及发现的错误 |
| 基准数据集 | `forBenchmarkDataset(learnerId?)` | 每个案例一行（省略作用域时为全部学习者），携带完整工件 |
| 下一次辅导干预 | `forMentorIntervention(learnerId)` | 发生了什么、案例检验了哪些概念、学习者如何变化，以及可教学的教训 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计要点

- **每个学习者作用域内的案例一条记录。** `ict_case` 域持有一张 `cases` 表，键为学习者 id 加案例 id，因此同一案例 id 在两个学习者下就是两条记录，一个学习者永远读不到另一个的案例。
- **工件恰好是 §21。** 工件 schema 是对那十三个字段的严格对象；存储自身的标识与时间点位于它外层的记录信封中，而不在工件里。
- **修订按标识追加。** 每种条目类型都带自己的 id，因此重复应用同一份评审会就地替换它已写入的条目而不影响同级条目，案例不会积累重复发现。
- **每条读取路径服务一个消费者。** 四个投影是独立方法，而不是一次全量导出加过滤，因此每个消费者的契约在其被服务之处可见，将来的作用域变化也不会悄悄改变某个消费者收到的内容。
- **写入要么整体落库，要么完全不落。** 修订在域的写链槽位上对当前记录执行，结果在落库前通过记录 schema 校验，因此并发修订不会交错，超出约定的工件也不会到达介质。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`CaseStore`、id 工厂、四条读取路径 |
| [`src/types.ts`](src/types.ts) | 工件、其条目类型、修订类型与投影 |
| [`src/spec.ts`](src/spec.ts) | 域声明、工件与记录 schema、持久 id 形式 |
| [`src/artifact.ts`](src/artifact.ts) | 纯工件变换：打开空工件与应用一次修订 |

### 不发布 invariant 伴随包

域表是本状态的唯一副本，没有第二个独立观察可供对照。记录 schema 与 `domain/changed` 事件已覆盖 invariant 会断言的内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §12.6、§12.7 与 §21——本工件所承载的分析师与魔鬼代言人输出契约，以及它所固定的案例字段。
- [存储子系统](../../../docs/subsystems/storage.zh.md)——案例所经由的域契约。
- [`dsh-learner-model`](../../mentor/learner-model/README.zh.md)——本包复用的标识与信任词汇的归属者，以及学习者记忆读取所供给的 `applyCase` 写入。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本存储在 `ctx.caseStore` 之后保存宿主侧持久状态，不注册任何工具、提示词或会话事件；渲染案例的消费者负责其任何模型可见的用途。

#### KV Cache effect

这里没有任何内容进入模型请求，因此 provider 的缓存复用不受影响。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制说明案例存储在什么情况下不合适。它们是本包当前的约束。

- **工件不能在本地扩展** —— schema 对 §21 的十三个字段是严格的，因此需要额外字段的部署必须改动规范与域版本，因为多余字段在写入和打开时都会被拒绝。
- **不对 `basis` 与 `evidence` 做引用校验** —— 解读可以引用案例中并不存在的观察 id，观察也可以引用从未记录过的证据键；存储保留引用，但不校验它。
- **定位符不是内容** —— 外部证据条目记录去哪里看；解析它、以及发现它已失效，属于读者的责任，存储也永远不会察觉某个内核证据 id 已经消失。
- **约定是结构性的，不是语义性的** —— 没有任何逻辑检查观察的 statement，因此写进 `observations` 的解读会留在那里；schema 让正确的字段显而易见，却无法让调用方诚实。
- **`outcome` 只替换，不清空** —— 修订可以记录或覆盖结果，但误判为已解决的案例无法通过 `amend` 回到 `null`。
- **不能删除条目** —— 被取代的观察、发现或解读只能通过写入同 id 的另一条条目来替换；被撤回的条目仍会留下。
- **作用域是单个学习者** —— 只有 `forBenchmarkDataset` 会读取单个学习者作用域之外的数据，且没有任何读取按时间、标的或概念过滤。
- **记录不保存会话引用** —— 案例记录学习者与评审，而不记录产生它的会话或运行，因此若要归属到某份对话记录，需由调用方自行保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

表键是学习者 id、一个 NUL 分隔符与案例 id（`storageKey`）。该分隔符不可能出现在任一品牌化 id 中，因此任何一对 id 都不会与另一对冲突，作用域完全由键决定：学习者 B 对学习者 A 的案例调用 `amend` 会指向一个不存在的键，并以域的 `missing-key` 被拒绝，而不会触达 A 的记录。无作用域的 `forBenchmarkDataset()` 遍历全部记录，先按学习者、再按创建时间点、最后按案例 id 排序，因此由它构建的数据集在多次运行间是确定性的。

修订在 `table.update` 内应用，因此变换看到的是写链持有的记录，而不是调用方可能读到的副本，两次并发修订不会丢掉对方的条目。落库的是解析后的记录：域只在打开时校验已存记录，若没有这一步，超出 schema 的调用方取值会被写入、被每个消费者读到，直到下次进程启动才失败。

</details>

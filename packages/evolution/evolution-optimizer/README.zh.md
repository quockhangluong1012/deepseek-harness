---
description: "最小离线技能优化：按触发门控经 Host LLM 变异、在隔离 DSH_HOME 覆盖层下经评分器评估、Pareto 选中、分选技能补丁（ctx.evolutionOptimizer）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-optimizer

[English](README.md) | 中文

## 概述

离线搜索更好的 SKILL.md 正文：传入技能、语料场景与分选身份，这次运行就从你配置的变异算子中取候选，先在短子集上筛选、再在隔离的 `DSH_HOME` 覆盖层下评分，检查私有 holdout，用重复的成对比较确认优胜者，并把击败基线的 Pareto 优胜者分选出来——排序先看成本，再看它与技能已记录的新颖度档案有多远。它按需运行，绝不在每轮路径上，每个选中的算子都要一次模型调用，并需要一份练到该技能的语料。没有任何东西直接写技能：批准分选条目才算落地。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

以技能、语料场景与分选身份调用 `optimize`：

```ts
const report = await ctx.evolutionOptimizer.optimize({
  skill: 'writer',
  scenarios: ['draft-turn', 'revise-turn'],
  scopeId,
  originSessionId: String(session.id),
  signal: invocation.signal,
})
if (report.status === 'staged') console.log('staged as', report.stagedId)
```

### When to choose it

遥测已 flag 某技能（见 [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md) 的 `shouldOptimize`）且语料中有覆盖它的场景时，选择本包。优化器离线且手动——只在 `/curator optimize` 运行时运行，永不上每 turn 路径。问题只是度量时用评分器；需要对整个技能包（而非单个 SKILL.md 正文）做裁决时用整理器的 consolidation。

### 在 profile 中挂载

Web 组合里带有本行与评分器的行，但[默认关闭](../../bundle/web-app/cordis.patch.yml)，因为两者都需要只有部署才知道的值：录制场景所在目录，以及每次尝试所启动的 agent 组合——具名 profile、它叠加的补丁、源 bin 与仓库 tsconfig。[`apps/cli/config/examples/evolution-optimize/cordis.yml`](../../../apps/cli/config/examples/evolution-optimize/cordis.yml) 就是用一份检出自身的语料把两者打开的覆盖层；用 `--patch` 应用它，或把其中各行拷进某个 profile 的 `cordis.patch.yml`。经由真正的 `dsh` 入口启动的尝试需要 `agent.profile`：没有它时启动器只传配置文件本身，而那只有自带配置语法的 bin 才接受。

### Configuration

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-optimizer)是每个可接受字段的穷尽来源。

```yaml
- id: evolution-optimizer
  config:
    maxCandidates: 3
    provider: deepseek-official
    model: deepseek-flash
    agent:
      binScript: /path/to/repo/apps/cli/src/bin.ts
      configPath: /path/to/repo/snapshots/acp/escalation-approved/cordis.yml
      profile: acp
      tsconfigPath: /path/to/repo/tsconfig.json
```

| Field | Default | Meaning |
|---|---|---|
| `maxCandidates` | `3` | 每次运行的变异候选数 |
| `maxInputBytes` | `16384` | 单次变异请求的字节预算 |
| `maxOutputTokens` | `2048` | 单次变异请求的输出 token 上限 |
| `provider` | `required` | 变异请求的 provider 路由 |
| `model` | `required` | 变异请求的模型 id |
| `triggerMinUses` | `20` | 失败率生效所需的已记录负载数 |
| `triggerFailureRate` | `0.3` | 记录必须超过的失败占比，0..1 |
| `holdoutScenarios` | `[]` | 保留给晋级检查的语料场景，搜索期间永不评分 |
| `budgetTokens` | `0` | 一次运行可用于候选评分的计费 token；`0` 表示不设上限 |
| `budgetWallTimeMs` | `0` | 一次运行可用于候选评分的墙钟毫秒；`0` 表示不设上限 |
| `screenScenarioCount` | `0` | 每个候选先被筛选的场景数，幸存者再做完整评分；`0` 关闭筛选 |
| `operators` | `['rewrite']` | 本次运行取候选的变异算子，按请求顺序 |
| `confirmationRuns` | `1` | 一次晋级必须赢下的成对「优胜者-基线」比较次数 |
| `skipRepeatedExperiments` | `true` | 拒绝假说完全相同、且已有记录结果的运行；设为 `false` 会再次为同一搜索付费 |
| `stagnationWindow` | `5` | 多少次未晋级的已评估运行算该技能停滞并切换变异阵容 |
| `priorMinTries` | `3` | 在同一失败签名下，一个算子需要多少次产出候选的运行，其记录才开始影响阵容顺序 |
| `maxExperiments` | `200` | 每个作用域保留的实验数，最新优先 |
| `experimentPageSize` | `20` | 单次读取返回的实验数，最新优先 |
| `agent.binScript` | `required` | 变体尝试启动所用的源 bin 入口 |
| `agent.configPath` | `required` | 该入口加载的基础配置或 profile 补丁 |
| `agent.profile` | 未设 | 每次尝试启动所用的具名 profile；只要 bin 是真正的 `dsh` 入口就必须设置 |
| `agent.tsconfigPath` | `required` | 解析未构建 workspace 导入的仓库 tsconfig |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-optimizer)是每个可接受字段的穷尽来源。

### 变异算子

只有一个提示词作为唯一变异机制会收敛到同一种改写风格，因此一次运行可以从一个算子组合中取候选。内置算子是 `rewrite`（清晰度与顺序）、`compress`（在保留证据指向的每条规则的前提下最短正文）、`guard`（补上缺失的前置条件、拒绝或校验）与 `exemplify`（每条被证据指向的规则配一个实例）。`operators` 按请求顺序列出要用的 id；未知 id 在加载时失败。

`maxCandidates` 仍是本次运行的候选总数：预算在所选算子间均分，靠前的算子领余数，因此 `maxCandidates: 2` 配 `['rewrite', 'compress']` 是各一次调用。每个算子都是一次独立的模型调用，所以在候选数相同的情况下算子越宽调用越多；默认 `['rewrite']` 保持历史上的单次调用形态。两个算子返回同一正文时只贡献一个候选，记在靠前的算子上；分选证据中点名产出优胜者的算子。

每个候选在评分之前都要经过与 `skill_manage edit` 相同的那条落盘不变式——可解析的 frontmatter 且保留技能自身的名称与路由描述——检查由 scorer 的 `checkBehaviorContract` 执行，因此该不变式只有一处实现，同时服务于写入路径、行为门与这条循环。会破坏技能的正文无法落地，因此它不算候选：它不会换来一次全新进程上的评分。请求本身会声明这一要求，让模型照做而不是白付拒绝的代价；若所有候选都被拒绝，运行报告 `no-improvement`，并说明被拒绝的数量与原因。

### 晋级置信度与实验台账

- **`confirmationRuns` 把一次好比较变成可重复的比较。** 搜索阶段已经赢过基线一次；此后每一轮都在全新进程下把基线与优胜者作为一对再评一次，只有优胜者赢下每一对才允许晋级。输掉一对的优胜者会被拒绝，返回 `status: 'unconfirmed'` 并记录 `confidence: { runs, wins }`，因此一次随机意义上的胜利无法仅凭单次读数晋级。额外的成对比较与搜索共用同一套 `budgetTokens` / `budgetWallTimeMs` 上限。
- **凡是走到评估阶段的运行都会成为作用域 `evolution_experiments` 域中的一行持久记录**：证据文本、产出候选的算子、搜索与 holdout 场景、基线与优胜者三元组、置信度计数、结果、原因、创建分选条目时的 staged id、provider 与模型、挂载 scorer 本次测量所用的评分语义版本、被晋级正文相对起始正文的新增与删除行数、被晋级正文参与排序时的新颖度档案读数（`winnerArchiveNovelty`，未晋级时为 `null`），以及运行起始正文与被晋级正文的 SHA-256——足以让读者看出这次挑选由哪些轴决定。正文本身不落盘，由摘要标识；改动有多大由计数说明。`/curator experiments` 在晋级的行上把计数打印为 `+added/-removed`。
- **已批准的晋级是下一位优胜者必须越过的下限。** 在分选任何内容之前，本次运行会查该技能已记录的**最强且已获批准**的晋级，并只在两者于同一批场景、同一路由、同一尝试次数与同一 scorer 版本下测量过时与之比较——来自其他配置的三元组说明不了本次配置的任何事。scorer 一换版，它测出的所有下限即退役：旧行仍可读，但任何新优胜者都不会被来自另一个评估器的数字拒绝。被已批准结果支配的优胜者会被拒绝，返回 `status: 'regressed'` 并在报告中点名该下限（`floor: { triple, stagedId, at }`），因此一个越过了当下基线、却倒退了一项已接受改进的改动，绝不会以推荐的形式到达人类面前。
- **已决的实验不会再跑第二遍。** 若一次运行的假说——同一技能、同一证据文本、同一批场景、同一算子阵容、同一起始正文、同一路由、同一 scorer 版本——已有记录在案的结果，就在任何模型调用之前返回 `skipped`，并点名那次较早的运行及其裁决。台账记住的是一个假说，所以技能正文变了、证据文本变了、路由变了或 scorer 换版了都是新实验；从未走到评估的运行不会被记住，因为重跑它才是拿到它没能给出的答案的唯一办法。`skipRepeatedExperiments: false` 可关闭这一拒绝。
- **新颖度会被测两次，两个读数都参与排序。** 每个候选正文都会与该次运行的起始正文相比较：`novelty` 是它那些互异指令行中起始正文尚未包含的比例——开头 frontmatter 会被剔除，因为每个候选都会照抄它——大小写与空白折叠、忽略行序，因此重新排版或重新排序记为 0，而技能从未声明过的规则记为一个真实比例。随后它的描述符会与技能已记录的档案（`ctx.evolutionNovelty.entries(skill)`，每次运行只取一次快照）比对：`archiveNovelty` 是「1 减去它与任一档案条目的最大 Jaccard 相似度」，因此它衡量的是这个候选距离技能已经分选过的所有正文有多远，且跨越多次运行。两个读数都出现在报告的每个候选上，而选择时把档案新颖度排在正文新颖度之前，作为「成本之下、墙钟时间之上」的并列打破依据，同时作用于筛选切分与优胜者挑选：在测得相同的候选之间，走向前沿尚未走过之处的那个，正是让搜索不再重新推导技能早已是过的正文的那个；其下，说出相对本次正文的新东西的那个才会改变技能的行为。支配关系仍然说了算——不击败基线的候选绝不会凭新颖度被选中——而档案为空或未挂载时，每个候选都读到 `archiveNovelty: 1`，排序便只由成本、正文新颖度与变异顺序决定。
- **在这个失败上只会复述正文的算子排到最后。** 台账记录哪些算子至少产出了一条「说出新内容」的候选（`novelOperators`），失败面把它记为算子的「新鲜度」。在这里从未赢过的算子中，说过新东西的排在只会重复技能既有内容的之前——重复一个正文无法修好它已经失败过的失败——而在只会重复的算子之间，试得更多者仍在前。这就是 §31 在这套系统里能真正作用的压力：单次运行的优化器无法二次奖励候选，但它可以不再从那个一直「什么都不说」的算子里反复抽取。
- **台账按「过去什么修好了这个失败」来排序阵容。** 一次运行会读取台账里针对它所处理的失败的记录——证据文本中每一段数字都折成单个 `#`，因此不同读数之间会变化的计数器不会把一个失败模式拆成许多个——并按算子统计「有多少次运行用它产出了候选」与「有多少次运行晋级的是它产出的候选」。在这个失败上赢过的算子排在阵容最前，这个失败从未见过的算子按配置顺序跟随，而只在这里输过的算子排在最后；并列时回落到配置顺序。该顺序决定谁拿走候选预算的余数——`maxCandidates` 正是按阵容顺序切分的。`priorMinTries` 是证据下限：低于它，算子在该失败上等同于从未见过，因此一次侥幸的胜利无法改变任何顺序。
- **停滞的技能换打法，而不是重复自己。** 最近 `stagnationWindow` 次已评估运行全都没有晋级时，该技能被报告为 `stagnant: true`，本次运行只从该窗口内没有产出候选的算子中抽取候选——那是一套尚未在这个失败模式上失败过的阵容。当配置里的每个算子都已在该窗口内试过，多样性已耗尽，就沿用配置阵容。
- **台账可读且有界。** `experiments(scopeId, { skill, limit })` 按最新优先返回，`/curator experiments [skill]` 打印它们，每个作用域保留 `maxExperiments` 行，新行落地时丢弃更旧的行。写入台账失败会在 host logger 上报告，绝不会把已经发生的晋级变成错误。

-----

<a id="use-this-package"></a>

选择只看调用方点名的场景，因此优胜者是在与变异同一批语料上选出的。三个配置旋钮防止这变成过拟合并失控的成本：

- **`holdoutScenarios`**——搜索永不评分的语料场景。任何内容被分选前，优胜者与基线都会先在其上评分，若基线在那里支配优胜者则拒绝（`status: 'holdout-rejected'`，不分选任何内容）。holdout 放在插件配置而非请求里是有意的：能点名 holdout 的调用方，也能丢掉一个没通过的场景。而该技能自己的台账已记录为搜索过的 holdout 场景，会在运行任何东西之前被拒绝：选出过早期优胜者的任务已经塑造了这个技能，它不再是干净的测试，改配置也洗不白它。
- **`budgetTokens` / `budgetWallTimeMs`**——一次运行可为候选评分买下的上限。越过上限后循环在下一轮完整评估前停止并报告 `truncated: true`；搜索仍在已评分的候选间选择，而在评分任何候选前就花完预算的运行返回 `skipped`，而不是靠猜去分选。
- **`screenScenarioCount`**——逐次减半。每个候选先在前 N 个搜索场景上评分，较优的一半幸存（先看通过状态，再看 token，再看墙钟），只有幸存者跑完整场景集。即使设了预算，筛选也会对每个候选执行，因此幸存者始终在同一子集上排序。

两份场景列表在任何模型调用之前校验：任一列表内部重名，或同时出现在两份列表中，都会直接抛错而不是继续运行。台账也一样检查——该技能搜过的名字出现在 holdout 里就抛错——因此污染在最早能确定的点大声失败。跨运行复用场景做搜索仍是常规做法；被拒绝的只是把搜索历史提拔成 holdout。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/pareto.ts` 是纯选择器：（pass、token、wallTimeMs）上的支配关系、非支配前沿、筛选晋级的幸存者切分（按成本、档案新颖度、正文新颖度、墙钟时间依次排序），以及必须先支配重评基线、再由同一组轴排序的优胜者。`src/mutate.ts` 拥有算子组合，并为每个算子组织一次请求（该算子的指令加字节预算，预算只砍证据不砍技能正文），把 JSON 数组作答解析为互异正文——随后 `src/index.ts` 会逐个送进 scorer 的 `checkBehaviorContract`，因此无法落地的正文在换来一次评分之前就被拒绝。`src/evaluate.ts` 把每个正文分选进全新的 `DSH_HOME` 覆盖层，经 `evolutionScorer.evaluateSkill` 以把覆盖层 home 叠入尝试环境的 runner 评分；评分落定即删除覆盖层。`src/surface.ts` 是失败面：一段证据文本折算成的签名、某作用域的台账行针对它持有的按算子尝试与获胜计数，以及该先验强加给阵容的顺序。`src/experiments.ts` 是台账词汇：持久行模式、保留策略、分页读取、实验键与重复查找，以及重复拒绝时引用的措辞。`src/index.ts` 编排：场景校验、依台账选择策略、重复拒绝、触发门、同一 harness 下的基线重评、筛选、受预算约束的完整评估、Pareto 选中、holdout 检查、确认用的成对比较、一次 `kind: 'skill'`、`op: 'patch'` 的 `stageWrite`，以及台账行。`src/experiments.ts` 拥有域声明、持久行 schema，以及读取路径与保留策略使用的两个纯选择器（`experimentPage`、`staleExperiments`）。 `src/contamination.ts` 是 holdout 守卫：该技能已记录的搜索场景，holdout 不得重复。 `src/lineage.ts` 统计变更组成：起始正文与优胜者之间新增与删除的行数，按顺序敏感的方式，因此台账记录每次晋级的改动有多大。

不发布不变量配套包：实验域表是这份状态的唯一副本，因此不存在可独立核对的第二种观测。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- 度量三元组与触发器在 [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md)；优化器复用两者，不复制。
- 分选技能协议（用 skill_manage 写，再 approve）见 [`dsh-command-evolution`](../command-evolution/README.zh.md)。
- 选择所读的新颖度档案记录在 [`dsh-evolution-novelty-search`](../evolution-novelty-search/README.zh.md)；优化器每次运行只取一次 `entries(skill)` 快照，并把每次分选写回该档案。
- 变异调用的 `purpose: 'evolution-optimize'` 归因声明在 [`dsh-llm`](../../llm/llm/README.zh.md)。

-----

<a id="model-experience"></a>
## Model Experience

### Mutation request

#### What the model sees

每个选中的算子各占一条 user 消息，开头是固定表头 `You improve one skill package in a single pass.`、该算子自己的指令行、注明所需正文数量的回复格式行，以及结尾的 `No prose outside the array.`——其后是技能名、完整的当前 `SKILL.md` 正文与失败证据。请求不声明任何工具，回答必须是完整替换正文组成的 JSON 数组。

#### Token effect

有上限：每个拿到候选的算子一次请求——`maxCandidates` 按队列切分，因此运行不会超过这个请求数——每次受 `maxInputBytes` 的框架与 `maxOutputTokens` 的补全约束。评分不增加模型调用：每次尝试都重放已记录的夹具。

#### KV Cache effect

与活跃请求无关：每次变异调用都是带自有前缀的全新单消息交换，因此不会使会话上的 provider 缓存复用失效。同一次运行内的各次调用也彼此独立，因为每次都以各自的算子指令开头。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Replay 只度量可执行内容**——纯改写提示词的变体可能与基线同分，因为无 key replay 固定了模型脚本，只有工具结果可变。什么都测不出的纯提示词改写会报告 `no-improvement`；这是 harness 在说实话，不是漏掉的优化。
- **每次运行只动一个 SKILL.md 正文**——覆盖层只提供变体正文；包内兄弟文件（脚本、引用）在其中缺席，因此依赖改写兄弟文件的变体可能误评。等有技能需要时再做兄弟感知覆盖层。
- **没有语料挖掘**——场景由每次运行显式给出；把会话变成夹具加手写驱动仍是开放设计（见 Batch 5 note）。
- **holdout 的私密性只取决于配置，但改配置洗不白它**——优化器既拒绝同时出现在搜索列表中的 holdout 场景，也拒绝该技能已经搜过的 holdout 场景；但没有任何东西阻止运维把每个场景在两处都列上还称之为切分；语料切分是部署决定，不是强制约束。
- **算子组合会放大模型调用**——每个选中的算子都是一次独立变异调用，因此 `operators: ['rewrite', 'compress', 'guard', 'exemplify']` 配 `maxCandidates: 4` 是四次调用换四个候选，而不是一次调用换四个。要扩宽组合就明确地扩。
- **筛选用度量换成本**——在短子集上晋级的候选是按通过状态、token、档案新颖度、正文新颖度与墙钟在那里裁决的，因此只在被跳过的场景上占优的候选可能在尚未被度量前就被砍掉。
- **下限只存在于人类批准之后**——没有被裁决过的分选条目不算数，而记录下限自己那份正文的运行，正是把它写进台账的那次运行；被拒绝的晋级不会留下下限。
- **下限只与它自己的条件可比**——同一批场景（顺序无关）、同一 provider 与模型、每个场景相同的尝试次数、同一 scorer 版本。其中任何一项变化都会让下限消失，而不是去比较不可比的数字。
- **新颖度是文本层面的，因此复用了同一批行的语义改写会报 0**——它是在候选自身正文上按行测量的（技能正是由这些行构成），但两段用不同措辞表达同一意思的正文不共享任何行，会被读成完全新颖。就档案而言，它只和档案里真有的东西一样好：未挂载 `dsh-evolution-novelty-search`、或该技能尚未分选过任何正文时，每个候选都读到 `archiveNovelty: 1`，运行便退回只看它的起始正文——台账只存正文摘要、从不存正文，否则后续运行得不到「相对于已晋级历史」的新颖度。此外每次运行只与启动那一刻的一份快照比对，因此并发运行的晋级不在其中。
- **先验按失败签名与作用域统计**——它学的是「哪个算子能修哪种失败模式」，而不是「哪个算子适合哪个技能」；而签名会折叠数字，因此两个只在数字上不同的不同失败会共用一条记录。一次运行只把晋级记给产出优胜候选的那个算子，绝不记给只是看起来更好的候选。
- **没产出候选的重复实验对这道闸门不可见**——模型调用没有产出任何可用内容（包括只产出会破坏技能的正文）的算子不会被记为产出过，因此下一次运行可能重试它；而评分之前就跳过的运行不记录基线，所以它永远不是后续运行被拒绝的理由。
- **准入闸门只查 frontmatter，不查行为**——候选只有在完全无法落地时才会被拒绝；它是否路由到该去的地方由 scorer 的行为门（`evaluateBehavior`）裁决，而优化器并不运行该门，因此一个格式完好却抢走别的技能触发词的正文，仍会作为推荐到达人类面前。
- **停滞是切换，不是治愈**——它改变的是从哪些算子抽取候选（用近期窗口没有试过的阵容）；它不会超出配置的 `operators` 去扩充，不发明新场景，也不换模型。`stagnationWindow: 1` 让一次失败运行就足以触发。
- **台账记录的是运行，不是批准**——一行记录说明某个晋级被分选了；人类随后批准还是拒绝，存在作用域自己的分选条目决议里，所以要统计被接受的改进需要同时读两处。
- **确认重复的是比较，不是搜索**——`confirmationRuns` 在同一批场景上把同一个优胜正文与同一基线重评；它不重新采样场景、种子或模型路由，因此排除的是「一次比较的幸运读数」，而不是「一份幸运语料」。
- **尝试的覆盖层 home 来自 harness，而不是环境**——变体在存放已分选 SKILL.md 的临时 `DSH_HOME` 内评分，该 home 以 `homeDir` 传给 runner；若经由子进程环境传递，录制回放 harness 会自行构造 home，从而评的是线上技能本身。
- **被截断的运行不是完整搜索**——设置了预算时，`truncated: true` 意味着优胜者是在装得下的候选之间选出的，而不是在全部候选之间；要读成完整比较，就提高预算或降低 `maxCandidates`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

`lineage.ts` 以最长公共子序列统计改动行数，因此纯粹的重排会记为有增有删；而 `novelty.ts` 比较的是忽略顺序、折叠大小写与空白的行集合，于是同一次重排记为 0——两个数字有意回答不同的问题，彼此都不是对方过时的副本。`instructionLines` 只剔除开头那一处 `---` 围栏块，别的都不动，因为 frontmatter 是每个候选都会照抄的路由元数据；其下没有指令行的正文报告的新颖度是 `0` 而不是 `1`，因为它没有任何可称新颖的内容。不满足 `experimentRecordSchema` 的持久行会让领域打开时大声失败，而不是被跳过，因为丢掉一条结果会掩盖台账声称已经发生的晋级。

</details>

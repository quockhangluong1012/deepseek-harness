---
description: "最小离线技能优化：按触发门控经 Host LLM 变异、在隔离 DSH_HOME 覆盖层下经评分器评估、Pareto 选中、分选技能补丁（ctx.evolutionOptimizer）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-optimizer

[English](README.md) | 中文

## Summary

`dsh-evolution-optimizer` 运行一次离线技能优化：按技能已记录的失败率设门，向 Host LLM 按可配置的变异算子组合索取改写后的 SKILL.md 正文，先在短场景子集上筛选，再在隔离的 `DSH_HOME` 覆盖层下经评分器重评基线与每个幸存变体，检查私有 holdout 场景，用重复的成对比较确认优胜者，拒绝被已批准晋级支配的优者，保留击败基线的 Pareto 优胜者，并将其分选为技能补丁。凡是产出了候选正文的运行都会写入按作用域划分的实验台账，因此后续运行——或读 `/curator experiments` 的人——都能看到已经试过什么、量到了什么。没有任何一步直接写技能——分选条目在作用域内等待，直到人类用 skill_manage 写技能并以 `/skills approve` 消除条目。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

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

### Configuration

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-optimizer)是每个可接受字段的穷尽来源。

```yaml
- name: '@deepseek-ai/dsh-evolution-optimizer'
  config:
    maxCandidates: 3
    provider: deepseek
    model: deepseek-chat
    agent:
      binScript: apps/cli/src/bin.ts
      configPath: cordis.yml
      tsconfigPath: tsconfig.json
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
| `maxExperiments` | `200` | 每个作用域保留的实验数，最新优先 |
| `experimentPageSize` | `20` | 单次读取返回的实验数，最新优先 |
| `agent` | `required` | 变体尝试启动的 agent 组合，请求可覆盖 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-optimizer)是每个可接受字段的穷尽来源。

### 变异算子

只有一个提示词作为唯一变异机制会收敛到同一种改写风格，因此一次运行可以从一个算子组合中取候选。内置算子是 `rewrite`（清晰度与顺序）、`compress`（在保留证据指向的每条规则的前提下最短正文）、`guard`（补上缺失的前置条件、拒绝或校验）与 `exemplify`（每条被证据指向的规则配一个实例）。`operators` 按请求顺序列出要用的 id；未知 id 在加载时失败。

`maxCandidates` 仍是本次运行的候选总数：预算在所选算子间均分，靠前的算子领余数，因此 `maxCandidates: 2` 配 `['rewrite', 'compress']` 是各一次调用。每个算子都是一次独立的模型调用，所以在候选数相同的情况下算子越宽调用越多；默认 `['rewrite']` 保持历史上的单次调用形态。两个算子返回同一正文时只贡献一个候选，记在靠前的算子上；分选证据中点名产出优胜者的算子。

### 晋级置信度与实验台账

- **`confirmationRuns` 把一次好比较变成可重复的比较。** 搜索阶段已经赢过基线一次；此后每一轮都在全新进程下把基线与优胜者作为一对再评一次，只有优胜者赢下每一对才允许晋级。输掉一对的优胜者会被拒绝，返回 `status: 'unconfirmed'` 并记录 `confidence: { runs, wins }`，因此一次随机意义上的胜利无法仅凭单次读数晋级。额外的成对比较与搜索共用同一套 `budgetTokens` / `budgetWallTimeMs` 上限。
- **凡是走到评估阶段的运行都会成为作用域 `evolution_experiments` 域中的一行持久记录**：证据文本、产出候选的算子、搜索与 holdout 场景、基线与优胜者三元组、置信度计数、结果、原因、创建分选条目时的 staged id、provider 与模型，以及运行起始正文与被晋级正文的 SHA-256。正文本身不落盘，由摘要标识。
- **已批准的晋级是下一位优胜者必须越过的下限。** 在分选任何内容之前，本次运行会查该技能已记录的**最强且已获批准**的晋级，并只在两者于同一批场景、同一路由与同一尝试次数下测量过时与之比较——来自其他配置的三元组说明不了本次配置的任何事。被已批准结果支配的优胜者会被拒绝，返回 `status: 'regressed'` 并在报告中点名该下限（`floor: { triple, stagedId, at }`），因此一个越过了当下基线、却倒退了一项已接受改进的改动，绝不会以推荐的形式到达人类面前。
- **台账可读且有界。** `experiments(scopeId, { skill, limit })` 按最新优先返回，`/curator experiments [skill]` 打印它们，每个作用域保留 `maxExperiments` 行，新行落地时丢弃更旧的行。写入台账失败会在 host logger 上报告，绝不会把已经发生的晋级变成错误。

-----

<a id="use-this-package"></a>

选择只看调用方点名的场景，因此优胜者是在与变异同一批语料上选出的。三个配置旋钮防止这变成过拟合并失控的成本：

- **`holdoutScenarios`**——搜索永不评分的语料场景。任何内容被分选前，优胜者与基线都会先在其上评分，若基线在那里支配优胜者则拒绝（`status: 'holdout-rejected'`，不分选任何内容）。holdout 放在插件配置而非请求里是有意的：能点名 holdout 的调用方，也能丢掉一个没通过的场景。
- **`budgetTokens` / `budgetWallTimeMs`**——一次运行可为候选评分买下的上限。越过上限后循环在下一轮完整评估前停止并报告 `truncated: true`；搜索仍在已评分的候选间选择，而在评分任何候选前就花完预算的运行返回 `skipped`，而不是靠猜去分选。
- **`screenScenarioCount`**——逐次减半。每个候选先在前 N 个搜索场景上评分，较优的一半幸存（先看通过状态，再看 token，再看墙钟），只有幸存者跑完整场景集。即使设了预算，筛选也会对每个候选执行，因此幸存者始终在同一子集上排序。

两份场景列表在任何模型调用之前校验：任一列表内部重名，或同时出现在两份列表中，都会直接抛错而不是继续运行。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/pareto.ts` 是纯选择器：（pass、token、wallTimeMs）上的支配关系、非支配前沿、筛选晋级的幸存者切分，以及必须支配重评基线的优胜者。`src/mutate.ts` 拥有算子组合，并为每个算子组织一次请求（该算子的指令加字节预算，预算只砍证据不砍技能正文），把 JSON 数组作答解析为互异正文。`src/evaluate.ts` 把每个正文分选进全新的 `DSH_HOME` 覆盖层，经 `evolutionScorer.evaluateSkill` 以把覆盖层 home 叠入尝试环境的 runner 评分；评分落定即删除覆盖层。`src/index.ts` 编排：场景校验、触发门、同一 harness 下的基线重评、筛选、受预算约束的完整评估、Pareto 选中、holdout 检查、确认用的成对比较、一次 `kind: 'skill'`、`op: 'patch'` 的 `stageWrite`，以及台账行。`src/experiments.ts` 拥有域声明、持久行 schema，以及读取路径与保留策略使用的两个纯选择器（`experimentPage`、`staleExperiments`）。

不发布不变量配套包：实验域表是这份状态的唯一副本，因此不存在可独立核对的第二种观测。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- 度量三元组与触发器在 [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md)；优化器复用两者，不复制。
- 分选技能协议（用 skill_manage 写，再 approve）见 [`dsh-command-evolution`](../command-evolution/README.zh.md)。
- 变异调用的 `purpose: 'evolution-optimize'` 归因声明在 [`dsh-llm`](../../../llm/llm/README.md)。

-----

<a id="model-experience"></a>
## Model Experience

优化器永不触达模型：它离线运行在已记录的结果之上，只有优胜者正文的分选条目（附基线/优胜三元组作证据）浮到人类面前等待批准。

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Replay 只度量可执行内容**——纯改写提示词的变体可能与基线同分，因为无 key replay 固定了模型脚本，只有工具结果可变。什么都测不出的纯提示词改写会报告 `no-improvement`；这是 harness 在说实话，不是漏掉的优化。
- **每次运行只动一个 SKILL.md 正文**——覆盖层只提供变体正文；包内兄弟文件（脚本、引用）在其中缺席，因此依赖改写兄弟文件的变体可能误评。等有技能需要时再做兄弟感知覆盖层。
- **没有语料挖掘**——场景由每次运行显式给出；把会话变成夹具加手写驱动仍是开放设计（见 Batch 5 note）。
- **holdout 的私密性只取决于配置**——优化器会拒绝同时出现在搜索列表中的 holdout 场景，但没有任何东西阻止运维把每个场景在两处都列上还称之为切分；语料切分是部署决定，不是强制约束。
- **算子组合会放大模型调用**——每个选中的算子都是一次独立变异调用，因此 `operators: ['rewrite', 'compress', 'guard', 'exemplify']` 配 `maxCandidates: 4` 是四次调用换四个候选，而不是一次调用换四个。要扩宽组合就明确地扩。
- **筛选用度量换成本**——在短子集上晋级的候选是按通过状态、token 与墙钟在那里裁决的，因此只在被跳过的场景上占优的候选可能在尚未被度量前就被砍掉。
- **下限只存在于人类批准之后**——没有被裁决过的分选条目不算数，而记录下限自己那份正文的运行，正是把它写进台账的那次运行；被拒绝的晋级不会留下下限。
- **下限只与它自己的条件可比**——同一批场景（顺序无关）、同一 provider 与模型、每个场景相同的尝试次数。其中任何一项变化都会让下限消失，而不是去比较不可比的数字。
- **台账记录的是运行，不是批准**——一行记录说明某个晋级被分选了；人类随后批准还是拒绝，存在作用域自己的分选条目决议里，所以要统计被接受的改进需要同时读两处。
- **确认重复的是比较，不是搜索**——`confirmationRuns` 在同一批场景上把同一个优胜正文与同一基线重评；它不重新采样场景、种子或模型路由，因此排除的是「一次比较的幸运读数」，而不是「一份幸运语料」。
- **被截断的运行不是完整搜索**——设置了预算时，`truncated: true` 意味着优胜者是在装得下的候选之间选出的，而不是在全部候选之间；要读成完整比较，就提高预算或降低 `maxCandidates`。

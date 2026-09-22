---
description: "Verifier-first candidate admission: the cheapest-first ladder of schema, invariant, simulation, evaluator, and human rungs, stopping at the first rung that decides (ctx.evolutionVerifiers)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-verifiers

[English](README.md) | 中文

## 概述

`dsh-evolution-verifiers` 让环境尽可能多地承担判断（§12）：一架从最廉价一级开始的五级阶梯，作用于候选技能正文，在第一个拒绝处停下。第 0 与第 1 级是确定性的、始终可用：先是 `skill_manage edit` 强制执行的 frontmatter 不变式，随后是名称与指令不变式。在这两级失败的候选永远不必花费模拟器、评审模型或人工：这正是规范中确定性验证器优先的规则。第 2 至第 4 级（模拟器、评审模型、人工）是调用方挂载的接缝；未挂载的层级弃权，全都弃权的阶梯报告该弃权，而不是它从未赢得的批准，本包自身也不调用模型。

`dsh-evolution-curator` 用它作为合并补丁正文的准入闸门。

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

挂载插件后调用 `verify`，或在无需宿主时直接调用纯函数 `runVerifierLadder`。

```ts
const verdict = await ctx.evolutionVerifiers.verify({
  name: 'leaf',
  body: candidateSkillFileText,
  // Levels 2 to 4 are the seams this host mounts. An omitted seam abstains.
  simulation: async () => ({ status: 'passed', reason: 'the recorded replay held' }),
  evaluator: async () => ({ status: 'passed', reason: 'the judge approved the rewrite' }),
  review: async () => ({ status: 'passed', reason: 'operator approved' }),
})
if (verdict.status === 'failed') {
  console.log(`refused by level ${verdict.decidedBy}: ${verdict.reason}`)
}
```

`verify(request)` 返回 `VerifierVerdict`。当某一级拒绝时结果为 `failed`，并指明 `decidedBy` 层级与该层级的理由，此时它之上的每一级都不会被咨询。五级全部通过时结果为 `passed`。当没有任何一级失败、且至少有一级弃权时结果为 `abstained`，其 `decidedBy: null`，`reason` 逐一点名弃权的层级。`rungs` 按运行顺序携带每一个被咨询的层级，因此必须依据不完整阶梯行动的调用方，能确切看到缺失的是哪一级。

每一级报告一份 `VerifierJudgment`：`passed`、`failed`，或带理由的 `abstained`。已挂载的接缝抛出异常时会向外传播——模拟器不可用会使本次验证失败，而不会被算作弃权——而无法判断该候选的已挂载接缝会自行返回 `abstained`。

### 阶梯（§12）

| 层级 | 梯级 | 拒绝时的 `verdict.decidedBy` | 判断内容 |
|---|---|---|---|
| `0` | 模式 | `0` | frontmatter 可解析、保留技能自身名称并带有路由描述——即技能管理器在编辑时强制的不变式 |
| `1` | 不变式 | `1` | 名称是合法的 kebab-case，且 frontmatter 之后的文本携带指令 |
| `2` | 模拟 | `2` | 已挂载、对候选做重放的领域模拟器或工具执行 |
| `3` | 评审 | `3` | 已挂载、对候选做评判的评审模型 |
| `4` | 人工 | `4` | 已挂载的人工决定，例如已记录的批准路径 |

第 0 与第 1 级仅凭候选本身即可判定，因此在进程内运行、无法被卸载。第 2 至第 4 级只在所有更廉价的层级通过之后才被咨询。

### 配置

无——本阶梯不接受任何部署选择。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

阶梯是对固定梯级列表的一次纯遍历，而其两半按"谁拥有判断"划分。`ladder.ts` 拥有顺序、短路与裁决形态：`verifySchema` 与 `verifyDeterministic` 是本包能自行判定的两级，`runVerifierLadder` 遍历 `[0, 1, 2, 3, 4]`，记录每一级的判断，并在某一级拒绝的瞬间返回——因此咨询顺序**就是**代价顺序，第 0 级的拒绝可证明永远不会到达第 2 级。

接缝是一个返回判断的零参函数，而不是包内的服务查找：调用方知道自己是否拥有模拟器、评审模型与人工决定，而阶梯只知道它们的顺序。这使本包除 frontmatter 不变式外不依赖任何宿主，也正是未挂载的层级会成为带理由的弃权、而非静默通过的原因。通过记功归于第 4 级——最深的梯级——因为只有抵达人工层级的裁决，其证据才真正跑完了整架阶梯。

### 消费者

`dsh-evolution-curator` 将其归并 `patch` 闸门走同一架阶梯（`applyConsolidation`）：在第 0 或第 1 级失败的正文会被拒绝，判定层级记入 `ConsolidationReport.refusals` 并计入 `skipped`；通过确定性层级的正文则被提交——curator 不挂载任何更高层级，因此其报告陈述的是这一决定，而不是一次它并未执行的验证。

### 失败与恢复

拒绝的层级是终局，而阶梯除那两级确定性梯级外不作任何自身判断：它绝不把弃权变成通过，也绝不编造某一级未曾给出的理由。接缝抛出异常会使整次验证失败，因此模拟器故障的宿主会得知这一点，而不是读到一次安静的弃权。这里不写入任何持久状态，因此没有可发布的不变式同伴。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演化 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §12——验证器优先的阶梯，以及"存在确定性验证器时不要使用 LLM 评审"的规则；§46 的评审器博弈防御，确定性梯级正是其第一重回答；§50 流水线中的 VERIFIERS 阶段。
- [演化包地图](../README.zh.md)——本组的包及其在仓库中的位置。
- [`dsh-evolution-curator`](../evolution-curator/README.zh.md)——把归并补丁准入走本阶梯的消费者。
- [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md)——对候选与其基线作比较的行为闸门（契约、路由、重放），本阶梯不做这种比较。
- [`dsh-evolution-skill-manage`](../../skill/evolution-skill-manage/README.zh.md)——第 0 级复用其 `splitFrontmatter`/`validateSkillHead` 不变式而非重新实现的包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包不注册任何面向模型的内容，也不读取任何模型写下的东西。调用方挂载的第 3 级接缝本身可能调用模型；那次请求属于调用方。

#### KV Cache 影响

这里没有任何内容进入模型请求，因此不影响提供方的缓存复用。把裁决渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本阶梯在何时不合适。它们是本包当前的约束。

- **上层梯级的好坏取决于所挂载的接缝**——本包自己不运行模拟器、评审模型或人工提示，因此什么都不挂载的部署只能凭确定性梯级准入候选；裁决会明确说 `abstained`，正是为了让这一点可见而非隐含。
- **通过不等于晋升**——阶梯回答的是正文能否被准入；这里没有任何东西使技能对模型可见，也不改变生命周期状态。
- **没有基线比较**——阶梯仅凭候选自身的证据判断一个正文。相对它所替换的修订发生退化的候选，属于 scorer 重放闸门的问题，而不是本阶梯的。
- **确定性梯级是结构性的**——它们判断语法、命名与指令是否存在，而不判断指令是否正确；一个格式良好但指令内容错误的正文能通过它们。
- **无持久记录**——裁决被返回而不被存储，因此需要准入历史的宿主须自行保存；curator 在其报告与台账条目中记录拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

第 0 级复用 `dsh-evolution-skill-manage` 的 `splitFrontmatter`/`validateSkillHead`，而不是重新推导 frontmatter 规则，因此阶梯与 `skill_manage edit` 永远不会就可提交正文的界定产生分歧。这也是本包唯一宿主依赖就是那个包的原因。`runVerifierLadder` 中的梯级列表是数据——两个字面梯级加三个接缝——而 `VERIFIER_LEVEL_NAMES` 是 `Record<VerifierLevel, string>`，因此新增层级时若不为其命名就无法通过编译。用既有评审器接线第 3 级接缝的调用方自行组合该判断，因为接缝契约是一份判断，而不是一份转录。

</details>

---
description: "依赖感知进化：带依赖版本的实验信封，附带可比性检查与消融归因（ctx.evolutionLineage）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-lineage

[English](README.md) | 中文

## 概述

`dsh-evolution-lineage` 维护带依赖版本的实验信封的日志（每个受评候选人一个），使指标比较是同口径的。每个信封记录其测量三元组、结论与依赖版本；`compare` 报告两个信封是否在配置的键上一致、以及变化了什么。`attributeImprovement` 根据消融各臂把收益归于一个变更、两个变更或二者的交互；每个信封都携带其种子，因此任何运行都可重放。第二张表为每个策略维护一条线性修订链，因此策略版本可由其记录正文做 diff、复现与回退。比较是已记录事实而非门控；此包不调用任何模型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载插件并配合存储域。只要存储已挂载，信封就来自优化器受评的候选人；操作者读取信封，在信任指标差异前先比较依赖版本，并用种子重放一次运行。

```ts
await ctx.evolutionLineage.record({
  experimentId: 'exp-0',
  skill: 'writer',
  candidate: 'c1',
  tasks: ['t1'],
  metrics: { pass: true, tokens: 3, wallTimeMs: 5 },
  outcome: 'improved',
  regressions: [],
  dependencies: { skill: 's1', evaluator: 'e1' },
  seeds: [7],
})
const verdict = ctx.evolutionLineage.compare('exp-0', 'exp-1')
if (verdict?.comparable) console.log('apples-to-apples')
```

`record(input)` 为信封打上记录时刻，并按实验标识存储。`experiments(skill?)` 按最新优先列出信封；`envelope(id)` 读取一个脱离存储的信封，未知时返回 undefined；`compare(idA, idB)` 报告两个信封是否在配置的比较键上一致并点名变化的键，任一 ID 未知时返回 undefined；`replay(id)` 返回脱离存储的信封，其种子可复现该运行。`amendOutcome(id, outcome, rejectedReason?)` 原地更新一个既有信封的结果与拒绝原因，不动其余字段，未知 ID 时抛错——`command-evolution` 的 `/canary reject`/`/canary rollback` 调用它，使候选已记录的 `'improved'` 结论不会活得比操作者随后「它没能站住」的决定更久。

策略在同一存储中做版本化。`recordRevision({ policy, body, benchmark? })` 追加一个修订，算术由存储负责：它为该策略分配下一个版本号、对正文取哈希（sha256 十六进制），并与它所替换的修订做 diff，因此调用者无法记录出与正文不符的版本、摘要或 diff。记录与链头相同的字节是空操作；记录旧修订的字节是一次真实修订，因此回退会作为新版本落地，而不会改写历史。`revisions(policy)` 按从旧到新列出整条链，并带上每个修订的正文，这正是策略无需重读正文所写入的文件即可做 diff、可恢复的原因。

```ts
await ctx.evolutionLineage.recordRevision({ policy: 'skill:writer', body: nextBody, benchmark: 'scorer-v1:…' })
const chain = ctx.evolutionLineage.revisions('skill:writer')
const last = chain.at(-1)
if (last !== undefined) console.log(`r${last.version} +${last.diff.addedLines} -${last.diff.removedLines}`)
```

优化器把一次晋升记录在这里，因此 `skill:<name>` 链跟随实际落地的内容；从未被晋升的候选人不会被记录。

### 配置

存储的部署选项，默认值适用于常规节奏；带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `comparedKeys` | `['skill', 'evaluator', 'retriever', 'model']` | 两个信封可比必须一致的依赖键。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

比较逻辑是纯函数。`DEPENDENCY_KEYS` 按规范顺序列出每个可版本化依赖——prompt、skill、retriever、evaluator、model、tool、env。`changedDependencies` 按给定顺序报告版本不同的键，未定义版本对上已记录版本也算变化，因此未知依赖下测得的实验永远不会悄悄地与已知版本下测得的实验比较。`comparable` 当且仅当没有比较键变化时成立。`attributeImprovement` 根据四个臂做消融归因：联合臂必须通过才有任何归属，两个单臂都通过则归于两者，一个通过则归于它，单臂都不通过则归于交互——没有任何一个变更能独自复现联合收益，因此单个臂不配独占功劳。

存储是按实验的域：`evolution_lineage` 版本 2，一张按实验标识键控的 `experiments` 表，存信封及其假设、候选人、算子、任务、测量三元组、结论、回归、拒绝原因、经验、依赖版本、种子与记录时刻，另有一张按策略标识与修订号键控的 `revisions` 表，存每个修订的摘要、父摘要、行级 diff、正文、基准与记录时刻。可比性在读取时由两个信封推导，因此配置变更会重新排序可比关系，而无需重写已记录信封。

`lineDiff` 用最长公共子序列统计一次正文变更新增与删除了多少行，因此原地未变的行不计数，其余每行只在自己一侧计一次；纯重排也算变化，因为顺序就是内容。它与优化器的晋升 diff 和 curator 的补丁预览用的是同一套算术，放在这里是因为修订链需要它。`revisionKey(policy, version)` 是存储键格式唯一定义处。

### 失败与恢复

存储启动前读取会抛错。任一实验 ID 未知时 `compare` 返回 undefined，因此操作者永远不会把缺失记录误当作一致。`replay` 返回脱离存储的信封，其种子可复现该运行。非法行会在域打开时大声失败：未知血缘下测得的信封不可重新解释，而被丢弃的修订会悄悄弄断某个策略的链。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §34、§36、§48——本包实现的依赖感知进化、制品血缘与因果归因、可复现进化实验。
- [进化引擎规范](../../../specs/deepseek-harness-2.0-evolution-spec.md) §14.5——策略版本化，由修订链实现。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝将受评候选人变为信封的生产者。
- [`dsh-evolution-population`](../evolution-population/README.zh.md)——其候选人父代关系正是本包信封所引用的按代血缘的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将信封事实渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **记录可比而不强制可比**——存储只报告两个信封是否可比（§58.12：信任被记录而非强制）；拒绝不可比的晋升仍是操作者的职责。
- **只做双因素消融**——归因只归于 A、B、两者或其交互；三因素与析因设计未建模。
- **不自动重测**——退役的比较保持不可比，直到操作者在新版本下记录新的信封。
- **修订链保存完整正文**——每个修订都保留它提交的确切字节，这正是它可做 diff、可恢复的原因；没有任何东西清理旧修订，因此长期存在、频繁修订的策略会随其历史增长。
- **每条策略的链是线性的**——修订按提交顺序编号且从不分支，因此同一个策略的两个并发生产者不会产生合并点：后提交的那一个就成为下一个修订，无论它的正文基于什么。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

优化器通过可选存储记录，因此未挂载血缘包的部署行为完全不变；存储失败路径记录警告而非使优化失败。可比性在读取时由已存信封推导，因此配置变更会重新排序可比关系，而无需重写已记录信封。

</details>

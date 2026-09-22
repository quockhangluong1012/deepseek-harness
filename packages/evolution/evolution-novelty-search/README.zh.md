---
description: "新奇度搜索：按技能持久化的行为描述符档案，基于 Jaccard 的档案新奇度奖励有意义的差异候选（ctx.evolutionNovelty）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-novelty-search

[English](README.md) | 中文

## 概述

`dsh-evolution-novelty-search` 维护跨运行的按技能行为描述符档案——每个暂存优化器写入对应一条条目——并测量每个新描述符相对该技能此前全部所见的新奇度。新奇度 = 1 − 与任意档案条目的最大 Jaccard 相似度：复述已知指令的候选不算新奇，携带新材料的候选才算。优化器通过可选存储接缝记录每次暂存写入，宿主命令 `command-evolution` 通过 `/novelty` 检视档案。此包不调用任何模型。

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

挂载插件并配合存储域。只要存储已挂载，描述符就来自优化器的暂存写入；操作者读取档案及其新奇度压力。

```ts
await ctx.evolutionNovelty.record({
  candidateId: 'staged-0',
  skill: 'writer',
  features: ['do the thing', 'refuse unsafe paths'],
})
const entries = ctx.evolutionNovelty.entries('writer')
const pressure = ctx.evolutionNovelty.mean('writer')
```

`record(input)` 以该技能档案（排除自身，因此重复记录同一候选会保留其原始新奇度）测量描述符的新奇度，并按候选标识存储条目。`entries(skill?)` 按最新优先列出条目；`mean(skill)` 报告该技能的档案平均新奇度（0..1）——均值下降正是 §31 所指的前沿停滞信号。`/novelty` 命令列出档案及各技能均值。

### 配置

无——本存储不需要任何部署选项。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

测量逻辑是纯函数。`similarity` 是两个特征集合的 Jaccard 相似度（两个空集为 0）。`archiveNovelty` 是 1 减去描述符与任意档案条目的最大相似度：无特征的描述符为 0（没有可称为新奇的内容），空档案的种子条目为 1。`noveltyMean` 对已记录新奇度求平均，空档案为 0。存储是按条目的域：`evolution_novelty` 版本 1，一个按候选标识键控的 `archive` 表，存 `{ candidateId, skill, features, novelty, at }`。

优化器保留自己的按基线新奇度（`noveltyOf`）用于生成期选择，并且已经在幸存者选择中融合新奇度；本包贡献的是持久化的档案新奇度信号——相对该技能全部历史而非单一参考体的差异度。

### 失败与恢复

存储启动前读取会抛错。条目 ID 即优化器的暂存写入 ID，因此 `/novelty` 中的 ID 始终指向真实的暂存写入。档案行仅在记录时测量，因此即使后续候选与之相似，历史仍保留其原始新奇度。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §31——本包实现的新奇度搜索机制。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝将暂存写入变为档案条目的生产者。
- [`dsh-evolution-population`](../evolution-population/README.zh.md)——其候选记录携带优化器按基线新奇度的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将档案事实渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **描述符由外部提供，而非此处推导**——优化器在记录前从胜者正文提取描述符特征（`descriptorOf`）；本存储只测量，不解析技能正文。
- **每次暂存写入一条条目**——档案以候选标识为键，一次暂存写入无法向档案携带多个行为变体。
- **无档案预算**——档案无上限增长；有界档案需要在域上加保留策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

优化器通过可选存储记录，因此未挂载新奇度包的部署行为完全不变；存储失败路径记录警告而非使优化失败。重复记录排除规则使同一候选标识的档案写入保持幂等。

</details>

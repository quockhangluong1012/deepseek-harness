---
description: "对抗进化：覆盖八个弱点类别的持久对抗探针，以及评估器博弈防御清单（ctx.evolutionAdversary）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-adversary

[English](README.md) | 中文

## 摘要

`dsh-evolution-adversary` 维护按技能持久化的对抗探针日志——每个弱点家族对应一个提示词或场景——覆盖 §45 的八个弱点类别，从边缘情形与提示词注入到评估器博弈。每个探针记录它是否暴露了真实弱点，以及该弱点是否已修复。挑战指名下一个待探针的类别，使没有任何家族未经测试；全部覆盖后则轮换探针最少的类别。一旁是 §46 评估器博弈防御清单：六个可自动化的防御，其缺口显示还有哪些尚未落实。此包不调用任何模型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载插件并配合存储域。操作者在运行对抗探针时逐条记录，修复探针暴露的弱点，并读取挑战以获知下一个待探针的类别；清单显示还有哪些评估器博弈防御尚未落实。

```ts
await ctx.evolutionAdversary.probe({
  probeId: 'writer-injection-1',
  skill: 'writer',
  category: 'prompt-injection',
  probe: 'Attempt to override the task instruction.',
  foundWeakness: false,
})
const challenge = ctx.evolutionAdversary.challenge('writer')
await ctx.evolutionAdversary.setDefense('hidden-holdout', true)
```

`probe(input)` 将一条探针记为未修复；`setRepaired(probeId, repaired?)` 在弱点修复后将其标记为已修复，默认即已修复。`probes(skill?)` 按最新优先列出探针；`challenge(skill)` 按配置的下限指名下一个待探针的类别。`setDefense(defense, satisfied)` 设置清单中的一项防御；`defenses()` 按规范顺序渲染完整清单；`defenseGaps()` 列出尚未落实的防御。

### 配置

存储的部署选项，默认值适用于常规探针；下限带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `minProbesPerCategory` | `1` | 每个类别按技能计入覆盖之前的探针数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

覆盖逻辑是纯函数。`categoryCoverage` 按类别统计一个技能的探针数，零填充使未探针类别读数为 0。`uncoveredCategories` 按规范顺序列出仍低于下限的类别。`nextChallenge` 取第一个未覆盖类别；若全部类别已覆盖，则取探针最少的类别，使探针轮换而不停止，并以规范顺序打破并列。`weaknessRate` 以发现弱点的探针数除以技能总数，无探针时为 null。`defenseGaps` 列出清单行缺失或未满足的每个规范防御。

存储是双表域：`evolution_adversary` 版本 1，一张以探针标识键控的 `probes` 表，存 `{ probeId, skill, category, probe, foundWeakness, repaired, at }`，一张以防御键控的 `defenses` 表，存 `{ defense, satisfied, at }`。挑战在读取时由完整探针历史推导，因此配置变更会重新排序下一个类别，而无需重写已记录探针；从未设置的防御读数为未满足且时刻为 null，因此清单在设置任何项之前即可渲染。

### 失败与恢复

存储启动前读取会抛错。修复是独立的显式步骤，因此已记录弱点永远不会被悄悄标记为已修复；对不存在的探针 id 调用 `setRepaired` 会大声抛错。防御行以防御为键，因此设置一项防御永远不会扰动另一项。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §45——本包实现的对抗进化；§46——本包维护的评估器博弈防御清单。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md)——`evaluatorDisagreement` 是值得探针的分歧来源：跨修订的持久分歧标出对抗探针应优先针对的候选。
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.zh.md)——其裁决一致性、批准漂移与误报跟踪正是防御清单所守护的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将探针事实渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **记录探针而不执行探针**——存储只记录对抗提示词及其修复状态（§58.12：信任被记录而非强制）；对技能执行探针并判定弱点仍是操作者的职责。
- **所有类别共用一个下限**——`minProbesPerCategory` 适用于每个弱点家族；按类别的下限需要在存储上加配置。
- **清单只覆盖可自动化的防御**——人工抽查按设计留在操作者一侧；存储只跟踪它能观测的六项防御。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文——点击展开</summary>

本存储只做记录：此处不调用任何模型，探针、修复与防御满足都是作为事实记录的操作者判断。挑战在读取时由历史推导，因此下限变更会重新排序下一个类别，而无需重写探针；未设置的防御合成开放行，因此清单从空存储即可安全渲染。

</details>

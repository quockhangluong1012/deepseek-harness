---
description: "评估器集成健康：记录行为评估裁决，聚合裁判一致性、通过率漂移与误报跟踪（ctx.evolutionEvaluatorHealth）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-evaluator-health

[English](README.md) | 中文

## 概述

`dsh-evolution-evaluator-health` 让评估器自身保持诚实：它持久记录 scorer 产出的每一条行为评估裁决，并聚合判断是否在漂移或被博弈的健康事实——裁判一致性（全体一致）、对最新窗口的通过率漂移、误报（通过后被同技能拒绝所推翻的裁决），以及逐通道通过率。§13 的校准面 `calibration()` 报告漏报率（被拒后被同技能通过所推翻的裁决），以及这些裁决与随后独立评判它们的地面真值的相关性。此处不调用任何模型；scorer 的行为评估向它记录，宿主命令 `command-evolution` 通过 `/evaluators` 报告它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件并携带存储域即可；只要存储已挂载，裁决便来自 scorer 的 `evaluateBehavior`。

```ts
await ctx.evolutionEvaluatorHealth.observe({
  skill: 'polish',
  unanimous: false,
  status: 'evaluated',
  approved: false,
  approving: ['contract', 'routing'],
  dissenting: ['replay'],
})
const health = ctx.evolutionEvaluatorHealth.summary()
const calibration = ctx.evolutionEvaluatorHealth.calibration()
console.log(`${health.approvalRate * 100}% approved, drift ${health.drift * 100} points, false positives ${health.falsePositiveRate * 100}%`)
console.log(`${calibration.falseNegativeRate * 100}% false negatives, ground-truth agreement ${calibration.agreementRate * 100}%`)
```

`observe(input)` 记录一条裁决，拒绝被跳过的评估（跳过的运行没有判断）。`runs(skill?)` 按最新在前列出已记录裁决，可选用技能过滤。`summary()` 聚合：整体与近期通过率及漂移、全体一致、误报占通过裁决的比例，以及每个通道一行。`judge(runId, judgment)` 把随后评判某条裁决的地面真值附加上去——它是否认同该评估器，以及是否独立测得。`calibration()` 在摘要的误报率之外聚合漏报率、被独立评判的裁决数，以及它们的一致率。`/evaluators` 命令打印摘要或最新裁决。

### 配置

漂移窗口是可在 `cordis.yml` 中修改的已验证 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-evaluator-health'
  config:
    driftWindow: 20
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `driftWindow` | `20` | 近期漂移窗口覆盖的裁决数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-evaluator-health)是每个已接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

裁决是 `evolution_evaluator_health` 域（v2，一张以裁决 id 为键的 `runs` 表）中的持久逐条行：`{ id, skill, unanimous, status, approved, approving, dissenting, judgment, at }`，其中 `judgment` 是随后判定的地面真值（`{ agrees, independent, at }`）或 null；版本 1 的裁决读作未被判定。聚合是纯函数：`summarizeHealth(runs, window)` 按最新在前消费裁决，取最新 `window` 条为近期切片，计算通过率、一致率与漂移（近期减整体）。误报是一条通过裁决，存在同一技能更晚的被拒裁决——按通过裁决计数，因此该比率问的是「我们通过的时候，同一技能后来被拒绝的频率」。`judgeCalibration(runs)` 对被拒裁决镜像同一读数——存在同一技能更晚通过裁决的被拒裁决，按被拒裁决计数——并加入与人类结果的相关性：在随后由独立地面真值评判过的裁决中，它认同的比例。

### 失败与恢复

被跳过的评估不记录任何东西，若被提交则响亮拒绝。未知技能不会过滤掉任何内容：缺席技能读作空列表。`judge` 对未知裁决身份响亮拒绝，因此地面真值绝不会被附到并不存在的裁决上。存储启动前读取抛出异常。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §13 与 §46 — 本包实现的评估器集成与评估器博弈防御机制族。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-scorer`](../evolution-scorer/README.zh.md) — 其行为评估向本存储记录每一条裁决的产生方。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-evaluator-health) — 每个已接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。把健康事实渲染进提示词的消费者拥有该请求的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **健康只跟踪行为评估** —— scorer `evaluateBehavior` 的裁决是唯一来源；该路径之外的优化运行与回放分数不记录。
- **两种错误率都是内部代理** —— 误报率与漏报率把裁决彼此比较，而不是与地面真值比较；地面真值读数单独的 `calibration().agreementRate`，而它只与调用者附加的判定一样独立。
- **没有东西自动附加地面真值** —— `judge` 是给持有后续独立测量的那一方（复核的运维者、留出回放）准备的接缝；今天没有已挂载的包调用它，因此在有包调用之前 `calibration().independentlyJudged` 保持为零。
- **宿主全局，不按作用域键控** —— 裁决是全局的；按作用域的视角需要给域加作用域键。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

scorer 通过可选存储记录，因此未挂载健康包的部署看不到任何行为变化；存储故障路径记录警告而不是让评估失败。漂移是近期减整体通过占比，因此正值表示通过率在上升。`calibration()` 读取与 `summary()` 同一个 `runs()` 列表并据此推导，因此两者对哪些裁决存在绝不会各执一词；`agreementRate` 只统计独立判定，因为评估器自己判过的裁决不与任何东西相关。

</details>
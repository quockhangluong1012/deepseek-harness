---
description: "基于实测能力差距的自动课程：从每个受追踪技能最关键的失败摘要中提出训练与评估任务，并持久化提案（ctx.evolutionCurriculum）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-curriculum

[English](README.md) | 中文

## 概述

`dsh-evolution-curriculum` 把实测的能力差距变成提议的训练与评估任务，并持久化这些提案。一个差距即某个受追踪技能的去重失败摘要——从加载过它的会话的压缩学习轨迹读取；派生出的任务描述一次运行应当复现并从中恢复的反复失败，而匹配到已存反思的差距还会带上该反思的反模式与候选测试。此处不调用任何模型——差距证据本身就是课程信号。宿主命令 `command-evolution` 通过 `/curriculum` 读取它。

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

挂载插件并携带存储域即可；测量差距额外需要 telemetry 与 trace 存储，缺任一个时 `gaps()` 什么都测不到。

```ts
const gaps = await ctx.evolutionCurriculum.gaps()
const staged = await ctx.evolutionCurriculum.propose(gaps)
for (const proposal of staged) {
  console.log(`${proposal.capability}: ${proposal.task}`)
  console.log(`avoid: ${proposal.antiPattern ?? 'no stored reflection matched'}`)
}
```

`gaps()` 连接已挂载的 seam：对每个带会话的受追踪技能，取其压缩轨迹行的去重失败摘要。`propose(gaps)` 为每个越过证据下限的差距暂存一条有依据的任务，并跳过同一能力与任务已处于 open 的提案。挂载了失败记忆存储时，`propose` 还会把每个差距匹配到为它存下的反思——该差距所用会话中最晚写入、且症状与它的某条摘要属于同一次已观察失败的那条——暂存的提案随即带上该反思的反模式与候选测试，因此任务持有的是 §21 的纠正启发式，而不只是一段错误字符串。`proposals()` 列出全部已暂存任务，open 在前、retired 在后；`retire(id)` 刻意退役一个。`/curriculum` 命令一步完成测量、暂存与列出，并接受 `retire <id>`。

### 配置

证据下限是可在 `cordis.yml` 中修改的已验证 `Config` 成员。

```yaml
- name: '@deepseek-ai/dsh-evolution-curriculum'
  config:
    minGists: 1
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `minGists` | `1` | 一个能力被提议任务前所需的去重失败摘要数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-curriculum)是每个已接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

`deriveTasks` 是纯函数：为每个带失败证据的差距派生一个任务，证据最多者优先，最多引用三条摘要，并裁剪到有界的任务文本。任务点名能力、反复失败，以及证据所在会话数——一次运行可以复现失败并恢复，这正是课程所供给的训练回路。

存储是按提案粒度的域：`evolution_curriculum` 版本 2，含一张以提案身份为键的 `proposals` 表，存放 `{ id, capability, task, sourceSessions, gists, antiPattern, candidateTest, at, state }`。暂存会按 `capability + task` 对 open 提案去重，因此重跑一趟不会长出重复任务。提案在重启后依然存在，只会被刻意退役。

差距与反思按身份而非相似度匹配：轨迹摘要与反思症状都是同一条失败结果经空白规范化后的文本，各自按自己的预算裁剪，因此其中一条是另一条的前缀。差距所用会话中，摘要与任一条摘要匹配、且写入最晚的那条反思，提供这两个字段。没有匹配的差距——或没有挂载失败记忆存储的宿主——两个字段都暂存为 `null`，只带上证据本身。

### 失败与恢复

`retire` 遇到不存在的 id 响亮拒绝；已退役的提案无需写入即可解析。telemetry 或 trace seam 缺失时测量不到任何差距，而不是让一趟失败。存储启动前读取抛出异常。

本包不发布不变的伴生检查，因为域表是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §10 与 §33 — 本包实现的自动课程与能力前沿机制族。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-trace`](../evolution-trace/README.zh.md) — 其压缩行提供失败摘要的轨迹存储。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-curriculum) — 每个已接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。把任务渲染进训练提示词的消费者拥有该请求的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **任务是派生的，不是生成的** —— 任务文本复述失败证据；没有基于模型的作者，也没有除证据相关技能之外的能力分类器。
- **启发式是匹配来的，不是诊断出来的** —— 只有当失败记忆存储已经为该差距的会话存下反思时，提案才带上反模式与候选测试；任务文本本身仍然复述失败证据，而不是纠正启发式。
- **宿主全局，不按作用域键控** —— 提案是全局的；按作用域的课程需要给域加作用域键。
- **没有执行器** —— 尚无人运行已提议的任务；评估与 shadow/canary 工作（P1）拥有消费提案列表的职责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

差距测量复用了 curator survey 所做的同一处连接（技能会话 → 失败证据），使两个消费者看到相同的证据形态。提案去重键是 `capability + task`，因此推导措辞的改变不会退役任何东西，只会暂存新任务；匹配到的反模式与候选测试随提案一同存储，而不是在读取时重算：提案陈述的是它被暂存时当下的那条启发式。

</details>
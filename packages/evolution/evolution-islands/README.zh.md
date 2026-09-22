---
description: "岛屿进化：按技能持久化的进化轨道，每条带有目标、岛屿间迁移记录，以及基于调度表的迁移到期检查（ctx.evolutionIslands）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-islands

[English](README.md) | 中文

## 概述

`dsh-evolution-islands` 维护按技能持久化的进化轨道，每条携带 §7 的一个目标——保守、性能、成本、新奇、对抗——以及岛屿间的迁移记录和按节奏标记迁移到期的调度视图。岛屿保持多样性：没有它们，harness 会收敛到第一个"足够好"的技能并停止发现替代方案。优化器通过可选存储接缝推进岛屿的代际刻度，宿主命令 `command-evolution` 通过 `/islands` 注册岛屿、记录迁移并读取调度。此包不调用任何模型。

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

挂载插件并配合存储域。操作者注册技能进化任务的轨道，只要存储已挂载优化器就推进刻度，迁移按调度将强候选移入移出岛屿。

```ts
await ctx.evolutionIslands.register({
  islandId: 'stable',
  name: 'Stable lane',
  objective: 'conservative',
  skill: 'writer',
})
await ctx.evolutionIslands.migrate({
  fromIslandId: 'stable',
  toIslandId: 'diverse',
  candidateId: 'staged-0',
  reason: 'schedule',
})
const schedule = ctx.evolutionIslands.schedule('writer')
```

`register(input)` 以零代际创建岛屿；重复岛屿 ID 会响亮拒绝。`advance(skill)` 在该技能的头岛屿（最新注册者）上记录一次代际刻度，在操作者注册前是空操作。`migrate(input)` 记录两个岛屿之间的一次移动，拒绝未知岛屿与跨技能移动；候选可以反复迁移，每次移动都保留在记录中。`islands(skill?)` 与 `migrations(skill?)` 按最新优先列出；`schedule(skill?)` 渲染每个岛屿及其上次迁移和在配置节奏下是否到期。`/islands` 命令注册岛屿、记录调度迁移并列出两种视图。

### 配置

存储的部署选项，默认值适用于常规节奏；带默认值校验，因此未配置的挂载仍可运行。

| 键 | 默认值 | 含义 |
|---|---|---|
| `migrationCadence` | `86400000`（一天） | 调度迁移节奏，单位毫秒。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

域为 `evolution_islands` 版本 1，两张表：按岛屿标识键控的 `islands` 与按全新迁移标识键控的 `migrations`（候选可反复迁移）。每个岛屿行存 `{ islandId, name, objective, skill, generation, lastActivityAt, at }`；每个迁移行存 `{ migrationId, fromIslandId, toIslandId, candidateId, skill, reason, at }`。

调度逻辑是纯函数。`migrationDue` 将未迁移岛屿锚定在注册时刻、已迁移岛屿锚定在最后一次迁移时刻，再与节奏比较。`headIsland` 选择技能最新注册的岛屿；相同注册时刻保持输入顺序，因此同一毫秒批次解析为调用者先看到的岛屿。`advance` 推进头的代际与最近活动时刻——记录接缝的唯一写入，与人口存储自动编号代际的方式一致。

### 失败与恢复

重复岛屿 ID、迁移中的未知岛屿以及跨技能迁移都会响亮拒绝；存储启动前读取会抛错。对没有岛屿的技能调用 `advance` 返回 `undefined` 而非失败，因此记录接缝在操作者定义轨道前保持空操作。

不发布不变量伴生文件，因为域表是本状态的唯一副本，没有第二个独立观测可与之核对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) §7——本包实现的岛屿模型与多样性保持。
- [进化包地图](../README.zh.md)——本组包及其仓库位置。
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.zh.md)——通过可选记录接缝以暂存写入推进岛屿刻度的生产者。
- [`dsh-evolution-population`](../evolution-population/README.zh.md)——其候选正是岛屿间迁移流量的姊妹存储。

-----

<a id="model-experience"></a>
## 模型体验

无——本存储不注册任何模型面内容。

#### KV 缓存效果

此处没有任何内容进入模型请求，因此提供方缓存复用不受影响。将岛屿事实渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本存储不适用的情形，是当前的包约束。

- **记录迁移而不执行迁移**——调度只标记到期迁移（§58.12：信任被记录而非强制）；在岛屿之间移动候选仍是操作者的职责。
- **每技能一个头**——代际刻度只落在最新岛屿上；技能全部轨道的并行刻度未跟踪。
- **目标只是标签而非策略**——五个 §7 目标是被记录的词汇；目前没有轨道以不同方式引导变异算子、种子或评估器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

优化器通过可选存储推进，因此未挂载岛屿包的部署行为完全不变；存储失败路径记录警告而非使优化失败。迁移标识每次全新生成，使候选的重复移动在表中永不冲突。

</details>

---
description: "三阶段 dreaming 固化：以六信号加权综合分为已记录的失败打分，并把合格候选提升为按作用域持久化的 dreams（ctx.evolutionDreaming）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-dreaming

[English](README.md) | 中文

## 概述

`dsh-evolution-dreaming` 把某个作用域反复失败的教训固化为持久记忆，分三个仿照睡眠的阶段。**Light** 汇集该作用域已记录的失败及其情景笔记，并按陈述去重：一条笔记就是一次目击，不同自然日的目击就是 deep 阶段门限所计数的独立语境，而复述某条已记录失败的笔记会并入该失败的候选。**REM** 推导它们共享的主题并写下叙事。**Deep** 是唯一写入持久记忆的阶段：它用六信号加权综合分为每个候选打分，提升全部通过三道闸门者，并丢弃已被衰减规则判过期的提升。权重是固定的——它们是算法本身；阈值、节奏与保留量属于配置。

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

把它挂载在反馈存储旁；要自动周期再挂载 heartbeat：

```yaml
- name: '@deepseek-ai/dsh-evolution-feedback'
- name: '@deepseek-ai/dsh-evolution-heartbeat'
- name: '@deepseek-ai/dsh-evolution-dreaming'
  config:
    minScore: 0.65
    minRecallCount: 3
    minUniqueQueries: 2
```

```ts
await ctx.evolutionDreaming.dream(scope, sessionIds)   // light → REM → deep
ctx.evolutionDreaming.read(scope)                      // narratives and promotions
```

`run(phase, scope, sessionIds, now?)` 运行单个阶段以便诊断；`dream(…)` 运行整个周期；`dreamAll()` 遍历注册表已知的每个工作区，heartbeat 任务调用的正是它。

在提示符处，`/dream` 为当前作用域运行整个周期，`/dream <phase>` 运行单个阶段，二者都作用于该工作区拥有的会话。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `minScore` | `0.65` | 候选被提升所需达到的综合分 |
| `minRecallCount` | `3` | 候选所需的出现次数 |
| `minUniqueQueries` | `2` | 候选须出现的不同会话数 |
| `staleAfterDays` | `30` | 提升在未被再次观察到的情况下保持持久的天数 |
| `capacityTriggerRatio` | `0.8` | 超过 `maxPromotions` 的这一比例后，幸存者会被裁剪到硬上界 |
| `intervalHours` | `6` | 两次自动周期之间的小时数 |
| `maxNarratives` | `20` | 每个作用域保留的叙事数 |
| `maxPromotions` | `200` | 每个作用域保留的提升数 |
| `maxCandidates` | `500` | 单个周期评分的候选数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-dreaming)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 六个信号

每个维度在加权之前先归一化到 `0..1`，因此没有任何信号能凭无界的原始计数占据主导：

| 信号 | 权重 | 归一化 |
|---|---|---|
| 相关性 | 0.30 | 与该作用域已持有文本的概念重合度 |
| 频率 | 0.24 | `count / (count + 3)`——在回放闸门处取半 |
| 查询多样性 | 0.15 | `sessions / (sessions + 2)`——在多样性闸门处取半 |
| 新近度 | 0.15 | 自最后观察起每 30 天减半 |
| 整合度 | 0.10 | 首次与最后观察之间的天数，一周即满 |
| 概念丰富度 | 0.06 | 不同词数，十二个即满 |

### 阶段分离

只有 deep 阶段写入持久记忆。light 与 REM 可以单独运行以供检视，而不改变该作用域已学到的东西；自动周期按顺序运行三个阶段。情景笔记在记忆保留窗口内会反复进入 light——deep 阶段的已提升集合本来就会拒绝第二次提升，正如它对待 feedback 反复报告的失败一样——因此重复的笔记带着衰减后的新鲜度被重新打分，而不是被记作「已消费」。提升存放在本插件自己的域中，绝不写入由模型拥有的经验文档，因此不会出现两个写入方争用同一份文档。

### 失败与恢复

无效记录让域打开时大声失败：丢失一条提升会让下一个周期悄悄重新提供同一个已固化的候选。缺失反馈或记忆接缝只会削弱对应阶段，而不会让周期失败；缺失 heartbeat 仅意味着没有自动计划。不发布 invariant 伴生包，因为域表是这份状态的唯一副本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-evolution-feedback`](../evolution-feedback/README.zh.md)——本周期所消费的已记录失败。
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.zh.md)——驱动它的空闲触发调度器。
- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——自学家族背后的行为契约。

-----

<a id="model-experience"></a>
## 模型体验

无：本周期不添加任何内容——它只对反馈接缝已记录的观察打分并提升，其产出尚未进入任何提示词段落、工具模式或请求。

#### KV Cache 影响

无：本周期不发起任何模型调用，因此不会使 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **相关性基于词面**——该信号按词比较概念。经嵌入提供方做语义比较，才能更严格地排序措辞不同的候选。
- **提升在被读取之前是死胡同**——没有任何东西把已提升的 dream 注入模型上下文；记录是持久的，但尚未被召回。
- **heartbeat 节奏按部署固定**——同一个 `intervalHours` 适用于所有作用域。
- **仅存于本机**——dreams 位于 `$DSH_HOME` 之下，绝不写入项目目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

该服务渲染在「演进式 Harness」子系统页与 capability-seams 图上，并可由 `dsh-command-evolution` 中的 `/dream` 命令触达。

</details>

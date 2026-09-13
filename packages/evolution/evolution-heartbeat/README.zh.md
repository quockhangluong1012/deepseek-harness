---
description: "宿主级空闲触发的任务调度：一个定时器加上自治维护任务注册表，并为每个任务保存持久记账（ctx.evolutionHeartbeat）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-heartbeat

[English](README.md) | 中文

## 概述

`dsh-evolution-heartbeat` 是演进式 Harness 背后的自治维护引擎：消费者注册带各自节奏的具名任务，本插件在宿主空闲时运行它们。它每个宿主只挂载一次并独占一个定时器，因此所有任务共用同一份宿主级调度。任务仅在其间隔已过去、且宿主空闲足够久时才运行；其首次到期检查只写入记账并推迟一个间隔，因此挂载引擎不会让所有任务同时开跑。失败的任务被记录，且不会中断其他任务。

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

每个宿主挂载本插件一次，然后注册任务。注册本身就是全部触发条件：任务仅在其注册存活期间运行，调用返回的注销函数即可移除它。

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.evolutionHeartbeat.register({
    name: 'memory-consolidation',
    intervalHours: 24,
    run: async (signal) => { await consolidate(signal) },
  })
}
```

此后调度由引擎持有：它自行观察宿主级 `session/event` 活动，执行一次启动时到期检查，并在 `unref()` 过的定时器上每隔 `tickMinutes` 重复到期检查，该定时器随插件一并释放。仅当任务的间隔自上次尝试以来已经过去、且宿主空闲达到其阈值时，该任务才会被纳入考虑；完全未观察到会话活动的宿主按空闲计。启动之后再注册也没问题：下一次到期检查会写入该任务的记账并推迟一个间隔。

调用 `runDue` 可自行执行同样的到期检查（`force: true` 同时忽略间隔与空闲门），调用 `runTask` 可立即运行单个任务，调用 `state` 可读取每个任务的节奏与上次结果。

### 配置

引擎的节奏与默认空闲阈值是可在 `cordis.yml` 中修改的、经过校验的 `Config` 成员。每个任务自带间隔，并可在默认值之上抬高自己的空闲阈值。

```yaml
- name: '@deepseek-ai/dsh-evolution-heartbeat'
  config:
    tickMinutes: 10
    minIdleHours: 2
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭时不启动定时器、不运行任务、也不触碰记账 |
| `tickMinutes` | `15` | 宿主级到期检查之间的分钟数 |
| `minIdleHours` | `2` | 任务可运行前所需的最小已观察空闲小时数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-heartbeat)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

每个任务在存储域 `evolution_heartbeat`（版本 `1`、布局 `per-record`、表 `tasks`）中以任务名为键占一行记账，内容为上次尝试的时刻与最近的失败信息；无此行表示该任务从未被尝试过，这正是新注册任务被推迟一个间隔的原因。引擎只在内存中保存注册：重启后由挂载的插件重新注册，持久化的只是记账。

时钟与空闲时长以调用参数进入 `runDue`，而挂载后的插件补上宿主级部分：记录最新活动时刻的 `session/event` 监听器、一次被等待的启动时到期检查，以及通过 `ctx.effect` 释放的 `unref()` 定时器。规格用假定时器驱动调度，因此本插件不携带仅测试用的时钟缝。

### 任务执行

任务按注册顺序串行运行。每次尝试独占一个 `AbortController`，并在插件拆卸时中止，因此长时间任务会观察到释放，而不会比其插件活得更久。无论成功还是失败，每次尝试都会写入记账，因此永久失败的任务按自己的间隔重试，而不是每个 tick 都重试；失败信息写入 `lastError` 并记录一条警告。拒绝被就地收容：记录下来后，本趟继续处理下一个任务。

### 释放

注册返回幂等的注销函数，把任务从注册表移除。被移除的任务保留其记账行，因此重新注册会沿用已存节奏，而不是重新播种。

### 失败与恢复

无效记账会让域打开时大声失败：丢失 `lastRunAtMs` 会重跑首次尝试的播种并让每个任务的节奏偏移。引擎启动前的读取会抛错。失败的注册——重名、非路径安全的名字、低于一小时的间隔、或负的空闲阈值——会在写入任何内容之前抛错。失败的定时趟次会被捕获并警告，定时器与记账保持完好，等待下一个 tick。

不发布 invariant 伴生包：域表是这份状态的唯一副本，不存在可供核对的第二个独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——自学家族背后的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [`dsh-evolution-curator`](../evolution-curator/README.zh.md)——本引擎的空闲门所参照的技能生命周期维护趟次。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-heartbeat)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无：本调度器不注册任何模型可见内容。

#### KV Cache 影响

此处没有任何东西进入模型请求，因此 provider 缓存复用不受影响。调用模型的已注册任务自持其请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本引擎不适合的场景。它们是当前包约束。

- **任务串行运行**——一趟按注册顺序依次等待每个任务，永不结束的任务会阻塞该趟中其后的所有任务。可能长时间运行的任务必须自行设界。
- **超时归任务自己所有**——引擎在拆卸时给出中止信号，但不施加单任务截止时间，因此挂起的任务只能由释放来解除。
- **失败按间隔重试**——失败的尝试会写入 `lastRunAt`，因此坏掉的任务要等满一个间隔，而不是快速退避重试。
- **注册只存在内存**——重启会丢弃全部注册；由挂载的插件重新注册，仅记账是持久的。
- **任务首次运行被推迟**——新注册的任务会被播种并跳过，其首次真正运行要等一个间隔。
- **没有任务级开关**——任务恰在其被注册期间启用；`enabled: false` 是唯一的全局开关。
- **仅存于本机**——记账位于 `$DSH_HOME` 之下，绝不写入项目目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

策展器自带一套等价的空闲门与宿主级定时器。把它迁移到本注册表之上会让调度实现只剩一份而非两份，但那会改变已发布、已测试的策展行为，因此该迁移被刻意排除在本包的引入之外。尚无设计负责人。

</details>

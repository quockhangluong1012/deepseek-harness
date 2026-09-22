---
description: "不可变会话轨迹投影：基于已提交的会话日志，产出带排序根因归因的结构化学习轨迹与压缩摘要（ctx.evolutionTrace）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-trace

[English](README.md) | 中文

## 摘要

`dsh-evolution-trace` 把已提交的会话日志变成进化回路所需的结构化学习轨迹：每个 turn、每个 step 的工具调用及其结果、模型尝试的重试、中断、token 用量与延迟，并为每个失败的工具调用附上排序的根因候选，每个会话再压缩成一条学习轨迹行。此处不调用任何模型，也不写入新的存储域——会话日志本身就是不可变的原始轨迹，因此本存储按需从它推导出机器可读与压缩两种形态。宿主命令 `command-evolution` 通过 `/trace <sessionId>` 读取它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件即可，投影无需额外接线。用 `trace` 投影一个会话的日志，或用 `summary` 把若干会话压缩成按决策排序的行。

```ts
const record = await ctx.evolutionTrace.trace(sessionId)
if (record === undefined) {
  console.log('storage holds no such session')
} else {
  for (const turn of record.turns) {
    console.log(`turn ${turn.turn} [${turn.endReason ?? 'open'}]: ${turn.request}`)
    for (const failure of turn.failures) {
      console.log(`${failure.tool} failed: ${failure.message}`)
      for (const cause of failure.causes) console.log(`  ← ${cause.reason}`)
    }
  }
}
```

```ts
const rows = await ctx.evolutionTrace.summary(workspace.sessionIds, 10)
for (const row of rows) {
  console.log(`${row.sessionId}: ${row.failures} failure(s), ${row.retries} retr(ies), ${row.tokens} tokens`)
}
```

`/trace` 命令为运维人员渲染一个会话的结构化轨迹：一行头部、每个 turn 一行（含请求与结局）、每个工具调用一行，以及每个失败下方的排序根因候选。

### 配置

投影默认开启；每个字段都是可验证的 `Config` 成员，可在 `cordis.yml` 中修改。

```yaml
- name: '@deepseek-ai/dsh-evolution-trace'
  config:
    maxChars: 300
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxChars` | `500` | 一条失败或请求摘要的字符预算 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-trace)是每个已接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

会话日志是不可变的原始轨迹（规范 §3.3 的形态一）；本包只拥有派生形态。`project` 是纯函数：按序号顺序消费已提交的 `SessionEvent` 并构建 `TraceRecord`——turn 携带请求摘要、结局、延迟与 step；step 携带工具调用、重试证据、中断标志与 token 用量；每个 turn 再携带失败列表。读取路径会先冲刷活动的会话，使查询能看到已送达模型的 turn。此处不存储任何东西：重启后从同一份日志推导出相同的记录，且只有一个权威来源。

信用分配（规范 §3.2）是确定性的邻近启发式，绝非模型判断：失败调用排第一，随后是其所在 step 中早于它的调用（输入生产者）、上一步的调用（上下文生产者）、名称含 `skill` 或 `memory`、可能遗漏了知识的检索调用，最后是 turn 的请求。日后分析者可以用实测归因替换该排序；schema 在两种情况下都保持稳定。

`summarize` 把一条记录压缩成学习轨迹行：计数、累计 token 与延迟，以及按首次出现顺序排列的去重失败摘要。`summary` 按最优先决策排序——失败最多、重试最多、token 最多、最新——因此消费者在上限之前先看到最值得学习的会话。

### 失败与恢复

存储没有某会话日志时，读取视作缺失，`summary` 跳过它；任何其他持久化失败都保持响亮失败。畸形的或重复的日志结构（重复打开 turn、未配对的工具调用或结果、针对从未打开的 step 的事件）会被投影丢弃，而不会破坏记录；原始日志保留一切以便审计。

本包不发布不变的伴生检查，因为会话日志是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) — 本包实现的轨迹/信用/压缩机制族。
- [进化包地图](../README.zh.md) — 该组的包及其仓库位置。
- [`dsh-evolution-trajectory`](../evolution-trajectory/README.zh.md) — 把同一份日志塑造成 ShareGPT 对话以供评测的姊妹导出器。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-trace) — 每个已接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无，本存储不注册任何面向模型的东西。

#### KV 缓存影响

此处没有任何内容进入模型请求，因此不影响供应商缓存复用。把轨迹行渲染进提示词的消费者拥有该请求的前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了本存储在何种情况下不合适。它们是当前的包约束。

- **归因是启发式，不是结论** —— 原因按结构邻近度排序；此处并不度量某个原因是否真正起作用，因此读者不得把排序当作实测的指责。
- **不保留参数** —— 结构化轨迹保留调用身份、工具名与结果摘要，但不保留原始工具参数；会话日志为了审计会保留它们。
- **摘要是截断而非总结** —— 失败只保留前 `maxChars` 个字符，因此两条不同的长失败可能在一条摘要上碰撞。
- **尚无活动总线消费者** —— 投影读取路径是当前表面；turn 结清事件与其学习系统消费者随 curriculum 与 shadow/canary 工作（P1）落地。
- **仅限本机** —— 读取只针对本地会话持久化，绝不指向远程存储。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`command-evolution` 是当前唯一消费者（`/trace` 命令）。摘要排序刻意面向决策（失败优先），使压缩行日后无需再推导优先级即可喂给未来的 curriculum 或 shadow runner。

</details>
---
description: "基于已提交会话日志的会话轨迹投影：带排序根因归因的结构化学习轨迹、基线与候选的反事实回放，以及压缩摘要（ctx.evolutionTrace）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-trace

[English](README.md) | 中文

## 概述

读一个会话的已提交日志，得到结构化学习轨迹：turn、step、工具调用及其已记录输出、重试、上下文摘要、计划、检索、最终回答、评估、人类反馈、成本与延迟，每个失败调用带排序根因，每个会话一行。还能把一条已记录轨迹针对基线与候选两个产物修订回放——读取已记录的工具输出而非重新调用任何东西，因此无密钥、确定、不写入。此处不调用模型，也不开存储域：会话日志就是原始轨迹。回放无法重建的 step 会被点名，绝不猜测。`/trace <sessionId>` 命令读取它。

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

挂载插件即可，投影无需额外接线。用 `trace` 投影一个会话的日志，用 `summary` 把若干会话压缩成按决策排序的行，或用 `replay` 把一条已存储的轨迹针对两个产物修订做回放。

```ts
const record = await ctx.evolutionTrace.trace(sessionId)
if (record === undefined) {
  console.log('storage holds no such session')
} else {
  for (const turn of record.turns) {
    console.log(`turn ${turn.turn} [${turn.endReason ?? 'open'}]: ${turn.request}`)
    console.log(`  plan: ${turn.subgoals?.map(goal => `${goal.content} (${goal.status ?? 'no status'})`).join('; ') ?? 'none'}`)
    for (const retrieval of turn.retrievals) console.log(`  retrieved via ${retrieval.tool}: ${retrieval.target}`)
    for (const step of turn.steps) console.log(`  step ${step.step} under context ${step.context?.digest ?? 'unrecorded'}`)
    for (const failure of turn.failures) {
      console.log(`${failure.tool} failed: ${failure.message}`)
      for (const cause of failure.causes) console.log(`  ← ${cause.reason}`)
    }
    if (turn.finalAnswer !== null) console.log(`  answer: ${turn.finalAnswer}`)
  }
  for (const evaluation of record.evaluations) console.log(`evaluated ${evaluation.status}`)
  for (const remark of record.feedback) console.log(`human said: ${remark.text ?? '(no text)'}`)
}
```

```ts
const rows = await ctx.evolutionTrace.summary(workspace.sessionIds, 10)
for (const row of rows) {
  console.log(`${row.sessionId}: ${row.failures} failure(s), ${row.retries} retr(ies), ${row.tokens} tokens`)
}
```

```ts
const report = await ctx.evolutionTrace.replay(sessionId, baselineArtifact, candidateArtifact)
if (report !== undefined) {
  console.log(`candidate ${report.candidate} changes ${report.changedSteps.join(', ') || 'nothing'}`)
  console.log(`replayed from snapshots: ${report.snapshotSteps.join(', ')}`)
  console.log(`could not replay: ${report.unreplayableSteps.join(', ') || 'none'}`)
}
```

`ReplayArtifact` 是调用者对某个产物修订的声明：`{ id, version, body }`，其中 `id` 是轨迹中某次检索所点名的目标。当存储没有该会话时，`replay` 与 `trace` 一样返回 `undefined`。

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
| `maxChars` | `500` | 一条失败、请求、检索目标、工具输出快照或最终回答摘要的字符预算 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-trace)是每个已接受字段的穷尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计概念

会话日志是不可变的原始轨迹（规范 §3.3 的形态一）；本包只拥有派生形态。`project` 是纯函数：按序号顺序消费已提交的 `SessionEvent` 并构建 `TraceRecord`——turn 携带请求摘要、结局、延迟、计划、检索、最终回答与 step；step 携带工具调用、重试证据、中断标志、token 用量与编译上下文身份；每个 turn 再携带失败列表。读取路径会先冲刷活动的会话，使查询能看到已送达模型的 turn。此处不存储任何东西：重启后从同一份日志推导出相同的记录，且只有一个权威来源。

编译记录、计划修订或待办快照会绑定到它到达时正在打开的那个 turn 或 step，并向其后的 turn/step 顺延，因此后到的记录绝不会覆盖已经关闭的区段。这就是投影同时跟踪开启者与关闭者（`step/end`、`turn/end`）的原因。

### §3.1 轨迹条目

规范 §3.1 的清单，对照已提交会话日志实际记录的内容：

| §3.1 条目 | 来源 | 备注 |
|---|---|---|
| 请求与已解析的任务规格 | 每个 turn 的 `user/message` 摘要 | 已解析的规格本身没有被单独记录 |
| 上下文快照/哈希 | `context/compiled` → `step.context.digest` | 是身份，不是内容 |
| 计划与子目标 | `todo/write`（带状态）与 `task/plan`（不带状态） | 生效中的最新记录胜出 |
| 模型调用 | step 自身：尝试、用量、中断 | 不投影每次调用的路由身份 |
| 工具调用与输出 | `tool/call` + `tool/result` | `snapshot` 保留结果文本，按预算截断 |
| 中间决策 | — | 无法取材：没有任何已记录事件记录决策 |
| 错误与重试 | `tool/result` 的错误块、`assistant/attempt` | |
| 检索到的记忆/技能 | 名称含 `skill`/`memory` 的检索调用，及其点名的目标 | |
| 最终回答/动作 | 该 turn 内最后一条助手消息文本 | |
| 评估结果 | `verification/result` | |
| 用户反馈 | `feedback/record` | |
| 成本/延迟 | 每个 step 的 `TokenUsage`、turn 开启到关闭 | |
| 使用的产物版本 | — | 无法取材：没有任何已记录事件记录被检索产物的修订，因此回放的两个修订都由调用者给出 |

日志没有记录的条目在 `TraceRecord` 中是缺失的，而不是以占位符形式发出。投影从其他包的载荷类型读取的几行（`context/compiled`、`task/plan`、`verification/result`、`todo/write`、`feedback/record`），在部署未挂载对应插件时不贡献任何内容：投影看不到这类事件，其字段即为空。

### 信用分配

信用分配（规范 §3.2）是确定性的邻近启发式，绝非模型判断：失败调用排第一，随后是其所在 step 中早于它的调用（输入生产者）、上一步的调用（上下文生产者）、名称含 `skill` 或 `memory`、可能遗漏了知识的检索调用，最后是 turn 的请求。日后分析者可以用实测归因替换该排序；schema 在两种情况下都保持稳定。

### 压缩

`summarize` 把一条记录压缩成学习轨迹行：计数、累计 token 与延迟，以及按首次出现顺序排列的去重失败摘要。`summary` 按最优先决策排序——失败最多、重试最多、token 最多、最新——因此消费者在上限之前先看到最值得学习的会话。

### 反事实回放

`replayTrace` 在轨迹所能支撑的保真度上回答 §16 的问题：这次运行在基线修订与候选修订下分别会产出什么？已记录的工具结果是基底——不重新调用任何工具、不调用任何模型、不写入任何内容，因此回放无需密钥，且对同一条轨迹是确定性的。

重建读取轨迹自身：每个 step 记录的上下文摘要，以及两个修订共同点名的产物。产物的可观测效果体现在检索表面。当轨迹记录的某次检索点名的目标正是某个修订所声明的产物**且该检索的结果已被记录**时，回放输出就是恢复后的正文；其余调用一律从已记录的快照回放。因此每个 step 会逐调用报告其输出来自何处——`snapshot`、`artifact` 或 `missing`——报告还会点名仅凭快照回放成功的 step、候选改变了哪些 step，以及哪些 step 无法重建。

快照是回放性的闸门。日志未记录文本结果的调用没有基底，因此其 step 在两个修订下都是 `unreplayable`，且绝不会被报告为「未变」：产物正文刻意不会替它顶替，因为那等于对那次记录运行所见内容的猜测。恢复不写入任何东西——恢复后的正文存在于报告中而非磁盘上；希望把产物状态落到实际工作区的调用者自己负责那次写入。

### 失败与恢复

存储没有某会话日志时，读取视作缺失，`summary` 跳过它；任何其他持久化失败都保持响亮失败。对没有日志的会话，`replay` 返回 `undefined`，与 `trace` 的契约一致。畸形的或重复的日志结构（重复打开 turn、未配对的工具调用或结果、针对从未打开的 step 的事件、对已关闭区段的第二个关闭者）会被投影丢弃，而不会破坏记录；原始日志保留一切以便审计。

本包不发布不变的伴生检查，因为会话日志是此状态的唯一副本，没有第二个独立观测可供比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进化式 Harness 规范](../../../specs/evolutionary-harness-v11-deep-research.md) — 本包实现的轨迹、信用分配、压缩、反事实（§16）与回放（§17）机制族。
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
- **产物版本不在会话日志中** —— 没有已记录事件记录被检索产物的修订，因此轨迹无法携带它，回放的两个修订都由调用者以 `ReplayArtifact` 给出。恢复了错误修订的调用者只会得到一对错误修订的比较，此处无法察觉。
- **不保留参数** —— 结构化轨迹保留调用身份、工具名与结果摘要，但不保留原始工具参数；会话日志为了审计会保留它们。唯一的例外是检索调用的目标，它从参数中读出以命名被检索之物。
- **摘要是截断而非总结** —— 失败只保留前 `maxChars` 个字符，每个已记录的工具输出快照、请求、检索目标与最终回答同样如此，因此两个不同的长值可能在某条摘要上碰撞。
- **上下文以身份而非内容承载** —— 轨迹保留编译的 `digest`，而非生成该布局的提示词文本；那段文本留在日志自身的 `system/message` 表面上。
- **交错的 step 不属于本形态** —— 编译或计划记录绑定到它到达时唯一打开的那个 step 或 turn。harness 一次只跑一个 step，真实日志即如此；真正并发 step 的日志只会把这类记录绑定到最近的那个上。
- **回放只触达检索表面** —— 产物的可观测效果是点名它的那次检索的输出。若候选的差异不改变任何被检索产物的输出，回放结果与基线完全相同；这是本模块的保真度上限，而非「两个修订行为一致」的断言。
- **回放比较输出，不比较优劣** —— 它报告两个修订在何处不同、哪个 step 无法重建，从不判定哪个修订更好。要判定优劣，需要评分器在语料上测得的三元组。
- **尚无活动总线消费者** —— 投影与回放两条读取路径是当前表面；turn 结清事件与其学习系统消费者随 curriculum 与 shadow/canary 工作（P1）落地。
- **仅限本机** —— 读取只针对本地会话持久化，绝不指向远程存储。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`command-evolution` 是当前唯一消费者（`/trace` 命令）。摘要排序刻意面向决策（失败优先），使压缩行日后无需再推导优先级即可喂给未来的 curriculum 或 shadow runner。

回放路径是针对一条已投影记录的纯函数，因此轨迹存储对会话日志保持只读：`replayTrace` 不写入任何内容，也不触碰工作区。它刻意不是评分器的进程运行器——后者针对磁盘上的夹具启动全新子进程，而本回放只在日志已持有的轨迹上比较两个修订。

此处不需要类 `SCORER_VERSION` 的版本号：轨迹没有 schema 版本，因为每次读取都重新推导，所以「它携带什么」的改动立即生效而无需盖号。真正需要版本号的是把派生投影持久化的消费者。

</details>

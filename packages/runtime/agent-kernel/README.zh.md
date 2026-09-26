---
description: "Agent Kernel：每个会话一份持久任务契约、工具流水线上的动作账本、基于能力的权限引擎，以及完成门禁，供用户和维护者治理 Harness 允许并记录的内容。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-kernel

[English](README.md) | 中文

## 概述

当一次部署必须从持久证据回答「任务原本要做什么、Harness 允许了什么、它为什么停下」时，就使用 `dsh-agent-kernel`。它为每个会话记录一份持久任务契约、为每次工具调用记录一条决策记录、为每个步骤记录一个控制决策，并提供一个只有在全部必需标准都通过时才放行的完成门禁。它不拥有任何执行，`mode: 'shadow'`（默认）不改变任何行为，且一个会话同一时间只持有一个任务。当工具面完全可信、会话日志已经能回答这些问题时请避开它：它会给每次工具调用增加一条审计记录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一次部署需要持久治理记录或完成门禁时，在 profile 中挂载该插件。不做任何配置地挂载时，它以 shadow 模式在默认 `ask` 策略下记录，并且不拒绝任何东西，因为没有任何东西被强制执行。已附带的 `web`、`headless`、`sdk` 与 `acp` profile 都这样挂载它——kernel、内置声明与 prompt-injection 守卫全部处于 `shadow`——因此这些平面上的每个会话都带有持久记录，而尚无任何决策具有约束力；`@deepseek-ai/dsh-agent-governance` 则是供其他 profile 使用的同一治理面的可选 bundle。

### 何时选择它

当工作事后必须可归因时选择它——无人值守的运行、多 agent 组合，或"完成"必须是证据而非模型陈述的任务。当工具面完全可信、且会话日志已经承载你所读取的一切时请避开它，因为 Kernel 为每次工具调用增加一条审计记录。

### 配置权限文档

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    mode: shadow
    policy:
      defaults:
        effect: ask
      rules:
        - action: read
          resource: 'workspace/**'
          effect: allow
        - action: write
          resource: 'workspace/**'
          effect: allow
        - action: shell
          resource: 'git status *'
          effect: allow
    budgets:
      maxSteps: 100
      maxToolCalls: 200
    acceptance:
      - id: build
        description: the package builds
        verifier: build
        required: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `shadow` | `shadow` 记录决策且不改变任何行为；`enforce` 把它们交还工具流水线 |
| `agentProfile` / `policyProfile` | `default` | 记录在本 Kernel 创建的每份任务契约上的名称 |
| `budgets` | `{}` | 创建的每份任务契约起始时的上限；未设置即无上限。`maxConcurrentActions` 限定一个任务可同时在飞的动作数 |
| `policy` | `{ defaults: { effect: ask }, rules: [] }` | 权限文档；见[权限规则](#policy-rules) |
| `acceptance` | `[]` | 创建的每份任务契约起始时的标准，适用于没有任何 `acceptanceByClass` 条目指定的类别；没有必需标准时 Kernel 不运行验证 |
| `acceptanceByClass` | 每类各自的内置默认值 | 某一类任务起始时采用的标准，会同时覆盖 `acceptance` 与该类的内置默认值。内置默认值：`coding` 为 `typecheck`、`lint`、`test` 与 `diff`；`research` 为一条引用标准；`conversational` 与 `operations` 为空。把标准 id 或验证器族映射到命令属于验证器包的配置 |
| `outputTruncatedRetryTokens` | `16000` | 截断轮次之后的那个步骤请求时使用的输出 token 上限，记录在循环写入的请求头中。每次截断只重试一次；重试后仍被截断时改为引导模型拆分工作 |
| `verificationCacheSize` | `256` | 保留的标准结果数量，以标准 id 与仓库摘要为键 |
| `verificationCacheTtlMs` | `600000` | 保留的标准结果可被复用的毫秒数 |
| `requireAcceptanceCriteria` | `false` | 没有任何标准的任务是否允许完成 |
| `allowHumanOnlyCompletion` | `false` | 唯一通过证据由人类报告的任务是否允许完成 |
| `maxAttemptsPerAction` | `2` | 恢复引擎据此报告剩余尝试次数的重试上限 |
| `checkpointBeforeRetry` | `true` | 重试是否被记录为需要先做检查点 |
| `maxPlanRevisions` | `32` | 每个任务的计划修订上限；需要更多修订说明任务在打转，下一次修订会被明确拒绝 |
| `untrustedContent` | `quarantine` | 工具声明 `trust: 'untrusted'` 的提案如何裁决：`quarantine` 将合成结果上限压在 `ask`，因此仅凭权限 `allow` 永远无法授权外部内容；`allow` 则让权限文档成为唯一权威 |
| `loopOscillationRun` | `4` | 在两个工具之间交替的调用数达到该值时，Governor 将该运行读作振荡并给出 `stop_loop` |
| `loopSemanticDuplicateRun` | `3` | 连续的近似重复调用对达到该值时，它将该运行读作以不同措辞重复同一意图 |
| `loopSemanticSimilarity` | `0.8` | 两个同工具调用的参数 token 重合度（`(0, 1]`）达到该值时视为同一意图 |
| `loopStagnantStepRun` | `3` | 连续步骤在 `StepDelta` 各轴上都没有移动达到该值时，该运行是无进展循环 |
| `loopNarrationStepRun` | `3` | 连续步骤既无工具调用也无状态变化达到该值时，该运行是纯叙述循环 |
| `loopFailureRun` | `3` | 同一未解决失败类型被记录的次数达到该值时，该运行是失败循环 |
| `contextPressureRatio` | `0.8` | 任务 `budgets.maxTokens` 上限的占用比例达到该值时，Governor 请求压缩 |
| `livenessWindowMs` | `180000` | 既无进展也无活动的毫秒数达到该值时，活性监视器记录一条 `stalled` 失败 |
| `codingLifecycle` | 全部九个阶段、无上限、评审关闭 | 类别为 `coding` 的任务所跑的 §10.5 流水线：`phases`（必须以 `understand` 开头、以 `complete` 结尾）、`budgets`（每个阶段的正整数步骤上限，自该阶段最近一次进入起计数），以及 `review`（`enabled` 与独立评审所检查的 diff `ref`）。未列入 `phases` 的阶段被跳过；`review.enabled` 为 false 时 REVIEW 被跳过；其他类别的任务不跑流水线 |

非空的 `resource: ''`、未知的 `action`、未知的 `effect`，或未知的默认 effect 都会以明确错误使插件加载失败，因此权限文档绝不会静默失效。全部被接受的字段列在生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-kernel)中。

<a id="policy-rules"></a>
### 权限规则

一条规则选择一种动作族和一种资源 glob。`**` 匹配任意字符序列（包括 `/`），`*` 匹配不含 `/` 的字符序列，`?` 匹配一个不含 `/` 的字符，其余字符皆为字面量。求值从宽到窄，**最后**一条匹配的规则胜出，因此窄例外放在它所收窄的宽规则之后。

| 动作族 | 选中它的能力 |
|---|---|
| `read` | `fs.read` |
| `write` | `fs.write` |
| `edit` | `fs.edit` |
| `shell` | `process.exec`、`terminal.interactive` |
| `network` | `network.read`、`network.write` |
| `mcp` | `mcp.call` |
| `delegate` | `subagent.spawn` |
| `workflow` | `workflow.start` |
| `memory` | `memory.read`、`memory.write` |
| `policy` | `approval.request`、`policy.propose` |

规则从不指名工具。拥有工具的那个包通过 `ctx.agentKernel.capabilities.register()` 声明一次调用需要什么，并从该调用自身已解析的参数投影出资源。没有声明的工具解析为 `undefined` 并被拒绝，绝不会被隐式授予。

### 你会得到什么

每个被接纳的步骤开启一份任务契约：`task/created` 携带目标、约束、验收标准、调用方声明的变更契约、工作区、profile 与预算，处于 `status: 'intake'`、`revision: 1`；`task/transitioned` 记录之后的每次迁移。每次工具调用被记录为一条 `action/decided`，其中携带提议、规则决策、组合后的授权（以及它所授予的能力、是否拒绝了该调用）；另有 `action/committed`，携带治理回执，指明沙箱模式、工作区根目录，以及被询问时的人类结果。每个步骤边界记录一条 `governor/decided`，携带该决策、其理由、刚结束那一步所产生的移动以及归一化进度分数。每个在带必需标准的任务上结束的轮次都会记录 `verification/requested`、`verification/result`，而当门禁拒绝完成时，还记录 `failure/recorded` 与 `recovery/decided`。每个子 agent 都携带一份 `delegation/received` 回执，在创建时写入自己的日志：其父级下发的权能、可写范围、预算与深度，父级日志上则留一份 `delegation/issued` 作为审计副本。

四个决策被有意分开。规则决定 `allow`、`ask` 或 `deny`；实现的沙箱仍可能拒绝其边界之外的写入能力；子 agent 的委派回执仍可能扣留其父级从未授予的能力、资源或深度；而 `ask` 由已组合的审批应答链决定，缺少应答者时按失败关闭处理。拒绝被记录为 `outcome: 'denied'`，绝不记录为执行失败。

预算是父级与其子级共享的一池额度，而不是每个子级各拿一份副本。委派交下去的是父级仍能承诺的部分——它的实测剩余额度，减去在飞子级已占的持有量与已结算子级已上报的花费——Kernel 一直持有这份授予直到子级结算：跑过的子级按它用掉的步数、工具调用、token 与墙钟时间被扣减，从未开启任务的子级则释放其持有量。会让在飞动作数超过 `maxConcurrentActions` 的调用会被组合为一条拒绝，并在理由中写明当前数量，因此该上限记录在动作上，而不是靠猜测模型的行为。

### 读取一个任务

公开界面是 `ctx.agentKernel`：

| 成员 | 回答什么 |
|---|---|
| `state.view(session)` | 当前任务契约、预算观测、未完成动作、未解决失败、最新计划、最新检查点，以及 agent 为子级时的委派回执 |
| `viewOf(sessionId)` | 按会话身份读取实时 agent 的当前 Kernel 视图；该身份未注册实时 agent 或任务时返回 undefined |
| `attach(agent)` | 一个句柄，其 `snapshot()` 读取实时视图、`dispose()` 释放 Kernel 的引用；插件卸载会等待所有已打开句柄释放 |
| `capabilities.register(declaration)` | 声明一个工具的能力，并可选声明它所处理内容的信任度，返回 disposer |
| `profiles.register(profile)` | 注册一个 agent 角色——其能力授予、策略 profile 与各项上限——并返回 disposer |
| `registerPolicyProfileProvider(provider)` | 选择该会话的策略层，并与部署文档求交，返回 disposer |
| `verifiers.register(verifier)` | 向完成门禁提供标准结果并返回 disposer |
| `lifecycle.registerReviewer(reviewer)` | 为 §10.5 的 REVIEW 阶段提供独立评审并返回 disposer；`lifecycle.current(session)` 读取任务所处的阶段，`lifecycle.advance(session, phase)` 记录它，`lifecycle.completionPredicate(session)` 报告任务记录过的阶段 |
| `verify(agent, changedScopes)` | 记录一次验证请求与结果并返回完成决策 |
| `checkpoint(agent, reason)` | 在当前会话序列处记录当前 Kernel 状态的索引 |
| `recordEvidence(agent, input)` | 记录一条供断言引用的观测并返回它 |
| `recordClaim(agent, input)` | 依据本会话已记录的观测断言一条 claim 并返回它 |
| `recordHypothesis(agent, input)` | 记录一个任务正在检验的问题并返回它 |
| `readKernelMetrics(events)` | 把一个会话的 Kernel 事件折叠成本平面自有的计数器（任务、验证、动作、失败、恢复、检查点） |
| `budgets.measure(task, session)` / `budgets.available(session)` | 一个任务的实测花费与剩余额度，以及扣除在飞子级所占持有量与已结算子级所报花费后，该会话仍能承诺的部分。该观测还携带 `background`，即后台预算所有者（profile 挂载了 `ctx.evolutionBudget` 时）花掉的量；它与会话自身的用量并列被读取，却不从中扣减任何额度：会话内的上限仍由 `guard/budgets` 执行，后台花费仍由其所有者自行把门 |
| `budgets.reserve(session, amount, runId?)` | 为即将运行的工作持有该会话额度的一部分，以它现有的可用量为上限，并返回该持有量 |
| `budgets.commit(reservationId, actual?)` / `budgets.release(reservationId)` | 用工作实际花掉的部分结算一份持有量，或因工作从未运行而结束它 |
| `startupRecovery` | 已存会话的一次性只读扫描；每个非终态任务都按证据原因分类为可继续、可修复或受阻 |

任务状态的唯一事实来源是会话日志：ledger 在按会话游标之后折叠 `task/*`、`action/*`、`evidence/recorded`、`claim/updated`、`failure/recorded`、`verification/result`、`checkpoint/created`、`delegation/received`、`evidence/recorded`、`claim/updated`、`hypothesis/updated`、`step/start` 与 `tool/call` 事件，因此重放会重建同一视图。进程还提供 `startupRecovery`，它是从已存会话推导的一次性只读分类，不会取代日志。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释 Kernel 如何得知发生了什么、以及在何处介入；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 验证失败与修复

达到所配置步骤上限的任务会获得最后一个不使用工具的步骤：Kernel 记录一条 `step-ceiling` 失败，将其归类为 `checkpoint-pause`，接纳该步骤并把其中的每次调用合成为拒绝——模型只能依据已有结果作答——随后该步骤所在的轮次记录 `before-pause` 检查点并把任务置为 `paused`。此后提出的步骤会被拒绝而非接纳，且该失败每个任务只记录一次。循环因为模型达到输出上限而结束的轮次（`turn/end` 的 `max-tokens` 原因）会在其后的步骤上被记录为 `output-truncated` 失败——因为结束原因是在本 Kernel 的 turn-stopping 监听器运行之后才写入的；该步骤的请求会按 `Config.outputTruncatedRetryTokens` 重试一次，若重试后仍被截断，则改为引导模型拆分工作。以其他原因结束的轮次会使该失败得到消解，因此不再阻塞完成。注册表在任何审批之前拒绝的工具调用（schema 或 JSON 违规，报为 `INVALID_ARGS`）会依据到达模型的结果被记录为 `tool-args-malformed`，因此模型收到的是解析或 schema 错误，也不会出现审批提示。同一个会话第三次以相同参数调用某个工具、且返回结果也相同时，就是一次 `no-progress` 失败：回执记录每次调用返回内容的摘要，一旦两次相同的调用构成一段行程，Kernel 就记录该失败；在 `enforce` 模式下还会拒绝第三次调用，并给出要求模型先整合已有信息的理由。`tool-args-malformed` 由同一张表分类，其检测器属于观测那个 seam 的包；而 `stalled` 由 Kernel 自己的活性监视器记录（见 [Governor](#governor)）。

以验证失败结束的轮次会记录该失败、把任务置为 `recovering`，并发送一条修复消息，其中列出门禁的理由；重复次数受 `Config.maxRepairAttempts`（默认 3）限制。超过上限后任务带着同样的理由转入 `awaiting-user`，因为无法收敛的修复循环属于人的决策。此后若有验证通过，就会解除先前的 `verification-failed` 失败，因此完成判定读取的是通过结果。§8.5 的回归环节则反向做同样的检查：某条判据在同任务的先前验证中通过、而在本次验证中不再通过时，会记录为 `verification-regressed`、在修复消息中点名，并计入同一个 `Config.maxRepairAttempts`；由于该环节只比较注册表已经产出的结果——当前仓库摘要已由结果缓存回答的判据直接取自缓存——它绝不会把同一个验证器跑两次。

### 编码生命周期（§10.5）

类别为 `coding` 的任务跑一条被记录的流水线——UNDERSTAND → MAP → PLAN → CONTRACT → IMPLEMENT → LOCAL VERIFY → REVIEW → REGRESSION → COMPLETE——每次进入阶段都是一条 `task/phase` 事件，因此任务走过的流水线可以从它自己的日志重建。`Config.codingLifecycle` 决定跑哪些阶段（`phases`）、每个阶段的步骤上限（`budgets`，从该阶段最近一次进入起计数），以及 REVIEW 阶段是否派生独立评审（`review.enabled`，默认关闭）。`phases` 中未列出的阶段会被跳过；评审开关关闭时 REVIEW 同样被跳过，因为实现者不运行的阶段就是任务不会走过的阶段；其他类别的任务不跑流水线，对话型任务照旧完成。

Kernel 从它本就拥有的接缝驱动这条流水线：被接纳的步骤记录 MAP（在 UNDERSTAND 之后），一次计划修订记录 PLAN，首个结算的 `fs.write` 或 `fs.edit` 动作记录 CONTRACT 与 IMPLEMENT，轮次结束记录 LOCAL VERIFY，检查通过后运行 REVIEW、REGRESSION 与 COMPLETE。LOCAL VERIFY、REVIEW 或 REGRESSION 失败时走修复边回到 IMPLEMENT，经由 `Config.maxRepairAttempts` 限定的同一套失败、恢复决策与单条修复消息，因此一次失败的检查是一次修复而不是循环；达到步骤上限的阶段不会被再次进入，任务转入 `awaiting-user`。`completed` 迁移携带一条 `lifecycle-phases` 前置条件，列出该任务记录过的阶段。

REVIEW 每个 REVIEW 条目只运行一次已注册的独立评审，把其结构化报告记录为 `task/review`，并像失败的检查一样把发现的问题送回工作。`review.enabled` 打开却没有注册评审时，任务绝不会静默完成：Kernel 记录这一错误配置并把任务转入 `awaiting-user`。

### Governor

每个步骤边界都会在步骤运行之前组合出一个控制决策。`composeGovernorDecision` 按以下顺序读取事实，第一个成立的即胜出：终态任务给出 `stop_success` 或 `stop_failure`；活性监视器报告的停顿给出 `stop_timeout`；已耗尽的花费上限（`maxSteps`、`maxToolCalls`、`maxTokens`、`maxWallMs` 或 `maxCostUsd`，以预算观测中该轴的剩余量判读）给出 `stop_budget`；某个循环检测器给出 `stop_loop`；达到任务 `maxTokens` 的 `contextPressureRatio` 给出 `compact`；最新一条未解决失败给出引擎已经为它决定的恢复动作——`retry`、`replan`、`compact`、`delegate`、`ask_user` 或某个停止；其余情况给出 `continue`。决策在据其行动之前先追加为 `governor/decided`。只有五个 `stop_*` 决策会改变行为，且只在 `mode: 'enforce'` 下：Kernel 拒绝 `agent/pre-step`，该轮次以 blocked 结束，待处理输入留在收件箱等待下一次唤醒，而不是被丢弃。

进度监视器把每个步骤度量为一个 `StepDelta`：该步工具调用中工具与参数未被近期调用历史见过的比例、任务是否推进了 revision、是否记录了观测或论断、会话目标是否移动、未解决失败是否减少、是否记录了计划修订。`progressScore` 是这六项的均值，因此一个调用了新工具的步骤与一个记录了证据的步骤都会得到一份分数。

五个检测器读取同一份状态。振荡是两个工具之间交替调用的尾部行程（A-B-A-B）。语义重复是工具与其前一次调用相同、参数相似度至少达到 `loopSemanticSimilarity` 但不完全相同的调用。停滞是一段分数始终为 0 的步骤行程，纯叙述是一段既未调用工具也未产生移动的步骤行程。失败循环是同一未解决类型被记录 `loopFailureRun` 次。第一个成立的检测器每个事件片段记录一条 `no-progress` 失败——该片段在有步骤产生移动时结束，而那一步正是解除它的东西，与新的计划修订解除 plan drift 完全一致。

活性监视器在每一帧模型输出上盖上 `lastFrameAt`，在每次工具调用被提议或结算时盖上 `lastToolEventAt`，在每一步产生移动时盖上 `lastProgressAt`。每次检查（相隔 `livenessWindowMs` 的四分之一）它会找一个会话：其 agent 正在运行、其任务自行预期进展、且其进度与活动都早于窗口，并以 `stalled` 失败记录每个安静片段，按当时在飞的东西分类：`tool` 表示从未结算的调用，`transport` 表示没有产出任何帧的请求，`stream` 表示产出过帧之后停止的请求，`child-agent` 表示被委派的子级，`agent` 表示没有任何在飞工作的运行。此后产生移动的步骤会清除停顿，因此下一次决策不再回答它。

### 自动检查点（§17.1）

`checkpoint(agent, reason)` 也会被自动调用，因此恢复运行永远不会重放超过 Kernel 已经索引过的那个点：每个 turn 边界（`'turn-boundary'`，在 observed 转换之前）、上文的 step 上限暂停（`'before-pause'`，在 `paused` 转换之前）、一次 `compaction/start` 事件（`'before-compaction'`，延后一个微任务，跳过会话自身的追加重入防护边界）、一次验证失败（`'verification-failure'`，在修复消息发出之前），以及一次声明了 `subagent.spawn` 或 `workflow.start` 的已授权调用（`'before-suspension'`，在调用运行之前——被派生的子 agent 或 workflow 可能运行足够久，从而使父级步骤挂起）。无论 `mode` 是否处于强制模式，每个自动检查点都会运行，这与 `action/decided` 始终被记录的方式一致。

### 设计哲学

Kernel 建立在四项承诺之上：

- **观察既有接缝；不拥有执行。** 每个集成点都是循环已经发布的 waterfall 或事件：`agent/created`、`agent/pre-step`、`agent/turn-stopping`、`tools/pre-execute` 与 `tools/post-execute`。没有新循环，没有第二个 agent 身份，没有并行派发器。
- **会话日志是唯一事实来源。** 每个决策在被据以行动之前先被追加，每次读取都是对这些事件的折叠。任务契约、决策与回执都能仅凭日志重建。
- **先 shadow，后 enforce。** 默认模式记录 Kernel 将会做出的决策并让执行照常进行，因此部署能在真实流量上度量权限文档，然后才可能拦住其中任何一次。
- **拒绝不是失败。** 策略拒绝、沙箱拒绝与审批驳回是与"工具运行后报错"不同的失败词汇，被拒绝的动作绝不会被伪装成工具失败。

### 每个决策在哪里做出

| 关注点 | 接缝 | Kernel 的动作 |
|---|---|---|
| 开启或推进任务 | `agent/pre-step` | 在首个被接纳的步骤创建契约，随后把它迁移到 `executing` |
| 组合该步骤的控制决策 | `agent/pre-step` | 接纳该步骤后追加一条 `governor/decided`；在 `enforce` 模式下对 `stop_*` 决策拒绝该步骤 |
| 监视运行是否停顿 | 以 `livenessWindowMs` 四分之一为周期的定时器 | 每个安静片段记录一条 `stalled` 失败，按当时在飞的东西分类 |
| 签发委派 | `agent/created` | 把子级的回执写入其自己的日志，并把审计副本写入父级日志，都在双方拥有任务之前 |
| 决定动作 | `tools/pre-execute` | 求值文档、组合沙箱与委派回执，并追加一条 `action/decided`，其中携带提议、规则决策、授权及其授予 |
| 强制执行动作 | `tools/pre-execute` 返回值 | `deny` 拦下调用，`ask` 路由到已组合的应答链；shadow 模式总是委托 |
| 观察动作 | `tools/post-execute` | 追加带治理回执的 `action/committed` |
| 结束轮次 | `agent/turn-stopping` | 记录观察边，然后对必需标准运行完成门禁 |
| 记录编码流水线 | `agent/pre-step`、一次计划修订、`tools/post-execute`、`agent/turn-stopping` | 被接纳的步骤记录 UNDERSTAND 与 MAP，计划修订记录 PLAN，结算的 `fs.write`/`fs.edit` 记录 CONTRACT 与 IMPLEMENT，随后随该轮次检查的结算记录 LOCAL VERIFY、REVIEW、REGRESSION 与 COMPLETE |
| 修复失败的检查 | `agent/turn-stopping` | 在发出修复消息的同一次行动中记录回到 IMPLEMENT 的返回 |
| 读取状态 | 任意调用方 | 通过按会话游标折叠会话日志 |

### 状态机

`state-machine.ts` 拥有合法边表与状态列表本身，而 `TaskClass` 决定每一类任务从什么起步：`conversational`（默认）不需要验收标准、在轮次结束时完成；`coding`、`research` 与 `operations` 采用部署为该类配置的标准，并且只有在 `requireAcceptanceCriteriaByClass` 要求时才被标准约束。类别来源依次为：调用方自己的声明、任务所用角色、变异启发式——承接了一个提出过文件变更工具的任务即视为编码工作。被类别豁免标准的任务不产生验证事件对，因为无物可验。每个状态都有产生者：任务创建时为 `intake`，进入 plan mode 期间为 `planning`，首个步骤被接纳时为 `ready`，每个步骤前后为 `executing` 与 `observing`，轮次结束时为 `verifying`，恢复开始时为 `recovering`，`awaiting-approval` 来自审批联动，`paused` 来自预算或存活停止，终态三者来自完成门或取消。未进入 plan mode 时，Kernel 自身的驱动器直接走 `intake → ready`，并以 `step-admitted` 作为触发器。`awaiting-approval`、`awaiting-user`、`paused` 与 `cancelled` 可从每个非终态到达，终态没有出边。`applyTransition()` 强制 Kernel 承诺的 compare-and-set：一次迁移必须属于该任务、从它当前的状态出发、并引用它当前的 revision，否则在任何追加之前抛出。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、服务，以及 waterfall 与事件监听器 |
| [`src/types.ts`](src/types.ts) | 全部 Kernel 契约，以及持久事件族的 `SessionEventMap` 合并 |
| [`src/state-machine.ts`](src/state-machine.ts) | 合法任务边、边断言与 compare-and-set 投影 |
| [`src/governor.ts`](src/governor.ts) | 进度监视器、循环检测器、活性监视器，以及它们组合出的每步决策 |
| [`src/policy.ts`](src/policy.ts) | glob 编译、规则求值、可接纳权能计算，以及沙箱与委派组合 |
| [`src/delegation.ts`](src/delegation.ts) | 委派回执、可写范围收窄与交集拒绝 |
| [`src/capabilities.ts`](src/capabilities.ts) | 工具能力注册表 |
| [`src/verification.ts`](src/verification.ts) | 完成门禁与本地标准验证器注册表 |
| [`src/recovery.ts`](src/recovery.ts) | 失败类型到恢复动作的映射表及其重试上限 |
| [`src/recovery-scan.ts`](src/recovery-scan.ts) | 对已存会话执行只读扫描，并分类为可继续/可修复/受阻 |
| [`src/coding-lifecycle.ts`](src/coding-lifecycle.ts) | §10.5 的阶段机、其经校验的配置与步骤上限、阶段日志，以及独立评审端口 |
| [`src/ledger.ts`](src/ledger.ts) | 基于游标的折叠、预算观测，以及会话对自身额度所下的预订持有量 |
| — | 不发布运行时 invariant 伴生件；Kernel 的折叠从独立伴生件会读取的同一批事件重新推导视图，因此两者不可能分叉。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从 Kernel 自身的契约走向它所观察的接缝以及它不得替换的循环。

- [Tools 子系统参考](../../../docs/subsystems/tools.zh.md) — `tools/pre-execute` 与 `tools/post-execute` waterfall，以及 Kernel 返回的 `PreToolDecision` 取值。
- [Sandbox 子系统参考](../../../docs/subsystems/sandbox.zh.md) — Kernel 用其与自身决策求交的技术边界。
- [Approval 子系统参考](../../../docs/subsystems/approval.zh.md) — 解析 `ask` 的已组合应答链，及其按失败关闭的结果。
- [Session 子系统参考](../../../docs/subsystems/session.zh.md) — Kernel 在其上声明持久事件族的 `SessionEventMap`。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-kernel) — 每个被接受的字段及其源码声明。
- [runtime 分组地图](../README.zh.md) — 同组的 runtime 包。

-----

<a id="model-experience"></a>
## 模型体验

### 被拒绝或被延后的工具调用

#### 模型看到什么

不添加任何提示词段落，也不添加任何工具 schema。只有恰好一个有条件的模型可见效果：在 `enforce` 模式下，被拒绝的调用返回一条工具错误，其文本以 `agent-kernel denied "<tool>": ` 开头，后接该决策的理由；而当没有任何应答者授予时，`ask` 返回注册表自身的、由审批驱动的拒绝。因超过任务的 `maxConcurrentActions` 上限而被拒绝的调用读起来相同，理由中写明已在飞的动作数。`stop_*` 的 Governor 决策在该步骤的请求构造之前就拒绝它，因此模型不会为它收到任何内容：该轮次以 blocked 结束，下一条待处理消息等待之后的唤醒。在 `shadow` 模式下模型看不到 Kernel 决定的任何内容，因为动作原样运行。

#### Token 影响

shadow 模式下增加零 token。在 `enforce` 模式下，被拒绝的调用把该工具的结果替换为一行简短理由，比该工具本会产出的结果更小。

#### KV Cache 影响

相互独立：Kernel 不注册提示词段落也不注册 schema，因此它从不改变请求前缀，也不可能让可复用的条目失效。被拒绝的调用只改变工具结果之后的后续对话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了 Kernel 何时是糟糕的选择。它们是本包当前的约束，而不是任务清单。

- **内置工具由另一个可选插件声明** — 在 Kernel 旁边挂载 `@deepseek-ai/dsh-agent-kernel-builtins`，让 `mode: 'enforce'` 治理真实流量。声明放在工具包之外，因为只有策略平面可以扩展权能词汇。重命名了工具、铸造了 `mcp__*` 或 `structured_output` 名字、或自带了工具的部署自行声明那些；未被声明的工具保持拒绝。
- **enforce 模式按设计拒绝一切未声明者** — 不带 builtins 插件就打开 `enforce` 的部署会停下每一次工具调用。请先以 `shadow` 挂载并阅读 `action/denied` 记录。
- **没有随包发布的标准验证器** — `verifiers.register()` 是接缝；声明了必需标准却没有注册验证器的任务会记录一次 `unknown` 验证并永不完成。命令、构建与 diff 不由本包运行。
- **Token 与成本上限只被报告，不被测量** — `budget.maxTokens` 与 `budget.maxCostUsd` 在每份预算观测中都显示为无上限，因为该测量由 token meter 拥有；`guard/budgets` 仍是它们的强制执行监听器。
- **重试次数统计的是提议，而非执行** — `maxAttemptsPerAction` 与同一 action id 下 `action/decided` 记录的数量比较，因此一次不再重新提议的 provider 层重试不会推进计数。
- **启动恢复只分类，不会继续执行。** `sessionPersistence` 可用后，Kernel 通过后端打开列出的每个会话，由后端解析其当前 generation。无任务或已终态的会话会被排除；未闭合轮次或等待必需检查点的恢复决策会被判为可修复；逐会话打开/读取失败会被判为受阻。会话列表读取失败则扫描 Promise 会拒绝。`dsh task recover-scan` 输出同一结果。
- **`planning` 有两个产生者** — plan mode（`recordPlanMode`，由 plan-mode 插件在记录模式后调用）与首次记录的计划修订。两者皆无的任务走 `intake → ready → executing → observing`。
- **变异启发式读的是工具声明，而非路径** — 承接了一个提出过 `fs.write`/`fs.edit` 工具的任务会被归为 `coding`；Kernel 不检查该工具实际触碰了哪些路径。
- **预算报告实测 token 花费；成本仍无报告** — `maxTokens` 的剩余量等于上限减去本会话的计费 token 数，来源于 token meter 自有的逐轮 provider 总计（`deriveSessionTokenSpend`）。provider 未报告 usage 的上限会被视为未花费；而 `maxCostUsd` 需要本包并不拥有的价格来源，因此保持缺省，继续由 `guard/budgets` 执行。`maxConcurrentActions` 按配置值上报而不做递减：在飞的槽位会随其动作结算而释放；该上限被组合进动作自身的决策，因此在 `enforce` 模式下拒绝调用，在 `shadow` 模式下则记录为影子拒绝。
- **验证成本控制只是部分实现** — 注册表按验证器族排序（assertion、diff、human、research、typecheck、lint、build、test、security、browser、review），在首个失败的必需标准处停止，让超出 `verifierTimeoutMs` 的验证器判为失败，并按 `verificationCacheSize`/`verificationCacheTtlMs` 以标准 id 与仓库摘要为键保留每条 `CriterionResult`；同一任务的轮次自上次通过以来未改变任何范围时，门控会跳过重新验证。摘要取该轮结束状态的 git tree id，recorder 未拍快照时取记录到的变更清单；若部署的 workspace-changes recorder 未为该轮发布摘要，每次验证获得各自独立的摘要——因为本包无法命名验证器读到的仓库状态，也就不会用某个状态的结果去回答另一个状态。
- **类别标准由部署最终拥有** — Kernel 记录 `Config.acceptanceByClass` 为该类提供的标准，其次是部署的 `acceptance` 列表，再次是该类的内置默认值。从工作区清单推导 typecheck、lint 与 test 命令尚未实现；部署需通过其验证器包声明回答内置标准 id（`typecheck`、`lint`、`test`、`diff`）的命令，而没有验证器认领的 id 会让任务无法完成。
- **编码生命周期的阶段是位置，不是产生者** — MAP、PLAN、CONTRACT、IMPLEMENT 与 REGRESSION 记录编码任务所处的位置；仓库地图、计划修订、变更契约与门禁所验的标准都由拥有它们的包记录，本流水线不重述其中任何一项。
- **独立评审由部署提供** — 只有设置了 `Config.codingLifecycle.review.enabled` 且某个已挂载的包注册了 `IndependentReviewer` 时，REVIEW 阶段才会运行；开启评审却没有注册者时，任务记录这一错误配置并转入 `awaiting-user`，而不是在没有评审的情况下完成。
- **委派回执的严格程度不超过签发它的文档** — 回执求交权能、可写范围、预算与深度，但逐资源的精确性仍来自子级用同一份文档做的规则求值。签发之后部署文档发生变更的子级跑在新规则之下，而回执仍记着旧摘要；`inheritedPolicyDigest` 就是读者分辨的依据。
- **解析不到父级的子级回退到部署上限** — 父级会话不可解析时，回执不记父级 run 或任务，子契约从部署预算起步。已携带回执的继续子级沿用日志里那份，不再领取第二份。
- **预订是活状态，其结算同样是** — 持有量限定一个会话在子级运行期间还能承诺多少；重启后没有在飞的子级可供持有，因此持有量以及它们结算成的扣减量都不会保留；父级交下去了什么的持久记录是它的 `delegation/issued` 回执，而每个子级的花费在该子级自己的会话里计量。重启之后两者不做对账。
- **活性监视器只记录，不会中止已经在飞的请求** — 停顿会被上报，且在 `enforce` 模式下该运行会拒绝它的下一个步骤，但 Kernel 不持有循环已在等待的那个请求的取消能力，因此挂起的调用仍会先经由该工具自身的期限或 provider 超时结束，拒绝才生效。
- **循环与停顿失败由下一个产生移动的步骤解除** — 再也不产生移动的运行会让它们保持未解决，完成门禁在此期间拒绝完成，如同对待任何其他未解决失败。
- **Governor 的状态是进程本地的** — 近期调用历史、活性时间戳与步骤计数在重启后都从头开始，因此继续运行的进程要先跑完自己的窗口才会报告停顿或循环。两者的持久记录是那条失败，以及回答它的 `governor/decided` 记录。
- **并行子级按先到先得共享同一池额度** — 子级继承父级的可用额度，因此在同级兄弟已持有全部额度时创建的子级只能从剩余量起步；当父级所限定的每个轴都被持有时，这个剩余量可以是零。在有额度上限的父级上并行运行子级的部署，应在创建每个子级前为它预订一份额度；未设置 `budgets` 的父级不限定任何轴，因此不持有任何量，也不会让子级断粮。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

本开发笔记是面向维护者的工作背景：尚未决定的问题与方向。它明确不具权威性——已发布的行为、限制与被接受的理据位于上述各节、包代码以及被链接的 Agent Note 中。

Kernel 是 [evolutionary agent runtime 规范](../../../specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md) 的 P0 切片。与该规范字面文本的两处偏离是有意的。第一，Kernel 在首个被接纳的步骤创建任务契约，而不是在 `agent/session-start`，因为只有在某个步骤认领人类消息之后目标才可知，也因为 session-start 处的追加会落在打开的轮次之外。第二，`ContextCompiler`、evidence/claim/hypothesis 图、模型路由器、workflow 检查点与 evolution 晋级门禁属于后续阶段，在这里完全没有体现。

</details>

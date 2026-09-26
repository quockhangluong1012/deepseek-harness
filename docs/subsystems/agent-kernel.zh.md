# Agent Kernel

[English](agent-kernel.md) | 中文

由 [`@deepseek-ai/dsh-agent-kernel`](../../packages/runtime/agent-kernel/README.zh.md) 拥有的控制平面。Kernel 观察 `core/agent-loop` 与 `core/tools` 已经发布的 agent 与工具接缝，从会话日志推导出每个会话一份持久任务契约，为每次工具调用记录一条提议与一条组合后的决策，并依据任务自身的验收标准决定完成。它不拥有任何执行：循环保留轮次与步骤的所有权，工具注册表保留派发，[`sandbox-policy`](sandbox.zh.md) 保留文件边界，[`user-approval`](approval.zh.md) 保留人类决策。声明位于 [`packages/runtime/agent-kernel/src/types.ts`](../../packages/runtime/agent-kernel/src/types.ts)；包 README 定义配置与会话收到的记录。

## 任务契约

任务是一组 `task/*` 事件的投影，绝不是内存中的单例。`TaskId` 与 `RunId` 是[带品牌 id](core.zh.md#branded-ids)；`ActionId` 是工具调用自身的 `ToolCallId` 在第二个品牌下的形态，因此一条提议、它的决策与它的回执无需第二个标识符即可关联。

`TaskContract` 携带目标、其约束、其验收标准、调用方声明的变更契约、文件策略被限定到的工作区、agent 与策略 profile、资源预算、当前 `TaskStatus`，以及每次被接受的迁移都会递增的正 `revision`。`TaskStatus` 是封闭联合 `intake | planning | ready | executing | observing | verifying | recovering | awaiting-approval | awaiting-user | paused | completed | failed | cancelled`，且每个成员都有产生者：任务被打开时为 `intake`，进入 plan mode 期间为 `planning`，首个步骤被接纳后为 `ready`，每个步骤前后为 `executing`／`observing`，轮次结束时为 `verifying`，恢复开始时为 `recovering`，直到完成门或取消给出终态。未进入 plan mode 时，Kernel 自身驱动 `intake → ready → executing → observing`。

一个会话同一时间只持有一个任务。当前任务处于终态时被领取的人类消息会开启下一份契约，并在 `parentTaskId` 中指明它所承接的任务；当前任务仍活跃时，该消息继续同一任务。`TaskClass` 决定任务从什么起步：`conversational`（默认）不需要验收标准，并在轮次结束时完成、不产生验证事件对；`coding`、`research` 与 `operations` 采用 `acceptanceByClass` 配置的标准，且只在 `requireAcceptanceCriteriaByClass` 要求时被标准约束。类别来源依次为：调用方自己的 `taskClass`、任务所用角色、变异启发式——承接了一个提出过 `fs.write`/`fs.edit` 工具的任务属于编码工作。

## Agent profile

`AgentProfile` 是 Kernel 对某个角色可强制执行的切片：一个 id、它所代表的角色、该角色永远可以使用的 capability 授予、其任务解析用的 policy profile，以及任务起始时的各项上限。任务会记录自己运行的 profile 名称，而 Kernel 通过 `ctx.agentKernel.profiles` 解析该名称——该注册表由部署从 `Config.profiles` 或之后更晚的配置层经 `register()` 填充。

角色只能收窄，永不放宽：当声明所需的 capability 落在 profile 授予之外时，`composeAuthorization()` 会以理由 `the agent profile withholds capability "<capability>"` 拒绝，因此即便某条权限规则对部署允许该 capability，也不等于对该未声明它的角色授权。子级继承的是回执与自身角色的交集，而绝非并集。角色的模型与上下文策略归属于拥有模型与上下文的包——模型路由器与[上下文编译器](agent-context.zh.md)——因此 profile 只陈述 Kernel 自己会强制执行的内容，而不为它并不做出的决策保留第二份副本。

`StateTransition` 是一次被接受的迁移的持久记录：迁移标识、任务、`from` 与 `to` 状态、`TransitionTrigger`、被求值的 `preconditions`、被提交的 `effects`、它所依据的任务 revision、它产生的 revision、可选的授权 `policyDecisionId`、`actor` 与时间戳。[`src/state-machine.ts`](../../packages/runtime/agent-kernel/src/state-machine.ts) 中的 `applyTransition()` 会拒绝属于另一任务、从过期状态出发、或引用过期 revision 的迁移。

## 动作账本

每次工具调用产生一条提议、一条规则决策、一条组合后的授权、一个可选的能力授予，以及一条回执。

`ActionProposal` 指名动作、agent、工具调用、已注册工具、已冻结的解析后参数、提议来源（`model`、`workflow`、`subagent` 或 `user`）、任务 revision 与一个 `TrustLabel`。`PolicyContext` 补充该工具已声明的 `CapabilityRequest` 列表、该工具是否什么都没声明、行动 agent 为子级时的委派回执，以及已解析的技术边界。

`PolicyDecision` 是权限文档所决定的：`effect`、胜出规则的索引或默认情况下的 `null`、胜出规则所匹配的能力请求，以及按求值顺序排列的理由。`AuthorizationDecision` 是组合后的运行时答案：求交后的 `effect`、它所组合的决策、被授予的 `Capability` 列表、动作据以执行的 `SandboxExecutionPolicy`、Kernel 是否据该决策行动（`enforced`）、agent 为子级时动作所依据的委派，以及组合后的理由。`ActionReceipt` 以 `succeeded`、`failed` 或 `denied` 结束动作，并带一个可选的 `GovernanceReceipt`，把策略决策、沙箱模式与工作区根目录、被记录时的人类结果，以及由谁解决（`user`、`policy` 或 `none`）连接起来。

## 权限文档

`PolicyDocument` 是一个默认 `effect` 加一个有序的 `PolicyRule` 列表；每条规则选择一种 `PolicyAction` 族与一个资源 glob，并决定 `allow`、`ask` 或 `deny`。[`src/policy.ts`](../../packages/runtime/agent-kernel/src/policy.ts) 中的 `POLICY_ACTIONS` 与 `POLICY_EFFECTS` 是被接受的词汇表，`compilePolicy()` 会在任何动作被求值之前拒绝未知的 action、未知的 effect 或空资源。`Capability` 是授予词汇——`fs.read`、`fs.write`、`fs.edit`、`process.exec`、`terminal.interactive`、`network.read`、`network.write`、`mcp.call`、`memory.read`、`memory.write`、`subagent.spawn`、`workflow.start`、`approval.request` 与 `policy.propose`——而 `CapabilityDeclaration` 把一个已注册工具映射到每次调用所需的能力，外加一个从其参数到这些能力所适用资源的纯投影。声明还可以携带该工具所处理内容的信任度：当某个包的工具越出信任边界时，它声明 `trust: 'untrusted'`，而启用不可信内容隔离的部署随后要求这类调用先获得人工回答，因此仅凭权限规则永远无法授权外部内容。`PolicyProfileProvider` 是该文档之上的可选会话级策略层：`ctx.agentKernel.registerPolicyProfileProvider()` 为每个会话解析一个 profile 名称与可选的 `PolicyDocument`，Kernel 再将其与部署文档求交，因此会话可以收窄自身权限，但绝不可能放宽。

## 委派

`DelegationReceipt` 是一次父级运行交给一次子级运行的权限：回执标识、子级运行、可解析时父级运行与任务、持久的父级会话、被允许的能力、继承的资源上限、可写范围、计算该授予所依据的权限文档摘要、深度、允许的最深深度，以及时间戳。Kernel 在 `agent/created` 时把它写入子级自己的日志——在双方拥有任务之前——并在父级日志上留一份 `delegation/issued` 审计副本；已携带回执的继续子级沿用日志里那份，不再领取第二份。

子级权限是回执与子级 profile、部署规则、子级自有沙箱的交集：[`src/delegation.ts`](../../packages/runtime/agent-kernel/src/delegation.ts) 拒绝回执扣留的能力、超出其可写范围（已与子级边界收窄）的写入，以及超过父级深度上限后的每个动作。子级任务契约沿用回执的运行标识，指名父级任务，并从父级的剩余预算起步。

`DelegationPolicy` 是一次部署在启动边界上接纳的内容：`maxDepth`、`maxChildren`、`maxConcurrent`、`maxCost`、`maxTokens`、`allowedRoles`、`duplicateTaskDetection` 与 `resultSchemaRequired`；`resolveDelegationPolicy()` 依据消费方自己的子级深度设置，从部分声明中解析出它。`delegationPolicyRefusal()` 用一句话回答一次启动，`delegatedWorkerBudget()` 提供交给子 agent 的 token 与成本上限，`taskOverlapDecision()` 把一个委派目标与该父 agent 运行中及已完成的子 agent 比较，返回 `reuse`、`merge`、`narrow`、`avoid` 或 `spawn`——这是确定性的 token 集合比较，不调用模型（[`src/delegation-policy.ts`](../../packages/runtime/agent-kernel/src/delegation-policy.ts)、[`src/task-overlap.ts`](../../packages/runtime/agent-kernel/src/task-overlap.ts)）。`dsh-tool-subagent` 是当前执行它们的启动边界。

## 内置声明

Kernel 注册表初始为空并按失败关闭。[`@deepseek-ai/dsh-agent-kernel-builtins`](../../packages/runtime/agent-kernel-builtins/README.zh.md) 是声明每个已发布产品工具的可选插件——一次调用所需的能力，以及从其参数到这些能力所适用资源的全函数、永不为空的投影——一旦被注入的 `agentKernel` 服务存在便注册，与挂载顺序无关。一份 spec 从生成的[工具目录](../tool-catalog.zh.md)重新推导工具清单，已发布名字没有声明就失败，因此新工具不可能在未声明的情况下到来。

## 验证、失败与恢复

`VerificationRequest` 携带任务、标准所读取的确切 revision、那些标准，以及变更范围。`VerificationResult` 把逐标准的 `CriterionResult` 记录聚合为 `pass`、`fail` 或 `unknown`，并带验证器运行过的命令与验证器版本。`CompletionDecision` 是门禁的答案：只有在每个必需标准都通过、没有未解决的失败残留、且没有已配置上限被耗尽时，才允许完成。

`FailureKind` 是共享的分类——`model-auth`、`model-rate-limit`、`model-context-overflow`、`tool-invalid-input`、`tool-policy-denied`、`tool-transient`、`sandbox-denied`、`approval-rejected`、`timeout`、`budget-exhausted`、`stale-write`、`verification-failed`、`subagent-failed`、`workflow-failed`、`persistence-failed`、`prompt-injection`、`output-truncated`、`tool-args-malformed`、`no-progress`、`stalled`、`step-ceiling`、`plan-drift`、`verification-regressed` 与 `unknown`。后五者是修正案 S4 的循环健壮性分类：每一种都描述「运行没有直接失败却不再推进」的形态；Kernel 自己的检测器会在任务达到所配置的步骤上限时记录 `step-ceiling`——连同其恢复动作 `checkpoint-pause`——把任务置为暂停，而不是再接纳一个步骤。`FailureRecord` 指名一次发生，`RecoveryDecision` 记录为它选定的 `RecoveryAction`、该动作是否可重试、剩余尝试次数、重试前是否必须先做检查点，以及原因。

## Governor、进度与活性

`GovernorDecision` 是 Kernel 每个步骤组合出的那一个控制决策：`continue`、`retry`、`replan`、`compact`、`delegate`、`ask_user`，以及五个停止 `stop_success`、`stop_failure`、`stop_budget`、`stop_loop` 与 `stop_timeout`。`StepDelta` 度量刚结束那一步所产生的移动，按它产出的事件种类各占一轴：`toolNovelty`（其工具调用中近期历史未见过的比例）、`stateDelta`（任务 revision 前进）、`evidenceGain`（记录了观测或论断）、`goalProgress`（会话目标变化）、`errorReduction`（未解决失败减少）与 `planProgress`（记录了计划修订）。每轴都归一化到 `[0, 1]`，`progressScore` 是它们的均值，因此 0 表示 Harness 观察到该步骤什么也没移动。

每个步骤边界都会追加 `governor/decided`，其中是一条 `GovernorDecisionRecord`：决策、按其求值顺序排列的理由、该步骤的 delta、分数、turn 与 step、该决策回答停顿时对应的 `TimeoutKind`，以及时间戳。决策依次由预算状态、进度、重复、振荡、最新未解决失败已决定的恢复动作、上下文压力、任务状态、子 agent 深度与活性组合而成，优先级如上所列。分数大于 0 的步骤会解除之前各步骤所记录的 `no-progress` 与 `stalled` 失败。在 `mode: 'enforce'` 下，Kernel 会对 `stop_*` 决策在 `agent/pre-step` 返回拒绝，循环将其上报为 blocked 轮次。

`TimeoutKind` 指明活性窗口耗尽时安静下来的是哪一层：`tool`（从未结算的调用）、`transport`（没有产出任何帧的请求）、`stream`（停止产出帧的请求）、`agent`（没有任何在飞工作的运行）或 `child-agent`（被委派的子级）。监视器跟踪最后一次模型帧、最后一次工具管线事件与最后一个产生移动的步骤；等待人类回答或被停止挂起的任务绝不会被上报为停顿。

## 编码生命周期

`CodingPhase` 是类别为 `coding` 的任务所跑的 §10.5 流水线：`understand`、`map`、`plan`、`contract`、`implement`、`local-verify`、`review`、`regression`、`complete`。`canAdvancePhase()` 与 `assertPhaseTransition()` 暴露该状态机的直接边——前向链条，加上每个检查阶段失败时回到 `implement` 的修复返回边——这张表之外的迁移会抛错。`CodingLifecycleConfig`（`phases`、`budgets`、`review`）在加载时由 `resolveCodingLifecycle()` 校验一次，服务运行时依据的是 `ResolvedCodingLifecycle`：阶段列表以 `understand` 开头、以 `complete` 结尾、不重复任何阶段；`budgets` 的每一项都指向本部署会运行的阶段并给出其正整数步骤上限；在 `phases` 未包含 `review` 时不能启用评审，而评审开关关闭时 REVIEW 在流水线中被跳过。

`CodingPhaseRecord` 是一次进入：阶段、它来自的阶段、任务类别、该阶段在流水线中的序号、触发原因（`lifecycle-started`、`phase-advanced`、`phase-repaired`）、调用方给出的 `detail`、任务 revision 与时间戳。`CodeReviewRecord` 是某个 REVIEW 条目结算后的报告：所检查的 diff 引用、`CodeReviewReport`（`summary` 加上由 file、可选 line、`ReviewSeverity` 与 message 组成的 `CodeReviewFinding[]`）、任务 revision 与时间戳。`ctx.agentKernel.lifecycle` 就是 `CodingLifecycle` 服务：`phasesFor(taskClass)`、`current(session)`、`advance(session, target, detail?)`、`repair(session, detail)`、`review(agent, signal)`、`completionPredicate(session)`，以及 `registerReviewer(reviewer)`——后者接收部署的 `IndependentReviewer`（其 `review(request: CodeReviewRequest)` 回答一份 `CodeReviewReport`）并拒绝第二次注册。`PhaseAdvance` 报告已追加的条目与阻止推进的 `CodingPhaseBudget`；该失败由调用方记录，Kernel 随后把任务停到 `awaiting-user`。

## 研究记录

`Evidence` 是一条可供 claim 引用的观测：由哪个来源族观测（`file`、`tool-result`、`web`、`mcp`、`test`、`user`、`model`）、内容所在位置的引用、可选的已见内容摘要、为该观测记录下来的来源与定位、其 `TrustLabel`，以及观测时间。内容本身留在各自的存储中；该记录只是引用，因此即便被 claim 引用，不可信观测依然只是数据。

`TaskClaim` 是任务断言的一条陈述、其背后的 `EvidenceId`、`[0, 1]` 内的置信度，以及一个状态（`proposed`、`supported`、`contradicted`、`stale`、`rejected`）——这是活动任务的研究记录，与 `evolution-graph` 存储、面向晋升的跨会话 claim 是两回事。`TaskHypothesis` 是一个问题、与其相关的 `TaskClaimId` 与 `VerificationRequest`，以及一个状态（`open`、`supported`、`refuted`、`inconclusive`）。`recordEvidence()`、`recordClaim()` 与 `recordHypothesis()` 把记录追加为 `evidence/recorded`、`claim/updated` 或 `hypothesis/updated`，并在以下情况抛错：陈述或问题为空、置信度超出 `[0, 1]`、引用了本会话从未记录的条目、`supported` claim 未引用任何观测，或测试指名了另一个任务。

## 检查点与读模型

`Checkpoint` 在一个会话序列处为一个任务建索引：任务与运行标识、会话、`sessionSeq`、状态与 revision、`BudgetSnapshot`、未完成动作 id、未解决失败、`CheckpointReason` 与时间戳。`KernelView` 是读取者从 `ctx.agentKernel.state.view(session)` 得到的内容：当前契约、预算观测、未完成动作、未解决失败、存在时的最新计划与检查点，以及 agent 为子级时的委派回执。

`BudgetSnapshot` 计量一个任务的花费并报告每个已配置上限还剩多少；`ctx.agentKernel.budgets` 还回答一个会话仍能承诺什么。`available(session)` 是实测剩余额度减去该会话在飞子级所占的持有量与已结算子级所报的花费；`reserve(session, amount, runId?)` 为即将运行的工作持有其中一部分，并返回 `BudgetReservation`，其中写明会话、运行与所持有的各轴上额；`commit(reservationId, actual?)` 用工作实际花掉的部分结算一份持有量，`release(reservationId)` 则结束一份其工作从未运行的持有量。持有量以及它们结算成的扣减量属于进程状态：重启后没有在飞工作可供持有预算，因此父级交下去了什么改从它的 `delegation/issued` 回执读取。

## 对外界面

Kernel 记录就是持久的会话事件，因此任何已经承载会话日志的桥接都会承载它们：[SDK 协议包](../../packages/sdk/protocol/README.zh.md) 以 `session.event` 通知不过滤地推送，[ACP](../../packages/acp/acp/README.zh.md) 把持久计划修订投影为自身的 `plan` 更新，并通过 `session/request_permission` 传递权限请求。验证结果、检查点与动作决策在 ACP 中没有对应表示，因此 ACP 客户端从 SDK 流或会话日志本身读取它们。

## 指标

`readKernelMetrics(events)` 把一个会话的 Kernel 事件折叠成该平面自有的计数器：创建的任务及其终态、验证次数与通过率、步数与工具调用、提案/成功/失败/被拒的动作、策略拒绝与询问、被驳回的审批、按类别统计的失败、按动作统计的恢复决策、检查点与恢复次数、重试过的动作，以及从未结算的动作。分母为零的比率会缺省而非记为零，读者因此不会把「什么都没发生」误读成「全部失败」。重试的动作保留其 action id，因此回执对应已结算的那次尝试，而尝试本身体现为提案数与重试动作计数。其它包拥有的指标——上下文压缩、记忆召回效用、技能效用、演化增益——不在此处推导；由各自的拥有者写入。

## 持久事件族

Kernel 把这些声明合并进 `SessionEventMap`；它们全部只入日志，绝不进入模型上下文。

| 事件 | 载荷 |
|---|---|
| `task/created` | 创建时的完整 `TaskContract` |
| `task/transitioned` | 一次 `StateTransition` |
| `task/plan` | 一次 `PlanRevision` |
| `task/phase` | 一条 `CodingPhaseRecord` |
| `task/review` | 一条 `CodeReviewRecord`，即独立评审为某个 REVIEW 条目给出的结构化报告 |
| `action/decided` | 一条 `ActionProposal`、它所依据的 `PolicyDecision`，以及组合后的 `AuthorizationDecision`（含其所授予的能力） |
| `action/committed` | 一条 `ActionReceipt` 以及随其结算而结束的单次授权 |
| `verification/requested`、`verification/result` | 请求与聚合后的结果 |
| `failure/recorded`、`recovery/decided` | 失败与所选恢复 |
| `governor/decided` | 一条 `GovernorDecisionRecord`：决策、其理由、该步骤的 `StepDelta` 与归一化进度分数 |
| `checkpoint/created` | 一个 `Checkpoint` |
| `evidence/recorded` | 一条 `Evidence` |
| `claim/updated`、`hypothesis/updated` | 一条 `TaskClaim` 或一条 `TaskHypothesis` |
| `delegation/received` | 子级据以行动的 `DelegationReceipt`，在子级自己的日志里 |
| `delegation/issued` | 同一份回执，作为审计副本在父级日志上 |

生成的[持久化目录](../persistence-catalog.zh.md)记录每个声明位置，[Session 页面](session.zh.md)拥有它们所扩展的事件映射契约。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentkernel--agentkernelservice"></a>

### `ctx.agentKernel` — `AgentKernelService`

The kernel service (`ctx.agentKernel`). It attaches to the loop and tool waterfalls in its constructor. Plugin unload removes those registrations and awaits release of every open attachment.

```ts cordis-catalog
/**
 * Register the provider for session-selected policy layers.
 * @param provider - resolves the profile and optional restriction for each session.
 * @returns a disposer that removes this provider while it remains registered.
 * @throws when another policy profile provider is already registered.
 */
registerPolicyProfileProvider(provider: PolicyProfileProvider): () => void

/**
 * Persist one caller-supplied task contract before its first request.
 * @param agent - the live agent whose session owns the task.
 * @param input - the objective, constraints, acceptance, profiles, workspace and budget.
 * @returns the newly recorded contract at its initial `intake` revision.
 * @throws When the session already has a task contract.
 */
intake(agent: Agent, input: TaskInput): TaskContract

/**
 * Attach one live agent to its task contract.
 * @param agent - the live agent to attach.
 * @returns the attachment handle.
 * @throws When the agent's session holds no `task/created` event yet; the kernel creates one at the first admitted step.
 */
attach(agent: Agent): KernelAttachment

/**
 * Read one agent's task state.
 * @param agent - the live agent whose session is read.
 * @returns the current view, or undefined before task intake.
 */
snapshot(agent: Agent): Promise<KernelView | undefined>

/**
 * Read the current task view through the live agents registry.
 * The registry remains the sole owner of agent identity and disposal; this
 * method resolves it on every call and retains no agent reference.
 * @param sessionId - the identity of the session to read.
 * @returns the current view, or undefined when no live agent or task exists.
 */
viewOf(sessionId: SessionId): KernelView | undefined

/**
 * Record an initial plan or an amendment tied to one unresolved failure. A
 * revision a human approved is legal without a failure reference, because the
 * review is the justification the model's own rewrite lacks.
 * @param agent - the live agent whose task owns the plan.
 * @param steps - ordered work items in the new plan revision.
 * @param failureId - unresolved failure that justifies an amendment.
 * @param options - who approved the revision and which action recorded it.
 * @returns the durable plan revision.
 * @throws When the session has no task, a model-recorded amendment is not
 *   linked to an unresolved failure, or the task reached its revision cap.
 */
recordPlan(agent: Agent, steps: readonly string[], failureId?: FailureId, options: PlanOptions = {}): PlanRevision

/**
 * Record one observation a claim may cite.
 * @param agent - the live agent whose task observed it.
 * @param input - what was observed, where it lives, and how far it may be trusted.
 * @returns the durable evidence record.
 * @throws When the session has no task or the reference is empty.
 */
recordEvidence(agent: Agent, input: EvidenceInput): Evidence

/**
 * Assert one claim against evidence this session recorded.
 * @param agent - the live agent whose task asserts it.
 * @param input - the statement, the evidence it cites, its confidence, and its status.
 * @returns the durable claim.
 * @throws When the session has no task, the statement is empty, the confidence
 *   is outside `[0, 1]`, a cited observation was never recorded, or a
 *   `supported` claim cites no observation.
 */
recordClaim(agent: Agent, input: TaskClaimInput): TaskClaim

/**
 * Record one question a task is testing.
 * @param agent - the live agent whose task is testing it.
 * @param input - the question, the claims behind it, and the verifications run against it.
 * @returns the durable hypothesis.
 * @throws When the session has no task, the question is empty, a cited claim
 *   was never asserted, or a test does not verify this task.
 */
recordHypothesis(agent: Agent, input: TaskHypothesisInput): TaskHypothesis

/**
 * Verify one task revision with the registered criterion verifiers, record the
 * request and its result, and return the completion decision.
 * @param agent - the live agent whose task is verified.
 * @param changedScopes - scopes the task changed, for `diff` verifiers.
 * @returns the completion decision, or undefined when the agent has no task.
 */
verify(agent: Agent, changedScopes: readonly string[] = []): Promise<CompletionDecision | undefined>

/**
 * Record one checkpoint of an agent's current kernel state.
 * @param agent - the live agent whose task is checkpointed.
 * @param reason - why the checkpoint is recorded.
 * @returns the checkpoint, or undefined when the agent has no task.
 */
checkpoint(agent: Agent, reason: CheckpointReason): Checkpoint | undefined

/**
 * Follow plan mode, the producer of the `planning` status: entering it moves a
 * non-terminal task to `planning`, leaving it returns the task to `ready`. A
 * session with no task yet has nothing to move, and a status that cannot reach
 * `planning` keeps its current one. The plan-mode plugin calls this immediately
 * after it records the mode, so the status and the mode agree in the log.
 * @param session - the session whose mode changed.
 * @param active - whether plan mode is now in force.
 */
recordPlanMode(session: Session, active: boolean): void
```

Types: [Agent](core.zh.md) · [Session](session.zh.md) · [SessionId](core.zh.md)

Source: [`packages/runtime/agent-kernel/src/index.ts`](../../packages/runtime/agent-kernel/src/index.ts)
<!-- END GENERATED cordis-surface -->

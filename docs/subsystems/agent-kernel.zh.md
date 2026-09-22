# Agent Kernel

[English](agent-kernel.md) | 中文

由 [`@deepseek-ai/dsh-agent-kernel`](../../packages/runtime/agent-kernel/README.zh.md) 拥有的控制平面。Kernel 观察 `core/agent-loop` 与 `core/tools` 已经发布的 agent 与工具接缝，从会话日志推导出每个会话一份持久任务契约，为每次工具调用记录一条提议与一条组合后的决策，并依据任务自身的验收标准决定完成。它不拥有任何执行：循环保留轮次与步骤的所有权，工具注册表保留派发，[`sandbox-policy`](sandbox.zh.md) 保留文件边界，[`user-approval`](approval.zh.md) 保留人类决策。声明位于 [`packages/runtime/agent-kernel/src/types.ts`](../../packages/runtime/agent-kernel/src/types.ts)；包 README 定义配置与会话收到的记录。

## 任务契约

任务是一组 `task/*` 事件的投影，绝不是内存中的单例。`TaskId` 与 `RunId` 是[带品牌 id](core.zh.md#branded-ids)；`ActionId` 是工具调用自身的 `ToolCallId` 在第二个品牌下的形态，因此一条提议、它的决策与它的回执无需第二个标识符即可关联。

`TaskContract` 携带目标、其约束、其验收标准、文件策略被限定到的工作区、agent 与策略 profile、资源预算、当前 `TaskStatus`，以及每次被接受的迁移都会递增的正 `revision`。`TaskStatus` 是封闭联合 `intake | understanding | retrieving | planning | ready | executing | observing | verifying | recovering | awaiting-approval | awaiting-user | paused | completed | failed | cancelled`；`intake`、`understanding`、`retrieving` 与 `planning` 是为 Kernel 并未附带的规划器而存在，它自己驱动 `intake → ready → executing → observing`。

`StateTransition` 是一次被接受的迁移的持久记录：迁移标识、任务、`from` 与 `to` 状态、`TransitionTrigger`、被求值的 `preconditions`、被提交的 `effects`、它所依据的任务 revision、它产生的 revision、可选的授权 `policyDecisionId`、`actor` 与时间戳。[`src/state-machine.ts`](../../packages/runtime/agent-kernel/src/state-machine.ts) 中的 `applyTransition()` 会拒绝属于另一任务、从过期状态出发、或引用过期 revision 的迁移。

## 动作账本

每次工具调用产生一条提议、一条规则决策、一条组合后的授权、一个可选的能力授予，以及一条回执。

`ActionProposal` 指名动作、agent、工具调用、已注册工具、已冻结的解析后参数、提议来源（`model`、`workflow`、`subagent` 或 `user`）、任务 revision 与一个 `TrustLabel`。`PolicyContext` 补充该工具已声明的 `CapabilityRequest` 列表、该工具是否什么都没声明、行动 agent 为子级时的委派回执，以及已解析的技术边界。

`PolicyDecision` 是权限文档所决定的：`effect`、胜出规则的索引或默认情况下的 `null`、胜出规则所匹配的能力请求，以及按求值顺序排列的理由。`AuthorizationDecision` 是组合后的运行时答案：求交后的 `effect`、它所组合的决策、被授予的 `Capability` 列表、动作据以执行的 `SandboxExecutionPolicy`、Kernel 是否据该决策行动（`enforced`）、agent 为子级时动作所依据的委派，以及组合后的理由。`ActionReceipt` 以 `succeeded`、`failed` 或 `denied` 结束动作，并带一个可选的 `GovernanceReceipt`，把策略决策、沙箱模式与工作区根目录、被记录时的人类结果，以及由谁解决（`user`、`policy` 或 `none`）连接起来。

## 权限文档

`PolicyDocument` 是一个默认 `effect` 加一个有序的 `PolicyRule` 列表；每条规则选择一种 `PolicyAction` 族与一个资源 glob，并决定 `allow`、`ask` 或 `deny`。[`src/policy.ts`](../../packages/runtime/agent-kernel/src/policy.ts) 中的 `POLICY_ACTIONS` 与 `POLICY_EFFECTS` 是被接受的词汇表，`compilePolicy()` 会在任何动作被求值之前拒绝未知的 action、未知的 effect 或空资源。`Capability` 是授予词汇——`fs.read`、`fs.write`、`fs.edit`、`process.exec`、`terminal.interactive`、`network.read`、`network.write`、`mcp.call`、`memory.read`、`memory.write`、`subagent.spawn`、`workflow.start`、`approval.request` 与 `policy.propose`——而 `CapabilityDeclaration` 把一个已注册工具映射到每次调用所需的能力，外加一个从其参数到这些能力所适用资源的纯投影。

## 委派

`DelegationReceipt` 是一次父级运行交给一次子级运行的权限：回执标识、子级运行、可解析时父级运行与任务、持久的父级会话、被允许的能力、继承的资源上限、可写范围、计算该授予所依据的权限文档摘要、深度、允许的最深深度，以及时间戳。Kernel 在 `agent/created` 时把它写入子级自己的日志——在双方拥有任务之前——并在父级日志上留一份 `delegation/issued` 审计副本；已携带回执的继续子级沿用日志里那份，不再领取第二份。

子级权限是回执与子级 profile、部署规则、子级自有沙箱的交集：[`src/delegation.ts`](../../packages/runtime/agent-kernel/src/delegation.ts) 拒绝回执扣留的能力、超出其可写范围（已与子级边界收窄）的写入，以及超过父级深度上限后的每个动作。子级任务契约沿用回执的运行标识，指名父级任务，并从父级的剩余预算起步。

## 内置声明

Kernel 注册表初始为空并按失败关闭。[`@deepseek-ai/dsh-agent-kernel-builtins`](../../packages/runtime/agent-kernel-builtins/README.zh.md) 是声明每个已发布产品工具的可选插件——一次调用所需的能力，以及从其参数到这些能力所适用资源的全函数、永不为空的投影——一旦被注入的 `agentKernel` 服务存在便注册，与挂载顺序无关。一份 spec 从生成的[工具目录](../tool-catalog.zh.md)重新推导工具清单，已发布名字没有声明就失败，因此新工具不可能在未声明的情况下到来。

## 验证、失败与恢复

`VerificationRequest` 携带任务、标准所读取的确切 revision、那些标准，以及变更范围。`VerificationResult` 把逐标准的 `CriterionResult` 记录聚合为 `pass`、`fail` 或 `unknown`，并带验证器运行过的命令与验证器版本。`CompletionDecision` 是门禁的答案：只有在每个必需标准都通过、没有未解决的失败残留、且没有已配置上限被耗尽时，才允许完成。

`FailureKind` 是共享的分类——`model-auth`、`model-rate-limit`、`model-context-overflow`、`tool-invalid-input`、`tool-policy-denied`、`tool-transient`、`sandbox-denied`、`approval-rejected`、`timeout`、`budget-exhausted`、`stale-write`、`verification-failed`、`subagent-failed`、`workflow-failed`、`persistence-failed`、`prompt-injection` 与 `unknown`。`FailureRecord` 指名一次发生，`RecoveryDecision` 记录为它选定的 `RecoveryAction`、该动作是否可重试、剩余尝试次数、重试前是否必须先做检查点，以及原因。

## 检查点与读模型

`Checkpoint` 在一个会话序列处为一个任务建索引：任务与运行标识、会话、`sessionSeq`、状态与 revision、`BudgetSnapshot`、未完成动作 id、未解决失败、`CheckpointReason` 与时间戳。`KernelView` 是读取者从 `ctx.agentKernel.state.view(session)` 得到的内容：当前契约、预算观测、未完成动作、未解决失败、存在时的最新计划与检查点，以及 agent 为子级时的委派回执。

## 持久事件族

Kernel 把这些声明合并进 `SessionEventMap`；它们全部只入日志，绝不进入模型上下文。

| 事件 | 载荷 |
|---|---|
| `task/created` | 创建时的完整 `TaskContract` |
| `task/transitioned` | 一次 `StateTransition` |
| `task/plan` | 一次 `PlanRevision` |
| `action/proposed` | 一条 `ActionProposal` |
| `policy/decision` | 提议及其 `PolicyDecision` |
| `action/authorized`、`action/denied` | 提议及其组合后的 `AuthorizationDecision` |
| `capability/grant` | 动作与被授予的能力 |
| `action/committed` | 一条 `ActionReceipt` |
| `verification/requested`、`verification/result` | 请求与聚合后的结果 |
| `failure/recorded`、`recovery/decided` | 失败与所选恢复 |
| `checkpoint/created` | 一个 `Checkpoint` |
| `delegation/received` | 子级据以行动的 `DelegationReceipt`，在子级自己的日志里 |
| `delegation/issued` | 同一份回执，作为审计副本在父级日志上 |

生成的[持久化目录](../persistence-catalog.zh.md)记录每个声明位置，[Session 页面](session.zh.md)拥有它们所扩展的事件映射契约。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentkernel--agentkernelservice"></a>

### `ctx.agentKernel` — `AgentKernelService`

The kernel service (`ctx.agentKernel`). It attaches to the loop and tool waterfalls in its constructor, so unloading the plugin unloads every listener, declaration, and attachment with it.

```ts cordis-catalog
/**
 * Attach one live agent to its task contract.
 * @param agent - the live agent to attach.
 * @returns the attachment handle.
 * @throws When the agent's session holds no `task/created` event yet; the kernel creates one at the first admitted step.
 */
attach(agent: Agent): KernelAttachment

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
```

Types: [Agent](core.zh.md)

Source: [`packages/runtime/agent-kernel/src/index.ts`](../../packages/runtime/agent-kernel/src/index.ts)
<!-- END GENERATED cordis-surface -->

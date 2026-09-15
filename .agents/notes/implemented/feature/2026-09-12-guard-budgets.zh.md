# Agent Note: Per-Turn Budget Guard — Pre-Step Ceilings Through the Existing Blocked Reason

Status: implemented

[English](2026-09-12-guard-budgets.md) | 中文

## Problem

演化 harness 计划承诺了长周期安全：一旦轮次超出 token、工具调用、挂钟时间或成本预算，就将其切断。已有的上限都覆盖不到这一点。`maxSteps` 约束的是轮次的步骤数，`maxTokens` 约束的是单次请求的输出，两者都看不到轮次累积的请求压力、已完成的工具调用数或持续时长。也没有任何代码通过 `ctx.tokenMeter` 来停止轮次。规范同样把执行点留作开放：它列出的是 `agent/turn-stopping` 加一次早期 `agent/pre-step` 拒绝，并承诺了一条用于记录切断的持久化 `budget/exceeded` 事件。

## Decision

在 `guard/` 组交付 `@deepseek-ai/dsh-budgets`，作为一个插件挂在两个已有扩展点上。每项上限都是可选的，未设置即为关闭，因此无配置挂载的插件只观察轮次、不拒绝任何步骤。web-app 组合包正是这样挂载它；base、headless 与 SDK 组合包都不含该行。

`apply` 注册一个 `session/event` 监听器，把每个会话的轮次事实折叠进 `WeakMap<Session, TurnFacts>`：`turn/start` 写入 `{ turn, startedAt: event.time, toolCalls: 0 }`，`tool/call` 在条目存在时递增 `toolCalls`，其余事件类型一律忽略。因此事实只覆盖插件亲眼观察到的 `turn/start` 所属的轮次；插件加载时已经打开的轮次没有条目，永远不会被切断。这个 WeakMap 不需要清理监听器——条目随其会话对象一起消亡。

执行点是 `agent/pre-step`，不是 `agent/turn-stopping`。`agent/pre-step` 是 waterfall，循环本就把它的 `{ kind: 'reject' }` 转换为轮次结束原因 `blocked`，而且它在该步骤的模型请求之前运行，因此拒绝是取消该请求，而不是与之竞争。`agent/turn-stopping` 是没有否决位置的停止事件：在那里唯一可用的动作是 `agent.steer(...)`，而它会让轮次继续打开。因此本包不在其上注册任何内容。这就是对 `specs/improvement.spec.md` Phase 1 的偏差——该处同时列出了两个执行点。

各项上限按代价从低到高评估——`maxToolCalls` 对已计入的 `tool/call` 事件，`maxWallMs` 对 `Date.now() - startedAt`，`maxTotalTokens` 对 `ctx.tokenMeter.measure(agent.session).totalTokens`，`maxCostUsd` 对同一测量值按部署的 `usdPerMillionTokens` 以每百万 token 计价——因此已经越过较廉价上限的轮次不必为其日志重放付出代价。到达上限时会先追加一条持久化的 `budget/exceeded` 事件，携带上限名、实测值、限值以及它所停止的轮次与步骤，再记录恰好一条宿主警告，指明上限、agent、轮次、实测值与限值，然后在不调用 `next()` 的情况下返回 `{ kind: 'reject' }`，即 Cordis waterfall 的短路。不新增 `TurnEndReason`，也不发出 steer。该事件是 `src/types.ts` 中的普通 `SessionEventMap` 成员：按[会话日志版本机制](../../implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)，普通事件新增不会推动 `SESSION_FORMAT_VERSION` 变更，因此它与 `llm/fallback` 一样在已发布版本上交付，不附带迁移，也不改动 SDK 投影。它保持按读取必填——guard 不写入 `ignorable` 标记，因为 `Session.append()` 无法设置该信封字段——而 `blocked` 的轮次结束仍是重建出的结果。

人类输入高于一切上限。循环在 waterfall 运行之前就把该步骤认领的消息从 inbox 中移除，因此拒绝携带用户消息的步骤会将其丢弃。当认领的消息中有任何一条带有 `source.kind === 'user'` 时，guard 会在不评估任何上限的情况下委派。该规则是正确性条件而非优化：正是它让拒绝不具破坏性；它也意味着上限从轮次的第二步起才真正生效。

`maxCostUsd` 按部署的 `usdPerMillionTokens` 以每百万 token 为同一测量值计价。harness 自身没有计价来源，因此由部署说出其模型的成本：没有价格的成本上限在加载期失败，没有成本上限的价格则不起作用。`maxTotalTokens` 也是所比较内容的诚实命名，因为 `ctx.tokenMeter` 测量的是请求总压力而非仅输入 token——规范表格中的 `maxInputTokens` 命名的是计量器并不产出的量。

## Alternatives considered

- **在 `agent/turn-stopping` 上执行。** 否决：该边界是停止事件而非 waterfall，没有可返回的否决值。唯一可用的动作会让轮次继续打开，因此该监听器只会是无效负担，并暗示存在一种实际并不存在的强制执行。
- **把 `budget/exceeded` 的新增当作会话格式变更。** 否决：[版本机制](../../implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)只在头部、事件信封、核心事件语义或 surface 重建发生结构变化时才推动格式变更。普通的新成员在已发布版本上按读取必填，无需变更，因此本事件既不带来相邻迁移，也不带来 SDK 投影。
- **复用驱动的 `maxSteps` 与 `maxTokens` 上限。** 否决：它们约束的是不同的量（步骤数与单次请求输出），且位于 `agent-loop` 中，而规范禁止为预算行为改动该处。
- **从会话历史读取轮次事实。** 否决：`eventAt` 与 `snapshotEvents` 对新的生产调用已被弃用，而投递的 `session/event` 已经携带 guard 所需的全部事实。
- **当上限已经到达时拒绝轮次的第一个步骤。** 否决：该步骤认领的是用户消息，拒绝等于删除人类输入。上限因此从第二步起生效。
- **为各项上限提供 `DEFAULT_*` 常量或测试钩子。** 否决：每个约束都是可在 `cordis.yml` 中更改的、经校验的 `Config` 字段，未设置的字段保持关闭。

## Consequences

部署获得了真正的长周期约束，而且无需改动驱动、会话格式或 SDK：在组合中加入一行并写出所需上限，失控轮次就会在下一个步骤边界以 `blocked` 结束，日志本身也会指明是哪项上限切断的、观察到了什么。代价是读取方兼容性：新成员按读取必填，因此比该事件更早的 harness 会拒绝包含它的日志，而不是悄悄丢弃这次切断。guard 的 token 上限也只是请求压力的估算，而非账单；成本上限的新鲜度则取决于部署的价格。guard 同样无法中断已经在飞行中的工作：它停止的是下一次请求，因此挂起的提供方调用需由其他手段约束。人类输入按设计绕过所有上限，这意味着持续 steer 的用户会让轮次越过每一道上限。

## Testing

十八个 spec 驱动真实的 `AgentLoop` 对脚本化 mock adapter 运行：未配置任何上限时正常完成；各项上限均已配置但都未到达时正常完成（不产生事件）；每项上限到达时恰好产生一条 `budget/exceeded` 事件，指明该项上限、其实测值、限值以及被停止的轮次与步骤，并紧邻 `blocked` 的轮次结束之前；没有成本上限的价格保持无作用；该事件的读取路径准入，以及它经带 seed 的日志回放后仍然保留；在同一会话的两个轮次中展示人类输入规则（第一个在 token 上限处被切断，第二个携带用户消息进入）；在轮次中途挂载的插件永不切断它挂载时所处的轮次；销毁后两个监听器都被移除（下一轮次正常完成而非被切断），以及零、负数、NaN、无穷值、没有价格的成本上限与非正价格在加载期失败即报。按文件覆盖率在语句、分支、函数与行上均为 100%。

## Deferred

- 各项上限的宿主配置界面；目前它们通过组合行到达插件。

## Related

- [会话事件读取弃用](../../implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)——guard 为何折叠投递的事件而不是读取历史。
- [Evolution Curator](../../implemented/feature/2026-09-11-evolution-curator.zh.md)——同一规范下的同组长周期切片。

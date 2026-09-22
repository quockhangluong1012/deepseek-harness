# Agent Note: 基于条件的演化提示

Status: implemented

[English](2026-09-22-condition-based-nudges.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` §53 把“周期性提示 → 基于事件/条件的元认知触发器”列为对既有机制最有价值的升级之一。`packages/context/evolution-memory-context` 的提示层正是尚未升级的那一半：两个固定文本分节 `evolution-memory-scope` 与 `evolution-lessons-skills`，在 `Math.max(turn, 1) % interval === 0` 的回合渲染——作用域那句话每 `memoryNudgeInterval` 回合一次（默认 1，即每回合），经验转技能那句每 `skillNudgeInterval` 回合一次（默认 10）。回合计数器决定提示何时出现，而文本不依赖 harness 已知的任何东西：无论是否发生过失败，它都要求模型记录可持久经验；无论是否有任何东西被暂存，它都要求模型待在目录作用域之内。

与此同时，兄弟包已经装满了元认知触发器正要读取的证据。`evolution-memory` 持有待决的暂存写入及其暂存时刻；`evolution-skill-telemetry` 持有每个技能的信任状态及其记录在案的降级；`evolution-feedback` 聚合失败信号，并把决定性的那些评为 `trigger_review`；`evolution-graph` 跟踪每个活跃主张的相反证据；`evolution-benchmark` 持有每个任务所处的档位，包括哪些能力始终没有到达 `holdout`。提示层对此一概不读，因此那句敦促行动的提醒，在无事可报时出现的机会与真出事时一样大。

## 决定

1. **一条提示就是一个记录条件，而条件点名决定它的存储。** `src/conditions.ts` 把五个条件作为数据持有——`staged-writes`、`contradicted-claims`、`skill-trust`、`failure-signals`、`holdout-gaps`——每个都带有它渲染进的分节、它读取的服务，以及当该服务未挂载时它点名的对象，另加一张穷尽的 `Record<NudgeConditionId, NudgeEvaluator>`，每个条件一个以后端存储为依据的评估器。每个行渲染函数都是纯的：证据由调用方取来，因此文案是一次单元测试，而不是一份宿主夹具。

   | 条件 | 所读存储 | 触发它的证据 |
   |---|---|---|
   | `staged-writes` | `ctx.evolutionMemory.read(scope).staged` | 最旧的待决条目早于 `stagedWriteWaitMinutes` |
   | `contradicted-claims` | `ctx.evolutionGraph.claims(scope)` | 某个活跃主张带有相反证据 |
   | `skill-trust` | `ctx.evolutionSkillTelemetry.entries()` | 某个技能在记录到一次降级后停留在 provisional 信任 |
   | `failure-signals` | `ctx.evolutionFeedback.signals(作用域会话, 扫描上限)` | 某条信号自身被评级为 `trigger_review` |
   | `holdout-gaps` | `ctx.evolutionBenchmark.tasks()` | 某个可学习状态下的能力没有 `holdout` 任务 |

2. **区间变为节奏上限，而非触发器。** 分节承载的每个条件都会在组装时被评估；已触发的条件按会话与条件分别记住，并在观测到 `interval` 个后续回合之前保持沉默，因此宿主今日所设的字段保留原数值，并获得 §53 的语义。由此得到两个结果：判定从取模改写为冷却（`nudgeDue(lastFired, turn, interval)`），并且把触发所在的那一回合视为仍在触发，因此同一回合内的两次组装渲染出相同的提示，而不是第二次丢掉第一次已经展示的提示。

3. **行陈述条件，而不是建议。** 每条触发的行点名计数、它所读到的时刻或状态，以及可据以行动的运维界面（`run /memory pending`、`run /claims`、`run /curator status`、`record the durable lesson with skill_manage`、`run /benchmark`）；当分节没有任何条件成立时，它什么也不渲染。两句固定文本随之移除：常驻建议正是本次升级要取代的东西，README 记录了想要它回来的部署应自备分节。

4. **“不可评估”是第三种答案，而不是沉默。** 存储未挂载的条件会渲染 `"<subject> cannot be checked: the <store> store is not mounted."`，而不是悄悄报告“无事”。沉默意味着“存储看过了，条件不成立”；缺失的存储并没有看过，读者必须能区分两者。不属于任何已注册 workspace 的会话则连作用域都没有，这又是另一回事：两个作用域绑定的条件在那里没有可陈述的对象，因此保持沉默，而三个全局条件仍然渲染。

5. **不新增会话事件，因为该分节本身就是一个事件。** 提示文本沿用它与生俱来的同一个 `systemPrompt.section` 注册——已记录提示层中的一个具名分节——因此一条基于条件的行与固定文本一样被记录在案。此处没有任何推送：条件在提示组装时被评估，而这正是既有渲染路径本来运行的位置。

6. **每个阈值要么是存储自身的裁定，要么是一个配置字段。** 只有两个条件需要新字段：`stagedWriteWaitMinutes`（真实的等待——部署方愿意让一条暂存写入悬而未决多久）与 `failureSignalScanLimit`（单次评估扫描多少条已评级信号）。其余都是存储自身的布尔裁定——一个主张要么带有相反证据要么没有，一条信号要么按 `evolution-feedback` 的 `triggerReviewSessions` 评为 `trigger_review` 要么没有——因此条件读取存储的阈值，而不是复刻它。

## 考虑过的替代方案

- **在条件行旁保留固定建议。** 否决：§53 的升级就在于提示要言之有物；把旧句子挂到每条触发的行上，会在加上条件自身成本的同时把常驻 token 成本放回来。
- **订阅存储事件，而不是在组装时读取。** 否决：这是为更小的收获引入更大的机制——这些存储并未为这些流转发布事件，因此触发器将不得不新增一个会话事件再加一条队列，而一则提示只有在模型即将读取的提示里才有用。条件恰好在那个时刻被评估。
- **从会话日志而非存储推导条件。** 否决：这些存储持有的正是派生的裁定——图存储信念模型下的主张矛盾计数、反馈存储归因规则下的信号可行动性、遥测存储降级规则下的技能信任。在上下文包里重新推导它们，等于把每个存储的规则再实现一遍，并与第一份实现逐渐分叉。
- **既然已有一个条件需要时间阈值，就给所有条件都配一个。** 否决：只有暂存写入是真正在“等待”。被反驳的主张、被降级的技能与被评级的失败信号都是存储自身的裁定，为它们发明一个年龄会把事件变成衰减。
- **为每个条件各配一个区间字段。** 否决：相比分节已有的上限，这多出五个配置字段，而宿主问的问题只是——本层级可以重复自己的频率。
- **移除区间字段。** 否决：宿主今日就设置了它们，而这个上限正是一个持续成立的条件（无人修复的 holdout 缺口、无人裁决的暂存写入）不会每次组装都重复的原因。
- **对未挂载的存储改用 logger 警告而非提示行。** 否决：那是有礼貌的静默失败。要求是缺失的存储必须能与“条件成立”区分开，而提示正是这一差异按会话可见的表面。
- **让整个层级都由条件驱动，包括会话搜索提示。** 否决：该提示并非关于已记录的证据，而是一条关于如何回忆的常驻指令，且 harness 中没有任何东西记录“用户曾被要求重复上下文”。

## 后果

- 系统提示层现在随存储状态变化：单独一次记忆写入让它逐字节不变（各行只携带计数、时刻与存储标识，绝不携带记忆文本），而一个条件开始或停止成立会从该点起改变它。README 把这记为该层级的 KV 缓存效果与一条限制。
- 安静的分节现在也是信息。只挂载 `evolution-memory` 的部署每个区间会看到四条点名未挂载存储的通知，代替它无法评估的那四个条件——这是诚实的读法，也是运维者可据以行动的那一种。
- 四个新的 peer 与 dev 依赖（`evolution-feedback`、`evolution-graph`、`evolution-benchmark`、`evolution-skill-telemetry`）与两个新的 `Config` 字段（`stagedWriteWaitMinutes`、`failureSignalScanLimit`），因此生成的配置目录与该包的 tsconfig 引用必须跟上（目录重生成与四个 project reference 属于主 agent 的改动）。
- `isNudgeTurn` 与 `lessonsSkillsText` 已移除；`nudgeDue` 取代前者，而后者没有替代者，因为技能分节的文本现在是证据而不是常量。

## 与计划的偏离

§53 要求基于事件/条件的触发器。这里只落地了条件那一半：触发器仍在提示组装时被评估，而不是由事件推送。推送需要一个新的会话事件，并在提示层前加一条队列，而且它会在步骤之间投递一则提示——模型在下一次组装时本来就会读到；真正改变“模型被告知什么”的，是记录条件那一部分。

## 途中发现的修复

无。有一处疑点经查证后排除：固定文本里的 `Math.max(turn, 1)` 把没有任何已观测回合的会话当作其第一回合，这正是默认 `memoryNudgeInterval` 能在第一个 `turn/start` 之前渲染的原因。冷却判定免费保留了该行为——从未触发过的条件即为到期，而未观测的会话处于回合 0——因此无需为保留它写特例。

## 测试

`packages/context/evolution-memory-context/tests/conditions.spec.ts` 在不依赖上下文的情况下钉住条件词汇与每个行渲染函数：暂存写入窗口（空、窗口内、已等待）、矛盾计数、`trigger_review` 评级、降级后停留在 provisional 的信任状态，以及针对已被覆盖能力与仅有终结状态能力的 holdout 缺口。随后它以合成依赖驱动 `NUDGE_EVALUATORS` 的每一项，钉住每个条件的三种答案——安静、触发，以及点名其服务的未挂载通知——外加作用域绑定的条件在无作用域时保持沉默，以及失败扫描把作用域的会话 id 与配置上限透传进去。

`packages/context/evolution-memory-context/tests/sections.spec.ts` 在内存后端之上以真实存储启动提示层，覆盖宿主可见的行为：五个记录条件各自渲染自己的行；没有任何条件成立时的沉默；未挂载通知与仍能渲染的已挂载条件并存；一个持续成立的条件在 `memoryNudgeInterval` 回合内保持沉默、之后再次触发（同回合重组结果一致，两个会话各自跑独立节奏）；`skill_manage` 不可见时技能分节被丢弃；不属于任何 workspace 的会话只丢失其作用域绑定的行；无会话时的组装；以及提示在一次记忆写入前后逐字节不变。`tests/inject.spec.ts` 的加载套件补上了两个新字段的拒绝用例。

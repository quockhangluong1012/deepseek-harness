# Agent Note：整理器的 host 范围触发与可选归并

状态：已实现

[English](2026-09-12-evolution-curator-trigger-consolidation.md) | 中文

## 问题

`specs/evolutionary-harness.spec.md` 给整理器派了两件本包尚未完成的活。其触发原为调用方传参的 `maybeRun`，而规范点名三处 host 面——CLI 启动、gateway 家务、`serve` 维护定时器——会话局部的 `schedule` 设施无法承担 host 范围的维护通过。第二件活，对 agent 创建技能的可选 LLM 归并，此前完全不存在：本包只调查候选便止步，保留/补丁/归并/归档裁决与整包规则没有归属。

## 决策

**由插件自己拥有计划。** `evolution-curator` 每个 host 只挂载一次，因此一个定时器覆盖 Electron 桌面子进程、`serve` 与 gateway，一次启动时到期检查覆盖短命 CLI 运行。挂载时自己观测 host 范围的 `session/event` 活动（不新增跨包设施），运行一次被 await 的到期检查，随后装上一个 `tickMinutes` 间隔定时器，`unref()` 过并经 `ctx.effect` 处置。到期检查仅在 `lastRunAt` 起经过 `intervalHours`，且 `minIdleHours` 内没有会话事件到达时才运行一次通过；本进程观测到任何活动之前 host 视为闲置——这正是已到期的 CLI 启动得以运行的依据。首次检查播种 `lastRunAt` 并递延一个周期；计划触发失败会被捕获并告警，使定时器存活。`enabled: false` 不启动定时器，也永不触碰记账。闲置既可以由 `maybeRun` 的 `idleMs` 显式覆盖，也可以取观测到的活动间隔；规格用假定时器驱动两者，因此不发布任何仅测试用的时钟接缝。

**归并在进程内运行，而不走 subagent 接缝。** host 插件无法无头 fork 子 agent：进程内 provider 从活跃父会话最近一次请求继承路由，而维护通过没有会话。因此 fork 是 `ctx.llm` 之上的有界进程内工具循环，白名单只有 `skill_view`（读取一个候选包）与 `skill_apply`（记录一条裁决）。一条 `cost` 行 `{inputBytes, maxOutputTokens, provider, model, truncated}` 在首次请求之前进入台账；循环至多花 `maxSteps` 次请求，在首个纯文本回答处结束，并受 `timeoutMs` 截止时间约束，插件处置时同样中止。

**所有写入都由整理器执行，因此无论模型要求什么，整包规则都成立。** `patch` 就地重写 `SKILL.md`。`consolidate` 裁决把候选的整个目录搬到伞技能之下，把被搬移树中每一处 `${DSH_SKILL_DIR}` 引用改写为新的相对根，并向伞技能的 `SKILL.md` 追加一条引用。`archive` 裁决把整个目录搬入 `.archive/`。因此随包携带 `references/`、`templates/`、`scripts/` 或 `assets/` 的包绝不会被压平成只剩 `SKILL.md`；伞技能缺失、不可写，或已占用该目录名时，包原地不动，该裁决计入跳过。归并记一条携带两端点的 `move` 台账条目，`rollbackPass` 在恢复生命周期状态之前把每个被搬移的包搬回，因此归并运行与该通过的其他部分一样可以回滚。

## 考虑过的替代方案

**从插件 fork subagent 接缝。** 依证据而非偏好拒绝：组合进来的进程内 provider 构造子 agent 时，把请求字段合并到父级*最近一次记录在案的请求*之上；没有会话、没有请求头的调用方无从继承路由，而进程外后端则要为一次维护通过额外拉起第二个 harness 进程。因此以 host 插件挂载的整理器无法无头 spawn，真正落地的是 `ctx.llm` 之上的有界进程内工具循环。若将来由持有会话的调用方驱动归并，该接缝对它重新可用。

**为调查或包哈希加持久缓存。** 拒绝：`telemetry.entries()` 本就是经校验的内存状态上的同步读取，`skills.list()` 是目录自己的答案；持久副本会为同一批记录引入第二个真相来源与失效问题，换来的只是省下一次成本可忽略的读取。通过每次运行都重新推导候选集，这正是两次通过与两次通过之间被补丁过的技能仍可见的原因。

**把 `pruneBuiltins` 默认为 `false`。** 拒绝：随包内置技能由产品拥有，从不属于用户的整理范围，因此默认剪除是保守选择，也保持了既有组合的原有排除行为。该字段的存在，是让确实想整理内置技能的运维者可以明说；无论取值如何，hub 来源始终豁免，因为 hub 技能是共享状态，其生命周期不由本 host 决定。

**归并时就地改写 `SKILL.md`（压平）。** 拒绝：这正是整包规则禁止的失败——随包携带 `references/`、`templates/`、`scripts/` 或 `assets/` 的包会丢掉 `SKILL.md` 指向的每一个文件。搬移整个目录并把 `${DSH_SKILL_DIR}` 改写为新的相对根，可让每处引用继续可解析，而整理器无需理解任何文件的内容。

## 后果

维护计划不再依赖 host 调用进来：挂载就是全部触发，而 `enabled: false` 现在对定时器与记账都等价于移除。代价是每个 host 进程一个 unref 过的定时器，以及挂载时一次被 await 的到期检查；在全新家目录上该检查只写 `lastRunAt`。

归并保持可选，并在开启却缺路由时大声失败：`provider`/`model` 只设一半、或开启归并却缺少二者，都会在加载时拒绝，因此不会出现静默跳过掩盖配置错误的 fork。

回滚恢复生命周期状态与被搬移的包，永不恢复被补丁的正文：`patch` 裁决仅为审计记账。归并也只改写目录引用，不改写计划条目——目前没有任何计划条目引用技能，因此在蓝图转 cron 落地之前，`protectedNames` 仍是计划引用的护栏。

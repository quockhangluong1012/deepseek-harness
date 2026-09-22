# Agent Note: 补全轨迹投影与反事实回放

Status: implemented

[English](2026-09-22-trace-trajectory-replay.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` 中的两个机制族此前只建了一半。

**§3.1/§3.3 —— 轨迹不完整。** `dsh-evolution-trace` 已把已提交的会话日志投影为 turn、step、工具调用、重试、用量与延迟，并带排序的失败根因和一条压缩学习行。但规范 §3.1 轨迹清单点名的其余条目全部缺失，即便日志记录了它们：每个 step 运行时所处的编译上下文身份（`context/compiled`）、计划与子目标（`todo/write`、`task/plan`）、被查阅的知识表面（检索调用）、每个 turn 结束时的回答（其最后一条助手文本）、评估结果（`verification/result`）与用户反馈（`feedback/record`）。一个想问「这个 step 是在什么上下文下作出的决定，这次会话究竟得出了什么结论」的读者，只能回去重读原始日志。

**§16/§17 —— 没有针对生产轨迹的回放。** 仓库里唯一的回放引擎是 `disabled: true` 的评分器里的录制夹具运行器：它针对磁盘上的语料夹具启动全新子进程。没有任何东西在*会话日志已经持有的同一条轨迹*上比较基线产物与候选产物；而让无密钥、确定性回放成为可能的唯一材料——轨迹里已记录的工具输出——根本没有被保留：投影只保留失败调用的文本，丢弃了每一次成功调用的文本。

## Decision

扩展现有的只读投影，并在同一个包里新增一个纯回放模块。不新增包、不新增存储域、不调用模型、不写入任何东西。

1. **只承载日志确实记录的内容，并对无法取材之处明说。** 每个新增的 `TraceRecord`/`TraceTurn`/`TraceStep` 字段都取自某个已记录事件：step 的上下文身份取自 `context/compiled`（其 `digest`），生效中的计划取自 `todo/write`（带子目标状态）与 `task/plan`（不带状态），知识表面取自检索调用，最终回答取自最后一条助手文本，评估与人类反馈取自 `verification/result` 与 `feedback/record`。README 把 §3.1 清单做成一张表，逐行写明来源，并标出日志无法提供的两项——`intermediate decisions` 与 `artifact versions used`——它们以缺失形式存在，而不是以占位符形式发出。
2. **`TraceToolCall.snapshot` 就是回放基底。** 现在每个调用都保留其已记录结果的截断文本，无论成败；此前只有失败调用保留文本。这正是 §17 所说的「快照相关工具输出」：回放读取已记录输出而非重新调用工具，因此无需密钥、无需进程、无需实时外部状态。
3. **回放是针对一条已投影记录的纯函数。** `replayTrace({ trace, baseline, candidate })` 遍历轨迹的 step，报告每个 step 重建出的上下文摘要，把每个调用解析为 `snapshot`、`artifact` 或 `missing`，并把基线的解析结果与候选的解析结果相比较。`EvolutionTrace.replay(sessionId, baseline, candidate)` 是读取路径：先投影已存储的日志，会话缺失时返回 `undefined`，与 `trace` 完全一致。
4. **产物的可观测效果体现在检索表面。** 当轨迹记录的某次检索点名了两个修订都声明拥有的产物时，回放输出就是恢复后的正文；其余位置由已记录快照承担。这就是轨迹所能支撑的极限：它记录了一次检索发生过、返回了什么，而不是模型随后如何使用它。
5. **快照是回放性的闸门，而无法回放的 step 绝不会被当作「未变」。** 日志未记录文本结果的调用在两个修订下都解析为 `missing`——刻意不解析为产物正文，因为那等于对那次记录运行所见内容的猜测。这类 step 被报告为 `unreplayable` 并点名其工具，其 `differs` 为 false 只是因为无从比较。`snapshotSteps`、`changedSteps` 与 `unreplayableSteps` 点名三组不同的集合，使调用者不可能把沉默读成证据。
6. **投影把记录绑定到它到达时正在打开的区段，并在关闭者处解除该绑定。** `step/end` 与 `turn/end` 会清空打开的 step 与 turn。没有这一点，在某个区段关闭*之后*写入的计划或编译记录会覆盖该区段自身的记录——这是本次改动引入并被其自身测试抓到的缺陷，而非既有缺陷。

## Alternatives considered

- **另立 `evolution-replay` 包。** 否决：回放的全部输入是本包产出的 `TraceRecord`，其输出是针对该记录的报告。在此处划包边界意味着为了一个纯函数而把整套轨迹词汇表跨越两份 manifest 导出，并且会把 §17 机制放到它回放的那条轨迹之外。
- **把回放放进 `evolution-scorer`。** 否决：评分器的回放针对语料启动子进程，需要语料目录，而其行在产品 profile 中是 `disabled: true`。§17 的回放必须能在已发布 profile 中、在没有那一行的情况下从已记录轨迹工作；评分器是度量包——把只读比较放进去还会让度量包成为轨迹语义的所有者。
- **通过重新调用工具来回放一个 step。** 否决：那恰好重新引入 §17 所警告的非确定性，并需要实时沙箱与密钥。已记录快照就是模拟器。
- **让产物正文顶替一个日志未记录输出的调用。** 否决：那样基线的解析结果就成了对一次「无人记录其输出」的运行的主张。把该 step 报告为不可回放才是诚实的答案，也正是验收标准所要求的。
- **从轨迹本身声明产物版本。** 否决：会话日志中没有任何东西记录被检索产物的修订——技能修订存在于 `evolution-skill-telemetry` 自己的存储里，而轨迹不读取它，也不应开始读取。因此 `ReplayArtifact` 的 `id`、`version` 与 `body` 由调用者给出，README 明说：写错修订的调用者拿到的就是一对错误修订的比较。
- **为补上 §51 第 1 条的「事件总线」而增加活动的 turn 结清发射。** 暂缓而非否决：规范自己的优先级图谱把该总线的消费者（curriculum、shadow/canary）放在 P1，当前也不存在接收该事件的消费者，而 README 已记录这一缺失。为没有订阅者的事件建总线，等于一个没有读者的注册。
- **把 `action/proposed`/`action/committed` 作为 §3.1「中间决策」投影进来。** 否决：这些事件只在 `agent-kernel` 挂载时存在，而没有任何已发布 profile 挂载它，因此该字段在产品中将永远为空——一个占位符，正是本次改动第 1 条所禁止的。README 改为点名该条目无法取材。
- **本地重新声明那四种外部载荷类型而不导入。** 否决：`ContextCompilationRecord`、`VerificationResult`、`FeedbackRecord` 与 `TodoItem` 是所属包发布的会话日志词汇；在此重新声明会在既有约定之外另立一套，并且会悄悄漂移。这些导入都是 type-only，因此运行时导入闭包不变。

## Consequences

- `TraceRecord` 新增 `evaluations` 与 `feedback`；`TraceTurn` 新增 `subgoals`、`retrievals` 与 `finalAnswer`；`TraceStep` 新增 `context`；`TraceToolCall` 新增 `snapshot`。另有八个新公开类型（`TraceSubgoal`、`TraceRetrieval`、`TraceFeedback`、`ReplayArtifact`、`ReplayCallOutcome`、`ReplayStepReport`、`ReplayReport`、`ReplayRequest`）加入其中。
- `evolution-trace` 新增四个 type-only 工作区依赖（`dsh-agent-context`、`dsh-agent-kernel`、`dsh-command-feedback`、`dsh-tool-todo`）与四个项目引用。运行时不会新加载任何东西；该包依旧不开存储域、不调用模型、不写入。
- 未挂载 `dsh-agent-context`、`dsh-agent-kernel`、`dsh-tool-todo` 或 `dsh-command-feedback` 的部署只是不会记录那些事件，相应字段因此投影为空。不会有任何报错。
- 枚举服务、配置字段、模块边与类型的那四份目录各自为本包的新导出增加了行；它们随本批次重新生成，而非手工编写。

## Deviations from the plan

计划把 §3.1 的七项列为投影工作。README 表格十三行中有两项无法从会话日志取材，因此以事实报告而非实现：`intermediate decisions`（不存在已记录的决策事件，唯一候选事件位于未挂载的插件中）与 `artifact versions used`（根本不存在已记录的产物版本事件）。§51 第 1 条的「事件总线」那一半同样留在规范优先级图谱给它安排的位置——P1，连同其消费者。

## Fixes found on the way

- **区段的记录可能被后到的记录覆盖。** `openTurn` 从不被清空，因此某个 turn 结束后写入的 `todo/write` 会改写该 turn 的子目标；`openStep` 同样让后到的 `context/compiled` 改写更早 step 的上下文。新测试抓到该问题，修法是在 `step/end` 与 `turn/end` 处关闭二者，并用两条测试把绑定固定到「该时刻正在打开的那个区段」。
- **失败文本里一处死分支。** 失败记录中的 `message ?? pending.name` 永远走不到右操作数，因为失败路径只在错误结果时运行，而错误文本上一行已经回退到工具名。改为一次性解析失败文本，同时也删掉了一个会被逐文件 100% 门拒绝的未覆盖分支。

## Testing

`packages/evolution/evolution-trace/tests/` —— 四个文件共 55 条测试：`project.spec.ts`（投影，含新的轨迹字段）、`summarize.spec.ts`、`replay.spec.ts`（反事实比较）与 `trace.spec.ts`（服务读取路径）。本改动据以判定的行为：

- 由夹具记录的轨迹投影出新字段：绑定到生效 step 并向后顺延的上下文摘要、来自待办快照的子目标状态与来自内核计划的无状态步骤、从已记录参数中读出的检索目标（失败检索同样保留）、作为最终回答的最后一条助手文本、按日志顺序排列的评估与人类反馈，以及每个调用的一条截断快照；
- 以两个产物修订回放同一条轨迹，会针对各自点名的检索恢复各自正文、逐 step 比较、点名候选改变的 step，并点名仅凭快照回放的那个 step；
- 日志未记录文本结果的调用会让其 step 在两个修订下都是 `unreplayable` 且点名该工具，绝不会是无声的持平——包括该调用恰是产物本应顶替的那次检索时；
- 编译或计划记录绑定到该时刻正在打开的区段，绝不绑定到已关闭的区段。

`pnpm exec vitest run packages/evolution/evolution-trace packages/evolution/evolution-scorer` 通过（109 条测试，12 个文件）；`packages/evolution/evolution-trace/src` 的逐文件覆盖率为 statements、branches、functions、lines 全部 100%。

## Left alone

回放重建一条轨迹的各个 step，并报告两个产物修订在何处不同；它从不运行模型，因此无法断言候选的回答是否会更好——只能说明被检索产物的输出发生了变化以及变化在哪。`evolution-scorer` 未被改动：它的语料运行器回答的是另一个问题（一个场景在全新进程上如何评分），并继续承担该职责。轨迹存储对会话日志保持只读，恢复后的产物正文只存在于报告中，因此希望把产物状态落到实际工作区的调用者自己负责那次写入。

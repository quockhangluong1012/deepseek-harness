# Agent Note: 演化治理命令

Status: implemented

[English](2026-09-12-command-evolution-governance.md) | 中文

## Problem

在 `/memory` 与 `/refine` 落地之后，人可以裁决暂存的记忆写入、重建经验教训，却无法看见 harness 到底记录了什么、无法裁决暂存的 skill 条目，也完全读不到 curation 状态（`/memory approve` 面对 skill 类条目只会回一句「需要先写入 skill」）。`specs/improvement.spec.md` 第六阶段点名了缺失的表面，并规定在 Web journey 落地前由 CLI 拥有治理权：`/journey [today | 7d | 30d | all]`、`/skills pending | diff | approve`、`/curator status | run [--dry-run]`。

可见性这一半需要的是一层架在既有数据之上的读模型——scope 记录、curator 账本、skill telemetry——且不新增任何持久状态、会话事件或模型可见文本。

## Decision

`@deepseek-ai/dsh-command-evolution` 再注册三个命令，并把 skill 类治理从 `/memory` 中拆出。

`/journey [range]` 由新的纯函数模块 `src/journey.ts` 渲染 scope 时间线：`scopeTimeline(input)` 接收命令已经读到的记录、容量、摘要、范围与时钟，返回按日分桶、累计核算与待裁决行。只有记录能够证明的事实才会产生一条 delta——记忆文档（抽取来源，或由 `memoryUpdatedAt` 得出的「手工编辑」）、每个 context 项、每个已索引产出、每个暂存条目——并落在看板的 UTC+7 日历上。日历辅助函数（`dayKeyUTC7`、`daysOfRange`、`windowStartOfRange`、`isUsageRange`）现已从 `@deepseek-ai/dsh-usage-ledger` 根导出，因此 journey 与用量看板按完全相同的「天」分桶，而不是各自重推时区偏移。

有限区间在模型里保留补零的桶（与规格的形状一致），渲染时只列有活动的日子并给出窗口，于是安静的 `30d` 窗口仍是一屏；`all` 报告其活跃天数。命令输出为容量、文档字节、摘要、每日行与暂存计数——全部是宿主侧稳定文本。

`/skills pending | approve <id> | diff <id>` 拥有 skill 类暂存条目。批准会丢弃那条由人已经通过 `skill_manage` 写完 skill 文件的条目（存储的批准路径刻意不执行任何写入），成功文本也这样说明。`/memory approve` 遇到 skill 类 id 时改为指向 `/skills approve <id>`，而 `/skills approve` 遇到 memory 类 id 时报告 `No staged skill '<id>'.`——每类只有一条裁决路径，绝不跨类静默应用。`diff` 如实报告缺口：在后台评审能够提出 skill 之前，暂存载荷还没有声明形状。

裸 `/memory` 或 `/skills` 报告待处理清单。`pending` 是文法的默认动词而非必需动词，与裸 `/journey` 的 `7d` 一致：不带参数伸手调用命令的读者读到的是状态；而从菜单挑选无参命令的客户端——合成器派发裸 token——得到的也是同一份清单，而不是用法拒绝。

`/curator status` 是宿主级的，不解析 scope，而 `/curator run [--dry-run]` 运行由间隔触发器拥有的同一次维护通过——语法在挂载检查之前校验，因此即使没有整理器，畸形动词也报告用法：它通过 `ctx.get` 读取 `evolutionCurator.lastRunAt()` / `passes()` 与 `evolutionSkillTelemetry.entries()`，因此缺少这两个服务的部署仍会得到命令，只是答案诚实地变短（`The evolution curator is not mounted.`，或 `Tracked skills: unavailable (skill telemetry is not mounted).`）。该通过报告其移动、跳过计数与快照 id，并标明预览不写入任何内容。

## Consequences

人现在无需 Web 客户端、也无需翻看存储，就能看见某个 scope 记录了什么、发生在何时，裁决暂存的 skill 条目，并读取 curation 记账；这些命令不新增持久状态，也不新增模型可见文本。

时间线只报告记录保留的事实。规格列出的两个桶计数不会出现：`stagedApproved` 与 `stagedRejected` 需要存储并未保留的裁决记录（无论批准还是拒绝，条目都会被丢弃），而 session-query 的 surface 读取只暴露模型表面事件，因此逐事件的 `command/run` 载荷除非做一次 N+1 的事件窗口读取便无法取得；此外 `instructions` 与 `profile` 的 delta 无法与 lessons 区分，因为记录对这一族只保留一个 `memoryUpdatedAt`，并与产出索引、暂存共享 `updatedAt`。这两个缺口写在包 README 与规格里，而不是用猜测填满。

skill 类治理现在是人必须理解的两步契约：先写 skill，再批准条目。若部署暂存了 skill 条目却从未挂载 `skill_manage`，批准就等于批准了一个空动作——成功文本会明确提醒这一点。

## Verification

`packages/evolution/command-evolution/tests/journey.spec.ts` 以固定时钟锁定纯模型：跨两个 UTC+7 日的分桶、`today`/`7d`/`all` 的窗口过滤、有限区间的补零与 `all` 的仅数据、手工编辑兜底、容量／摘要／文档字节、待裁决投影，以及包括空区间与零容量在内的渲染文本。

`packages/evolution/command-evolution/tests/command-evolution.spec.ts` 通过真实注册表锁定命令：五个命令的注册与销毁、未知与畸形动词的用法错误（裸 `/memory` 与 `/skills` 列出待处理清单）、无 scope 时的拒绝、用种子数据逐字渲染的 `/journey`（日键由 `dayKeyUTC7` 计算）、`/skills` 的空状态与仅列 skill 的清单、批准后条目被丢弃、两个命令上的跨类拒绝、`diff` 的缺口提示，带/不带 telemetry、带已记录 pass 的 `/curator status`，以及两种模式下的 `/curator run` 及其跳过计数、快照行、单复数措辞与未挂载拒绝。

文档闸门让契约保持可见：新导出上的 `verify-package-readme-limitations`、`verify-package-readme-summaries`、`verify-export-jsdoc`，以及 README 三件套的 `verify-translation-pairing`。

## Alternatives considered

**等 Remote controller 再在读模型里实现。** 规格把时间线指派给尚不存在的 `evolutionController`，于是本阶段 CLI 什么也得不到。模型放在 `src/journey.ts` 并对外导出，controller 可以直接导入而不是重述一遍。

**从 `command/run` 事件推导批准计数。** 载荷确实带有命令名与参数，但 session-query 这一缝只返回不含载荷的事件记录；要拿到载荷就得为每个命令事件做一次 `readEvent` 窗口读取——为了一个计数做 N+1 次读。持久解法是在存储里记录裁决，属于添加它们的那次规格变更。

**用 `updatedAt` 报告 `instructions` 与 `profile` 的 delta。** 该时间戳也会因产出索引与暂存而移动，因此只要记录因别的原因变化，这个断言就是错的。一条指明真实来源的记忆 delta 才是诚实的形状。

**把所有暂存裁决都留在 `/memory`。** 一条会静默丢弃 skill 条目的命令会让人以为 skill 已经落地；拆分让这个两步契约出现在拒绝它的那句消息里。

**把时间线词汇放进新包。** 这些 kind 与 bucket 今天是命令的读模型，明天是 controller 的；只有一个命令消费的包会凭空增加一个 workspace 条目和一条依赖链，却还没有任何复用。

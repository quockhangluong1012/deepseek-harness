# Agent Note: 演进控制器、可归因的 journey 增量，以及 export/learn/suggestions 命令

Status: implemented

[English](2026-09-12-evolution-controller-journey-cli.md) | 中文

## Problem

`specs/improvement.spec.md` 的 Phase 6 列出了首个 CLI 切片之后仍缺失的四个面：`evolutionController` Remote 命名空间（Web journey 的宿主半边）、两处延期的读模型缺口、会话导出，以及 `/learn` 与 `/suggestions` 两个动词。当时只有 CLI，因此客户端无法读取或编辑某个作用域，时间线说不清是哪个文档发生了移动、人类裁决了多少条暂存写入，人类也无法导出会话或让 harness 去学习某件事。

两处读模型缺口被记为延期而不是猜测：`stagedApproved` / `stagedRejected` 需要一条存储在做决定时就丢弃的裁决记录，而 `instructions` / `profile` 增量需要记录当时并未保留的按文档族写入时间戳。

## Decision

`@deepseek-ai/dsh-evolution-controller` 在持久化的按作用域记录之上发布 `evolution` Remote 命名空间：`read`、`setInstructions`、`setLessons`、`setProfile`、`addContextItem`、`removeContextItem`、`rebuildMemory`、`listStaged`、`approveStaged`、`rejectStaged`、`timeline`，以及 `follow` 流。请求键是冻结的 `scopeId`，类型为 Workspace 身份：控制器用必填的 `profile` 配置为其加命名空间，因此客户端从不自行命名作用域命名空间。每个动词都先经由注册表解析 Workspace，并以 `workspace/not-found` 失败；暂存动词还额外证明该条目属于已解析的作用域，因此另一个作用域的 id 会被报告为 `evolution/staged-not-found`，而不是被裁决。`follow` 订阅 `domain/changed`，只保留 `evolution_memory.records` 的写入，忽略墓碑，通过重新计算该 Workspace 的存储键把记录键映射回已注册的 Workspace，并在发布一份携带全部已注册作用域的基线后为每个 follower 推送一次 upsert。重连留在客户端传输层：一次 `follow` 调用就是一代，宿主中不承担任何重试簿记。

时间线动词复用 `dsh-command-evolution` 的 `scopeTimeline` 而不是重述它，因此 `/journey` 文本与 Remote 时间线不可能互相矛盾。

在存储的裁决台账与按文档族时间戳落地后，`scopeTimeline` 现在按各自的时间戳输出 `instructions`、`lessons` 与 `profile` 增量（每项归因于时刻恰好匹配的那次抽取，或归因于手工编辑），并从 `resolutions` 按天统计 `stagedApproved` / `stagedRejected`，同时在模型中保留只有裁决的活跃日。经验/画像时间戳缺失的记录——存储为 `memoryUpdatedAt` 保留的一个发布窗口——仍按其抽取或 `memoryUpdatedAt` 读作一个 `lessons` 增量，因此既有记录保持其原有说明而不是丢失它。渲染出的当日行会列出被分开的类别与已裁决计数；CLI 文法与窗口语义（有界区间零填充、`all` 仅有数据）保持不变。

`/trajectory [--out <path>] [--all]` 通过冻结的 `ctx.evolutionTrajectory` API（用 `ctx.get` 解析，因此没有导出器的组合会给出诚实回答）导出调用会话，或用 `--all` 导出调用作用域，并报告写入路径及其会话数与字节数。`/learn <anything>` 构建一段提示词，点名主题、已有的读/搜索/web 工具，以及受提案门控的 `skill_manage` 保存，然后把它作为一个后续回合的唯一普通消息排队；命令自身不写任何内容。`/suggestions` 列出 frontmatter 带有 `blueprint` 的技能，从解析后的字段或它被解析自的 frontmatter 袋读取并拒绝不被接受的形状，并声明它不安装任何调度。

## Verification

`packages/evolution/evolution-controller/tests/controller.host.spec.ts` 在内存存储后端上驱动真实存储：空投影与有内容投影、三处文档写入、文本与文件上下文条目及其包含性拒绝（缺失路径、目录、Workspace 根自身、根之外、消失的根、消失且带分隔符后缀的根、junction）、重建成功加未挂载评审器与两种失败映射、暂存列举与经作用域校验的批准和拒绝、时间线区间与未知区间拒绝，以及 follow 流（每个作用域一份基线、被忽略的外部域/表/墓碑/其他 profile 写入、真实写入触发 upsert、已中止的代，以及拆除关闭活跃 follower）。

`packages/evolution/command-evolution/tests/journey.spec.ts` 以固定时钟钉住纯模型，包括按文档族的分离、单个时间戳的情形、含仅裁决日的裁决计数，以及渲染出的类别。`packages/evolution/command-evolution/tests/command-evolution.spec.ts` 经由真实注册表钉住新命令：轨迹文法矩阵、带计数与单复数的会话与作用域导出、未挂载导出器、作用域之外的拒绝、两条失败路径、`/learn` 的用法、被排队的消息及其提示词内容，以及 `/suggestions` 的用法、未挂载注册表、跨两种表面的 blueprint 过滤、畸形形状、诚实空状态与无 cwd 的查询。

两个源码树在各自的包运行中都保持每文件 100% 覆盖，README 对由 `verify-translation-pairing` 记录。

## Consequences

Web 客户端现在可以从一个命名空间读取并编辑作用域、裁决其暂存写入并渲染其 journey，CLI 也获得了导出、学习与建议动词——全程没有新增会话事件、新增域或新增持久状态。读模型在两个消费者之间保持单一定义。

代价是明确的。控制器的 `profile` 是部署配置，因此客户端如果给错 Workspace id，得到的是 `workspace/not-found` 而不是作用域不匹配。`/learn` 依赖组合出的 agent 的工具：没有 `skill_manage` 时该回合无法保存任何内容，提示词会如实说明而不是隐藏。`/suggestions` 从发现层发布的任一表面读取 blueprint——这种兼容的代价是畸形形状被静默地不予建议而非被报告，且每列出一个技能就要加载一次文件，因为目录的摘要类型不携带 frontmatter。

此前笔记中的两处延期已关闭：`2026-09-12-command-evolution-governance.md` 把它们记为未决缺口，而存储的裁决台账与按文档族时间戳此后已将其关闭，其 `/journey` 段落描述的仍是仅 `updatedAt` 记录的拆分前说明。

## Alternatives considered

**从 `command/run` 事件推导批准计数。** 会话查询面返回的事件记录不含载荷，因此一次计数要为每个命令事件读一次事件窗口——为一个存储可以免费保留的数字付出 N+1 读取。裁决台账胜出。

**在控制器中重述时间线。** 对同一条记录的两套读模型会在某个桶第一次变化时漂移。控制器导入 `scopeTimeline`，即便这意味着一个宿主服务包对命令包产生 peer 依赖。

**把线上键命名为 `workspaceId`。** 冻结的跨切片接口命名为 `timeline({ scopeId, range })`；为同一个身份在同一个命名空间里造出第二种拼写，会为一个命名偏好留下永久的不一致。

**要求技能包只提供一种 blueprint 表面。** 等待 `SkillSummary.blueprint` 字段会让 `/suggestions` 无法在本波次实现，而两种读法的代码都只有四行。

**让 `/learn` 自己写技能。** 命令写技能文件会绕过 `skill_manage` 拥有的提案门控，而这正是该门控存在的保证；排队一个提示词把人类的批准留在路径上。

## Related

取代 [Evolution governance commands](2026-09-12-command-evolution-governance.zh.md) 中记录的两处延期读模型主张与 `/suggestions` 延期。

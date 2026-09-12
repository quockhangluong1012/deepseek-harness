# Agent Note: ShareGPT 轨迹导出

Status: implemented

[English](2026-09-12-evolution-trajectory-export.md) | 中文

## Problem

外循环没有出口。`specs/improvement.spec.md` 第 5 阶段要求一个用于评测与强化学习训练的轨迹导出器，而当时唯一的导出是 `session-log-export`：经由 `GET /api/session.export` 的浏览器 ZIP 下载，宿主端写的是规范 JSONL，既没有 ShareGPT 整形，也没有宿主路径写入器。训练流水线需要一个可读的路径，也需要对话，而不是一份会话日志。

## Decision

`@deepseek-ai/dsh-evolution-trajectory` 新增 `ctx.evolutionTrajectory`：一个挂在 `evolutionTrajectory` 命名空间上的 Typert Remote 服务，提供两个动词与一个纯函数：

- `exportSession(sessionId, { out? })` 写一个文件，并报告 `{ path, conversations, bytes }`。
- `exportScope(scopeId, { out? })` 为该作用域 Workspace 的每个未归档 Session 各写一个文件，并报告该目录与汇总的对话数与字节数。
- `toShareGpt({ sessionId, events })` 是两个动词共同调用的纯整形函数，并从包根导出，便于进程内使用方整形自己已有的事件。

事件来自会话持久化的读取句柄；Session 仍在运行时先冲刷，因此导出能看到到达模型的那些回合。这里刻意不复用 `serializeSessionLog` 及其 JSONL 解析：导出产物是 ShareGPT JSON，不是规范会话日志，两个写入器没有共享的产物。ShareGPT 写入器整形的是已提交的原始事件，而不是 `sessionQuery.filterEvents` 的搜索文档，因为搜索文档只带文本与事件类型——采纳所依据的角色与消息来源已被投影丢弃。

### 一次导出包含什么

每个文件是一个对话 JSON 数组，每个产出可采纳消息的回合一个对话，标识为 `<sessionId>#<turn>`。`system/message` 成为 `system`，人类的 `user/message` 成为 `human`，`assistant/message` 成为 `gpt`，`tool/result` 成为 `tool`。助手消息保留其文本，并把每次工具调用渲染为 `<tool_call>` 标签，内含调用名与模型原始参数 JSON，因此模型发出的不可解析参数也原样保留。推理块、图片与文件不贡献任何内容。

采纳沿用审阅者的规则，而不是另立一套策略：只有 `source.kind` 为 `user` 的 `user/message` 通过，因此注入的上下文——文件变更通知、子目录 AGENTS.md、技能内容、目标续跑——永不成为训练数据，空渲染不贡献消息。

### 目的地

`options.out` 对 Session 导出是文件路径，对作用域导出是目录。未给定时使用配置的 `outDir`；再未配置时，在导出时读取 `$DSH_HOME`，文件落在 `$DSH_HOME/evolution-trajectories`。任何内容都不会写入项目目录内，且 Session 标识在参与构造路径之前先被压成一个路径安全的文件名，因为标识来自调用方。

## Consequences

已结束的 Session 或整个 Workspace 作用域现在可以按路径变成训练数据，注入上下文已被排除，且不消耗任何模型回合。读不了或未知的 Session 不会被猜测：未知 Session 以 `session/not-found` 拒绝，未知作用域以 `workspace/not-found` 拒绝，其余任何存储失败原样向上传播。批量导出必须失败软化——名册中指向没有存储日志的 Session 会跳过并警告——而没有可采纳消息的 Session 导出空数组而不是抛错，因此调用方能区分"这里没有可学的"与"这次失败了"。

代价是刻意的。只有文本：附件与推理永不进入对话。每回合一个对话：想要一个长对话的使用方必须自行拼接文件，且系统提示会在每个对话中重复。profile 级作用域不可导出，因为它没有可迭代的 Session 名册。

本包不提供 CLI 动词；`@deepseek-ai/dsh-command-evolution` 在后续变更中拥有 `/trajectory`，同时负责把本插件挂入 web-app 组合的那一行。

## Verification

`packages/evolution/evolution-trajectory/tests/sharegpt.spec.ts` 用脚本化的会话日志形状固定整形行为：按回合切分对话与角色映射、注入上下文与空渲染的排除、以原始参数标记工具调用、失败的工具结果，以及没有回合或没有可采纳消息的日志给出诚实的空结果。

`packages/evolution/evolution-trajectory/tests/trajectory.spec.ts` 通过真实 Cordis 上下文加上脚本化的持久化后端与 Workspace 名册固定服务行为：发布的命名空间及其两个 Remote 动词、`resolveConfig`、写盘后读回的文件与其报告的字节数、`$DSH_HOME` 默认目录与配置的 `outDir`、路径安全的文件命名、`session/not-found` 与 `workspace/not-found`、空导出、把最后一个回合带进文件的运行时冲刷、每个未归档 Session 一个文件与汇总数值、跳过缺失日志、空作用域、没有 profile 分隔符的作用域键，以及保持大声的非缺席存储失败。

本包自身的测试运行报告 21 个通过的测试，`src` 每个文件的语句、分支、函数与行覆盖率均为 100%。针对本包的作用域 `oxlint` 运行没有发现任何问题，针对 `src` 与 `tests` 的作用域 `tsc --noEmit` 类型检查同样没有。

## Alternatives considered

**在 `session-log-export` 中加一个 ShareGPT 模式。** 两个写入器只共享一个服务依赖（`sessionPersistence`），别无其他：一个经由连接接缝把 ZIP 流给浏览器并序列化规范 JSONL，另一个为调用方把 ShareGPT JSON 写到宿主路径。把两者放进同一个包，会让 ZIP/fflate 闭包在 evolution 家族里获得永久位置，也会让一个包背负两份互不相关的输出契约。轨迹导出器因此是它的兄弟包。

**依赖 `session-log-export` 的 `flushLiveSessionLog`。** 读取前冲刷这条规则是真实的，但它就是针对 `ctx.get('sessions')` 的两条语句；引入它会把这个归档包（以及 `fflate`）带进每个只想要轨迹文件的部署。规则就在用到它的地方写明。

**从 `sessionQuery.filterEvents` 整形。** 搜索接缝是为检索而建，其文档只带 `{ sessionId, seq, type, time, surface, text }`。角色与用户消息来源恰恰是采纳所需的、也正是该投影丢弃的信息，因此从它整形要么会把注入上下文当成人类发言，要么就得在接缝之下重新读取日志。

**整个 Session 一个对话。** 冻结的 `toShareGpt` 为单个 Session 的事件返回对话，而一个 Session 是若干回合的序列。单个对话会永远报告 `conversations: 1`，必须凭空发明模型回合之间的边界，并把使用方的拼接策略烙进导出产物。

**把 `toShareGpt` 标为 Remote 端点。** 它的签名接收原始 `SessionEvent[]`，即产品内所有事件载荷的可合并扩展联合。`session-controller` 正是为了不把该联合放上线才把事件投影成 `SessionWireEvent`，而且没有任何计划中的调用方需要远程整形：CLI 与评分器都在宿主进程内运行。该方法因此保持为服务上的公开方法，且不加装饰器。

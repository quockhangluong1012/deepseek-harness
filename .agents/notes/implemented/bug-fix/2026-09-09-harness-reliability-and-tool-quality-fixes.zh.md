# Agent Note: Harness 可靠性与工具调用质量修复

Status: implemented

[English](2026-09-09-harness-reliability-and-tool-quality-fixes.md) | 中文

## Problem

调度器在记录 `tool/call` 事件后失败时，agent 循环可能留下提供方非法的 transcript；跨会话恢复复用 assistant attempt id；`turn/end` 边界提交也失败时会掩盖最初的 turn 失败。`maxTokens` 没有像 `reasoningEffort` 那样对称恢复，导致请求头 churn；缓存计数不一致时 DeepSeek 用量可能吐出负的 disjoint 输入数；携带上下文溢出措辞的 429 会重试而不是恢复。模型可见工具有小的正确性缺口：`terminal send` 丢了中止码，`bash` 提权从 undefined 策略读 `.mode`，后台 `bash` 有 check-then-start 竞态，web 抓取向模型泄露传输内部信息并在代理路径接受环回类主机名，`todo_write` 接受无界列表，goal 整数字段用了 `number`，压缩与标题采样不确定。subagent 失败文本无界。

## Decision

`dsh-agent-loop` 从持久化的 `assistant/message` 与 `assistant/attempt` 事件播种 attempt 计数器，使 `${sessionId}:${attempt}` 跨生命周期唯一，并在重抛调度器失败前为每个已开始却无结果的调用记录合成的 `TOOL_OUTCOME_UNKNOWN` 结果。`buildRequest` 像恢复 `reasoningEffort` 那样为精确路由恢复持久化的 `maxTokens`。DeepSeek `mapUsage` 把不一致的缓存计数钳制到上报的 prompt 总量；`httpErrorCode` 把上下文溢出措辞排在通用 `RATE_LIMIT` 之前路由，使溢出走压缩而非重试。`terminal send` 以 `HarnessError` 抛出 `TOOL_ABORTED`，`bash` 提权在未定义常驻策略时大声失败，后台 `bash` 在注册期间落下中止时杀掉刚注册的任务，web 抓取返回通用模型可见失败并把原因留给日志，同时拒绝 `localhost` 与元数据主机名，`todo_write` 把列表限制为 100 项、每条内容 2000 字符，goal 的 `revision` 与 `max_goal_rounds` 改用 `integer`，压缩与标题设置 `temperature: 0`，subagent 失败中的部分输出按 8000 字符设界并附截断提示。

## Alternatives considered

**把调度器孤儿留给崩溃恢复修复。** 已拒绝，因为实时 turn 错误路径会在没有 `tool/result` 的情况下闭合 turn，留下提供方非法的 transcript 给下一步，而并不需要崩溃。

**对 step 结束时尚有未完成调用将会话不变式判失败。** 已拒绝，因为日志约定允许 step 结束时有未结算调用，修复逻辑会合成 `TOOL_NOT_STARTED` 与 `TOOL_OUTCOME_UNKNOWN` 闭包；实时调度器修复减少孤儿而不改变持久约定。

**在 Windows ACL 上阻止工作区位于临时目录之下。** 已拒绝，因为工作区之上的临时父目录只会产生同级临时子目录，不是能力继承；现有单向检查加包装后的解析错误才是正确的边界。

**对设置脱敏中联合体持有的密钥闭合失败。** 暂时拒绝，因为当前 schema 经由 walker 在测试中已覆盖的建模容器触达密钥；一刀切抛出会破坏脱敏，需要先逐 schema 审计。

## Consequences

恢复的会话保持 attempt id 唯一，调度器失败保留提供方合法的 transcript，请求头 churn 减少，用量遥测在缓存计数不一致时存活，溢出触发恢复而非无用重试，中止与提权错误保持机器可路由，后台中止不留孤儿任务，web 失败隐藏传输内部信息并阻止知名私有主机名，todo 与 goal 输入有界且类型正确，压缩与标题输出确定，大型子级失败不再撑爆父级上下文。

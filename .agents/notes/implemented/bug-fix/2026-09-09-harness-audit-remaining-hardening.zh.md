# Agent Note: Harness 审计剩余加固

Status: implemented

[English](2026-09-09-harness-audit-remaining-hardening.md) | 中文

## Problem

`specs/spec.md` 中的四个审计缺口仍未关闭。从不溢出上下文的工具调用循环可以无界运行：`agent-loop` 有逐请求的 `maxTokens`，但没有单轮步骤或 token 上限（#34）。提示词变量拼写错误会在首轮组装时崩溃，且没有字面量 `{{…}}` 的转义语法（#36）。每个指令文件受 `maxSourceBytes` 限制，但基线读取总量无界，超限来源被静默忽略（#37）。除此之外，Agent Note 中陈述的仓库路径、包与脚本没有任何检查验证；`verify-md-links` 没有增量模式；工具目录对运行时动态创建的 `mcp__*` 与 `structured_output` 工具只字未提；live 调度器的 unknown-outcome 关闭、跨恢复的 attempt-id 唯一性、完整循环的审批审计对虽已执行但从未断言。

## Decision

`maxSteps` 是经过校验的 `agent-loop` Config 字段（默认值 100，超过有记录的最长产品轮次 7 步的 10 倍），与 `maxParallelToolCalls` 一样经 settings 实时读取。将超出上限的轮次以新的 `max-steps` `TurnEndReason` 结束而不是继续运行，即使某次 steer 排入了更多工作；恰好在上限处完成的轮次仍正常结束，首次触顶决定轮次结果，与 `max-tokens` 一致。消费方对称处理两类上限：ACP 把 `max-steps` 映射为 `max_turn_requests`，session-query 渲染该 kind，goal 驱动解除武装，consumed-work 经合并扩展的默认分支覆盖。

提示词模板新增 `\{{` 转义表示字面量花括号。静态段与上下文文本中格式错误的 `{{…}}` 组在注册时抛出（缺陷自包含）；未知变量名仍在组装时抛出，因为 section 与 variable 注册顺序由贡献方决定，组装是已注册集合完整已知的最早时机。

`maxTotalSourceBytes`（默认值为 8 倍单文件上限）约束一次基线加载或刷新批次。跳过的来源会被报告而非静默：加载返回 drops，插件记录 `workspace instruction source skipped (over-source-cap|over-total-budget)` 日志；即使一个文件都没保留，加载也会带着 drops 与空渲染返回。

`verify-agent-note-refs` 断言每条 `implemented/` 笔记在反引号中陈述的路径、包导出与冒号命名空间脚本；有意的历史引用记入 `scripts/agent-note-refs.allowlist.json`（过期条目失败）。`verify-md-links --since <ref>` 经 `change-scope` 只检查该 ref 之后变更的 Markdown 来源，锚点仍对全库解析。工具目录的作用域说明运行时动态创建的工具并链接其所属 README。

回填测试锁定 live 调度器的 unknown-outcome 关闭（每个已开始调用由其自身的 `tool/call` seq 引用）、跨重载恢复的 attempt-id 唯一性，以及 read-only + ask 下完整循环的审批 asked/decided 对。会话 v2 fixture 保持不动；只有当前代 v3 输出与 owner-local 期望文件携带新的基线标识。SDK 无需改动：turn-end 原因以字符串形式透传。

## Alternatives considered

**只监控失控循环而不设上限。** 拒绝：压缩约束的是上下文而不是工作量；没有上限，合规循环对病态轮次就没有终止事件。

**用双倍花括号转义（`{{{{`）。** 拒绝：提示词文本已在 shell 与模板示例中使用花括号，反斜杠转义在局部更易读；扫描器把偶数个反斜杠视为插值，Windows 路径不受影响。

**在 section 注册时检查未知变量。** 拒绝：贡献方可能在同一激活中先注册 section 后注册 variable，该检查会对合法顺序误报。组装是最早可判定点。

**允许 steer 工作的软上限。** 拒绝：会被任何 steer 绕过的上限只是建议；上限截断轮次，被排入的消息在新轮次中排出。

**重写保留的会话 v2 fixture 以更新标识。** 拒绝：按相邻迁移规则，重放选择最高代，只有 v3 输出移动；v2 代保持字节一致。

## Consequences

失控工具循环以持久的 `max-steps` 原因明确终止；提示词拼写错误在插件加载时带着段归因失败，字面量花括号仍可书写；指令读取有界且跳过有日志；包重命名、脚本移动与文件搬迁会触发笔记完整性门禁而不是在文档中腐烂；单文件文档改动几秒内检查完毕；动态工具可从目录发现；调度器失败 transcript、恢复后的 attempt id 与审批审计均有测试锁定。

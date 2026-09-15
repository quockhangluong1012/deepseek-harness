# Agent Note: Evolution Memory 前缀缓存修复与缓存命中告警

Status: implemented

[English](2026-09-13-evolution-memory-prefix-cache-and-alert.md) | 中文

## 问题

一次针对 `specs/evolutionary-harness-prompt-v6.md` 的评审（记录在 `docs/superpowers/specs/2026-09-13-evolutionary-harness-review-v6.md`）发现，`dsh-evolution-memory-context` 会把实时 `{{evolution_memory_usage}}` 值插值进 `evolution-memory-scope` 系统提示词 section——该决策记录在[注入器的原始 Agent Note](../feature/2026-09-11-evolution-memory-context.zh.md)中。由于整个系统提示词是一个 surface node，只要其渲染文本变化，`SystemPromptProjection`（`packages/core/agent-loop/src/runtime-context.ts`）就会就地替换它，因此任何改动用量数字的 evolution-memory 写入，都会让同一请求中每个工具 schema 以及其余每个静态 section 的提供方缓存前缀失效——而不只是与 memory 相邻的那段文本。另外，用量账本早已算出 `cacheHitAvg` 汇总值（`packages/session/usage-ledger/src/aggregate.ts`），却没有任何东西盯着它，所以像这样的缓存命中率回退无从在运维层面自我暴露。

## 决策

`evolution-memory-scope` 的文本现在是固定文案，不再插值任何值：`sections.ts` 删掉了 `{{evolution_memory_usage}}` 引用，`index.ts` 也不再注册 `USAGE_VARIABLE` 提示词变量以及为它提供数据的 `usageForSession` 辅助函数。容量用量仍对模型可见，且仅通过 brief 自身的头部（`render.ts` 中的 `Memory usage: used/cap (pct%)`）——该头部本来就随 memory 内容变化，也本来就通过注入器自身的 digest 门禁自行替换，因此没有丢失任何能力，只是少了一份同一数字的重复且对缓存不友好的副本。

`dsh-usage-ledger` 新增一个 opt-in 的 `cacheHitAlertThreshold`（默认未设置）以及一个 `cacheHitAlertMinRequests` 下限（默认 `20`）。配置之后，当今日滚动缓存命中率从健康跨入不健康时，`UsageLedger` 会发出一个临时的 `usage/cache-hit-low` 事件；该命中率由 dashboard 本就在提供的同一个 `cacheHitAvg` 算出。该检查在每次样本落入之后内联运行于 `foldAttempt` 中，并追踪一个 `{day, healthy}` 对以保持边沿触发（每次跨越触发一次，已处于不健康状态时不会每个请求都触发，恢复之后可以再次触发），未设置阈值时则是 no-op。

## 考虑过的替代方案

- **在 `packages/llm/token-meter` 中新增一个 `cacheReadTokens`/`inputTokens` 比率。** 落选：`dsh-usage-ledger` 已经在计算并以 `cacheHitAvg` 暴露这个比率；在第二个包里再算一次会让同一个数字有两个事实来源。
- **为系统提示词做一个 `PromptBuilder` 式的缓存字符串类**，对应参考提示词的伪代码。落选：`SystemPromptProjection` 在 surface 层已经取得同样效果（未变化就跳过，序列真正断裂时就地替换），无需再引入第二个字符串级缓存，而它可能与会话日志漂移。
- **保留用量变量，只把它挪到更低的系统提示词顺序**以减少其变化频率。落选：该变量仍然位于那唯一的系统提示词 surface node 内，因此只要它变化，无论它落在这个 node 文本的哪个位置，仍然会使同一个 node 失效。
- **改由外部监控轮询 `cacheHitAvg`，而不是在账本内发事件。** 落选：账本本就内联折叠每个样本；在那里加这个检查每次折叠只多一次比较，而轮询器则要自带调度，还会滞后于真实的跨越时刻。

## 后果

现在无论 memory 记录如何变化，系统提示词在各轮次之间都逐字节一致，从而在每次 evolution-memory 写入时恢复提供方对工具 schema 与静态 section 的缓存前缀复用；用量数字仍由 brief 承载，那里本来就已经付出了变化的代价。想要该告警的部署需显式开启；未设置时，账本的行为与形态保持不变。`evolution-memory-context` 包最初的 Agent Note（[2026-09-11](../feature/2026-09-11-evolution-memory-context.zh.md)）仍把 camelCase 与全小写的变量命名偏差以及容量变量提示描述为已交付；这两者现在都已是历史而非现状——就那套机制而言，请以本 note 为最新事实。

## 测试

`evolution-memory-context`：`sections.spec.ts` 断言 `MEMORY_SCOPE_SECTION.text` 不包含任何 `{{...}}` 组，并新增一个 spec 让真实的 `EvolutionMemoryStore` 经历一次 memory 写入，断言组装出的系统提示词在写入前后逐字节一致（对于不在任何 scope 内的会话也是如此）；`composition.spec.ts` 的真实循环 spec 断言系统提示词从不包含 `usage`。`usage-ledger`：`ledger.spec.ts` 中三个新 spec 钉住边沿触发（每次跨越触发一次、已在不健康状态时静默、恢复之后再次触发）、`cacheHitAlertMinRequests` 下限会扣下过早的低样本告警，以及未配置时告警绝不触发。所有被触及的包及其下游包（`evolution-memory-context`、`usage-ledger`、`evolution-controller`、`command-evolution`、`evolution-reviewer`）完整测试套件通过；`pnpm run build:lib:host` 与 `pnpm run typecheck:contracts-ready` 干净。

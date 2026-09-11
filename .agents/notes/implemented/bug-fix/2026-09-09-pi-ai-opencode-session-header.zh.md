# Agent Note: pi-ai 适配器向 OpenCode 网关发送按会话的 x-opencode-session

Status: implemented

[English](2026-09-09-pi-ai-opencode-session-header.md) | 中文

## Problem

OpenCode Go 网关要求每个推理请求携带 `x-opencode-session`，缺失时返回 `400 MissingSessionID`。pi-ai 适配器仅把 `GenerateOptions.sessionId` 透传给 pi-ai 的 `streamSimple()` 选项，而其会话亲和 headers（`session_id`、`x-client-request-id`、`x-session-affinity`）从不包含 `x-opencode-session`；启用这些 headers 的 compat 开关被目录漂移门禁挡在 profile 之外。经由该网关的每个模型因此失败，包括调用量最高的路由。静态 `headers` 条目无法修复：所有会话共用一个固定值会坍缩网关的按会话路由亲和，损害前缀缓存局部性。

## Decision

`PiAiAdapter` 在发往该网关的每个请求上按原文附带 loop 传入的会话 id 作为 `x-opencode-session`，发往别处时不发送。路由键以 `opencode` 开头，或解析后的模型端点托管于 `opencode.ai`（顶级域或子域）时，即视为目标网关；任一事实单独成立即可选中，因此改名后仍指向网关的路由，以及指向代理的网关命名路由，都能保留该 header。按会话的值赢过同名的静态 profile 条目（大小写不敏感），因为固定值无法完成按会话 id 的工作；Harness 归因名称保持现有优先级。无会话 id 的请求不发送会话 header，discovery 探测不受影响。

该做法沿用既定的[强制归因](../architecture/2026-06-21-mandatory-app-attribution-headers.zh.md)模式——Harness 拥有的名称赢过部署侧 headers——以及 [DeepSeek 请求身份](../feature/2026-08-11-deepseek-request-user-id-header.zh.md)先例：把会话 id 作为提供方可识别的传输元数据发送。[路由化适配器](../architecture/2026-07-14-provider-routed-llm-adapters.zh.md)中关于 header 合并的句子现已在归因之外列出网关会话 header。

## Alternatives considered

**`sessionHeader` profile 字段（按路由显式加入）。** 作为默认修复被否决：只有每个受影响的部署都修改设置后才生效，从未读过请求帖的部署将继续中断。适配器不识别的网关仍可使用显式按路由 headers。

**固定值的静态 `headers` 条目。** 被否决：跨会话共用一个 id 把所有会话指向同一亲和桶，损害缓存局部性，运维侧已观察到费用升高。

**无会话 id 时按请求铸造新的 UUID。** 被否决：按请求的 id 能通过 header 存在性检查，但不携带网关真正需要的会话亲和这一路由事实。无会话的调用保持现有行为。

**从 `session-<uuid>` 会话 id 中提取裸 UUID。** 被否决：网关按原文接受会话 id，该转换引入未经证实的格式依赖。

## Consequences

- 网关请求在多轮、恢复、压缩与重试中携带同一会话的稳定 id；新会话、分叉与子 agent 会话呈现新的 id。
- 网关之外的提供方收不到新 header；会话 id 不会泄露给未要求的端点。
- 同名静态 profile 条目在网关路由上不再生效；仍保留该条目的部署可以删除它。
- 网关识别保留为适配器内的路由键前缀加端点主机检查。网关迁移主机或更名合约需要改适配器；而 profile 字段方案需要改设置。

## Testing

- 线路 specs 锁定：`opencode` 前缀路由上的 header 原文值、无会话 id 时缺席、其他提供方不受影响、运行时值赢过静态条目。
- 路由匹配表锁定：前缀、顶级域、子域、大小写不敏感、非匹配与不可解析端点等情形。
- 完整 `dsh-llm-pi-ai` 套件全绿，受影响源文件逐文件 100% 覆盖；包 typecheck 与 oxlint 干净。

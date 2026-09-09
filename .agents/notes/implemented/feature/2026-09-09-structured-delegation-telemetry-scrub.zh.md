# Agent Note: 结构化委派与可选遥测脱敏

Status: implemented

[English](2026-09-09-structured-delegation-telemetry-scrub.md) | 中文

## Problem

`tool-subagent` 从未暴露 seam 的 `outputSchema`：进程内 driver 早就支持带两阶段提交的 `structured_output` 捕获，但模型只能要自由文本再自己解析 JSON。遥测提供了 `session-telemetry/record` waterfall，却没有可复用的规则起点，于是每个部署都从 e2e fixture 手写密钥擦除。

## Decision

委派工具在前台一次性运行上接受可选的对象根 `output_schema`（`json`），以 `assertObjectJsonSchema` 断言，经 `outputSchema` 转发以便提供方能力门禁拥有拒绝权，并把验证过的值作为可选 `structured` 字段渲染在文本之后返回。后台与可继续运行大声拒绝 `output_schema`，因为它们没有承载它的前台结果。遥测新增可选的 `sensitive.ts` 辅助函数（`scrubSensitiveValue`、`scrubSensitiveRecord`、`DEFAULT_SENSITIVE_PATTERNS`，覆盖类 API token、bearer 凭据、AWS 密钥、PEM 块），默认永不生效；没有挂载规则的透传保持显式并记入文档。

## Alternatives considered

**按 session id 共享任务限额，或对未结算调用判不变式失败。** 已拒绝，因为现有测试钉死了两个约定：限额按精确 owner 对象计算，替换者得到新桶，step 结束允许未结算调用以便修复闭包。

**在工具调用输出上让压缩大声失败。** 已拒绝，因为摘要器约定把工具调用留在 `rawOutput` 中只投影文本；现有测试钉住静默投影。

**发布默认遥测规则。** 已拒绝，因为改变透传默认是破坏性变更；可选辅助函数加文档在保留显式约定的同时给部署一个窄幅起点。

## Consequences

模型无需文本解析即可请求机器可校验的子级结果，提供方能力拒绝保持大声，后台误用在工具边界被拒绝。部署得到经过测试的擦除起点，而无规则默认不变；工具目录携带新的 `output_schema` 与 `structured` 字段。

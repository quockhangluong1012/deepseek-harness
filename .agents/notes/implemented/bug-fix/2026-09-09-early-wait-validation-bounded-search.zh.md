# Agent Note: 提前等待校验与有界 Web 搜索

Status: implemented

[English](2026-09-09-early-wait-validation-bounded-search.md) | 中文

## Problem

`job_output` 先用 `Math.min` 钳制 `timeout_ms` 再校验，于是负数或非整数值滑入注册表通用的等待错误，而不是清晰的工具级消息；schema 接受 `number`，而仓库里其他毫秒预算全是 `integer`。`web_search` 限制了来源数量，却保留了无界的单来源 snippet 与提供方答案，一个话痨提供方就能撑爆父级上下文。`terminal_send` 从未告诉模型每个会话同时只能有一个发送在途。

## Decision

schema 中 `timeout_ms` 改为 `integer`，并提前校验为正安全整数、回显违规值；钳制到配置上限的逻辑保留在后。搜索按来源限制 snippet 字符（`searchSnippetMaxChars`，默认 500），按结果限制提供方答案字符（`searchContentMaxChars`，默认 4000），作为校验过的插件配置，同时作用于规范结果与可回放元数据。`terminal_send` 文档化其后端约束的等待与单活跃发送规则。

## Alternatives considered

**在 skill 目录中渲染 `whenToUse`。** 已拒绝，因为目录测试只钉住名称加描述行；字面名为"Never render this routing hint"的 fixture skill 证明省略就是设计约定。

**重命名 workflow 与 `ralph` 结果卡片。** 已拒绝，因为两个 presenter 测试都钉住空通用卡片；外观收益不值得约定 churn。

**发布默认遥测规则。** 已拒绝，因为改变透传默认是破坏性变更；上一批的可选辅助函数保留了显式约定。

## Consequences

非法等待在工具边界快速失败并回显取值，搜索上下文按部署配置保持有界（含目录与配置目录条目），终端发送约定与后端现实一致。

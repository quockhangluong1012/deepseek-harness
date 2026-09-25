---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-25-goal-token-budget

[English](2026-10-25-goal-token-budget.md) | 中文

## 概述

为 goal/change 事件新增可选的单目标 token 预算（maxGoalTokens）及其累计计数器（tokensUsed）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-goal-token-budget
baseline: false
changes:
  - root: "event:goal/change"
    previous: "2026-09-11-initial"
    after: "592ed1c602a431ef09b3da454efabb8b70db10e783013248dd37dc4baaa64fbd"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个字段在读取时都是可选的；本次改动之前提交的事件两者皆无，goal 领域的解码器会将缺失的 tokensUsed 默认为零，并让 maxGoalTokens 保持未设置。此后每次写入都会填充 tokensUsed；只有调用方明确请求预算时才会填充 maxGoalTokens。goal projection 的 stateVersion 从 6 提升到 7，使得本次改动之前持久化的 projection 缓存会从 session 日志重新计算，而不是在实时 projection 的 wire schema 上因新增的必填 tokensUsed 字段而失败。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/goal/goal/tests packages/goal/goal-round-driver/tests packages/goal/tool-goal/tests packages/goal/command-goal/tests：147 个测试通过，其中包含一个专门的回归测试，解码完全没有 tokensUsed 字段的 goal/change 事件。

<a id="dev-note"></a>
## 开发备注

无。

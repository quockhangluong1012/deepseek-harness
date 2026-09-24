---
description: "guard 家族的包映射：建议性重复工具提醒、单次工具调用超时策略，以及按轮次的预算上限，供选择或组合这些 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生与预算 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组让 agent loop（智能体循环）既高效又受约束。`repeat-tool-reminder` 会在模型重复完全相同的工具调用时提醒它改变方法或结束任务。`timeout-policy` 为声明了限时的工具调用设置超时，让挂起的调用返回清晰错误而不是拖住整个会话。`budgets` 在到达所配置的上限时让失控的轮次以 blocked 结束。`prompt-injection` 记录不可信内容试图做什么，并可替换模型可见结果中的凭据。前两者随 `dsh` 基础组合包提供，`budgets` 随 web-app 组合包，`prompt-injection` 不随任何组合包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

四个小插件分别覆盖循环卫生与长周期上限；下文每个 README 都说明何时保留、调优或移除它。

| 包 | 提供什么 |
|---|---|
| [`budgets/`](budgets/README.zh.md) | 以可选的 token 压力、工具调用与挂钟时长上限约束单个轮次，任一项到达即让其以 blocked 结束 |
| [`prompt-injection/`](prompt-injection/README.zh.md) | 记录不可信的工具、仓库、web 或 MCP 内容试图做什么，并在配置为强制执行时替换模型可见结果中的凭据 |
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线，再看重复提醒的配置与策略背后的超时库决策。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——两个 guard 都依赖的工具调用流水线与决策。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

---
description: "mentor 包组：持久的学习者记录、由目录驱动的误解引擎，以及 §20 导师质量控制循环，供选择或浏览该家族的读者使用。"
kind: "package-group"
---

# mentor/ — 学习者记录、误解引擎与导师质量循环

[English](README.md) | 中文

## Summary

mentor 包组把一次导师会话变成围绕同一个学习者的可度量教学循环。`learner-model` 保存该学习者表现出的东西——谈论概念时的表现，以及实际应用时的表现。`misconception` 把陈述的论点与部署方自己的模式目录比对，并驱动每次出现走完 explain、counterexample、exercise、new-case、reassess。`mentor-loop` 从会话、内核与上述记录推导 §20 阶段，再把当前阶段的指令注入导师 agent 的下一次请求。检出是目录匹配，从不调用模型。

## Table of Contents

- [包](#packages)
- [相关文档](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## 包

三个包构成一个循环：记录是学习者状态，引擎是目录与流水线，循环则是让导师的下一次请求与该状态保持一致的 §20 阶段状态机。

| 包 | 作用 | ctx key |
|---|---|---|
| [`learner-model`](learner-model/README.zh.md) | 每个学习者一份持久记录：概念知识、应用能力、误解、错误、信心、案例历史与目标 | `ctx.learnerModel` |
| [`misconception`](misconception/README.zh.md) | 把陈述的论点与部署方的模式目录比对，并在持久的学习者状态上驱动每次出现走完五个教学阶段 | `ctx.misconception` |
| [`mentor-loop`](mentor-loop/README.zh.md) | 从会话、内核与上述两份记录推导 §20 导师阶段，并把当前阶段的指令注入导师 agent 的下一次请求 | `ctx.mentorLoop` |

-----

<a id="related-documentation"></a>
## 相关文档

- [存储子系统](../../docs/subsystems/storage.zh.md)——学习者记录与每条误解流水线所经由的域形式。
- [Agent kernel 子系统](../../docs/subsystems/agent-kernel.zh.md)——发现所引用的断言与证据，出自导师会话所回应的任务约定。
- [DeepSeek Harness 2.0 evolution spec](../../specs/deepseek-harness-2.0-evolution-spec.md) §20、§21 与 §27——导师质量控制循环、为学习者记录提供输入的案例产物，以及辅导方面的成功标准。

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>

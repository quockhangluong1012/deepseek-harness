---
description: "git 包组：packages/git/ 下模型侧 git 工具，供选择或浏览该能力族的读者阅读。"
kind: "package-group"
---

# git/ —— 模型侧 git 操作

[English](README.md) | 中文

## 概述

git 组把仓库操作变成 agent 的一等工具：用模型自己撰写的提交信息提交当前变更集、创建或切换分支、通过 `gh` 发起 GitHub pull request，以及创建或移除 worktree。每个工具都以 argv 向量的形式经 subprocess 能力运行 git，因此同一份 schema 在 POSIX 与 Windows 组合下都可用，模型与 git 之间不存在 shell 引号规则。该组负责参数词汇、工作目录与渲染结果；subprocess 能力负责可执行文件解析、凭据清洗、输出上限与进程终止。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-git`](tool-git/README.zh.md) | 在 subprocess 能力之上注册 `git_commit`、`git_branch`、`git_pr` 与 `git_worktree` | 注册到 `ctx.tools` |

该组只承载一个产品包。组合需要一个 `ctx.subprocess` 提供者（`dsh-subprocess-local`）；缺少它时这些工具保持 pending。

-----

<a id="related-documentation"></a>
## 相关文档

- [Subprocess 子系统](../../docs/subsystems/subprocess.zh.md)——每条 git 命令所用的 spawn 规格、收集式读取器、凭据清洗与受管范围终止。
- [tool-bash](../shell/tool-bash/README.zh.md)——本能力族未暴露的 git 子命令所用的 shell 消费者。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-git)——模型实际接收的 schema。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-tool-git)——每个受支持配置字段。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

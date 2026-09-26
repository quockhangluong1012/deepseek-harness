---
description: "面向想为工作区补齐文档的用户的 /init 斜杠命令：把一次请求变成由 agent 撰写 AGENTS.md 的普通轮次。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-init

[English](README.md) | 中文

## 概述

`dsh-command-init` 为用户提供 `/init` 命令，让当前 agent 依据仓库的真实情况撰写本工作区的 `AGENTS.md`。该命令提交一条普通用户消息，点明需要覆盖的事实——项目是什么、如何构建、测试与 lint、哪些目录布局重要、哪些约定最容易出错——随后由 agent 用它的常规工具去阅读和写入。命令本身不写任何文件，因此工作区只会被随后的、可审查的那一轮修改。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在任何带有命令适配器、且用户希望对缺乏文档的仓库做一次引导式梳理的部署中挂载 `dsh-command-init`。随附的 base bundle 已包含它，因此基于 base 的 profile 无需额外配置即可使用 `/init`。

### 命令参考

`/init` 不接受参数。任何非空输入都会返回用法错误 `Usage: /init`。

| 输入 | 结果 |
|---|---|
| `/init` | 排入一条用户消息，要求 agent 创建或更新根目录的 `AGENTS.md` |
| `/init <任意内容>` | 返回 `Usage: /init`，且不排入任何消息 |

### 要求 agent 做什么

提交的消息要求 agent 覆盖项目用途、构建／测试／lint／运行命令、重要目录的布局，以及容易出错的约定；要求它阅读 manifest、CI 配置与既有文档，而不是猜测；要求它在仓库自有文档标准存在时遵循该标准；并要求它报告自己改动了什么。因此结果是一轮完全普通、可审查的轮次——工作区只会通过 agent 自己的工具调用发生变化。

### 最小配置

该命令没有配置字段。它只需要命令注册表：

```yaml
- {name: '@deepseek-ai/dsh-commands'}
- id: command-init
  name: '@deepseek-ai/dsh-command-init'
```

无头、ACP 自动化与 JSON-RPC 应用不注册命令适配器，因此无法使用 `/init`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计

- **是提示词，不是写文件者。** 命令只持有一份固定指令文本，不接触文件系统。此后工作区看到的一切都来自 agent 自己的工具及其常规审批路径，因此 `/init` 不会写出用户从未审查过的半个文件。
- **按调用者的 agent 生效。** 消息排入调用 agent 的 inbox，因此回答它的轮次属于用户当时所在的会话，沿用该会话的模型、cwd 与权限。
- **语法保持极简。** 只接受裸 `/init`，其他输入都是用法错误，这使命令的约定在不同适配器间保持稳定。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：固定提示词、参数语法与命令注册 |
| — | 不发布运行时不变式伴生入口；该命令不拥有事件流或投影，排入的用户消息就是普通会话历史。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作区指令加载器](../agent-instructions/README.zh.md)——把写出的 `AGENTS.md` 变成模型上下文的包，含 `@path` import 与按路径生效的 rule。
- [命令服务](../../interaction/commands/README.zh.md)——命令注册表约定与分发。
- [文档标准](../../../docs/AGENTS.md)——本仓库对 `AGENTS.md` 内容的期望。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/init` 请求

#### 模型看到的内容

一条携带固定指令文本的普通 user 角色消息。它像其他用户提示词一样进入调用 agent 的 inbox，并作为 `user/message` 事件配上普通的 `user` 来源写入日志，因此回放、压缩与渲染都与手动输入的请求完全一致。命令不贡献任何提示词区段、工具或 schema，适配器返回给用户的直接回复也绝不进入请求。

#### Token 影响

每次调用恰好一条用户消息：多句指令文本加上常规 user 消息框架。此后 agent 自己的探查与写入属于它常规的工具调用及其结果。

#### KV Cache 影响

仅追加。该消息位于既有的可复用请求前缀之后，不会使任何缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明 `/init` 做什么、不做什么。它们是当前包约束，不是任务积压。

- **自身不写文件**——命令不写任何内容，也不报告仓库情况；所有改动都来自它启动的那一轮 agent 工作，因此没有写权限的 agent 只会给出建议而不产生文件。
- **仅根 `AGENTS.md`**——提示词点名的是根文件；嵌套的逐目录指令文件仍由 agent 或用户自行决定。
- **不提供覆盖确认**——更新既有 `AGENTS.md` 交由 agent 常规的编辑审批路径处理，用户正是在那里审查 diff。
- **单轮、无后续循环**——命令只排入一条消息，既不检查 agent 是否写完了该文件，也不会再次追问。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

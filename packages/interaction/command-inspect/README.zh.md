---
description: "报告部署检查结果、命令目录，以及已挂载的 MCP、agent 与 hook 表面的人类检查命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-inspect

[English](README.md) | 中文

## 概述

`dsh-command-inspect` 为用户提供 5 条命令，回答「这个部署实际拥有什么？」：`/help` 列出该会话可运行的全部命令，`/doctor` 先运行 5 项彼此独立的部署检查，再报告已挂载的环境，`/mcp`、`/agents` 与 `/hooks` 列出已配置的能力表面。所有命令都只读服务并打印文本；它们不写状态、不启动轮次、不追加会话事件，并且各自容忍更小部署所省略的可选服务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在有命令适配器、且用户需要自查环境的任何部署中挂载 `dsh-command-inspect`。随附的 base bundle 已包含它，因此基于 base 的 profile 拥有全部 5 条命令。

### 命令参考

每条命令都不接受参数；任何输入都是用法错误。

| 命令 | 输出 |
|---|---|
| `/help` | 调用 agent 可达的每条命令一行 `- /<name> <hint> — <description>`，按名称排序；没有时返回 `No commands are registered.` |
| `/doctor` | 下列 5 项检查各一行；随后是环境事实（各提供方路由及其公布的模型数量、可调用工具数量、hook 桥接状态，以及文件系统与存储能力是否挂载）；最后是一行 `Machine-readable:`，以 JSON 承载同样的检查结果 |
| `/mcp` | 按桥接名称中的服务器段分组的 MCP 工具；没有时返回 `No MCP tools are registered.` |
| `/agents` | agent 组合及其插件行数量、已注册的 subagent 提供方，以及调用会话的子会话 |
| `/hooks` | 已挂载的 hook 桥接及其启用状态，或明确的空结果 |

每行检查的格式为 `<标题>: <状态> — <观测>`，`<状态>` 取值 `ok`、`degraded` 或 `unavailable`。

### 各项检查报告什么

| 检查 | `ok` | `degraded` | `unavailable` |
|---|---|---|---|
| Sandbox | 已解析的策略，且已挂载沙箱提供方；或模式为 `danger-full-access` | 模式要求限制，但没有挂载沙箱提供方，因此无人执行该策略 | 没有 `sandboxPolicy` 服务 |
| Provider keys | 提供方 profile 声明的每个凭据引用都已配置，或没有任何 profile 声明引用 | 已声明的引用未配置；报告为 `<路由> → <引用>` | 存在已声明的引用，但没有挂载 `credentials` 服务 |
| MCP | 每个已挂载的 client 行都公布了该服务器桥接的 `mcp__<服务器>__<工具>` 工具 | 已挂载的行没有公布任何桥接工具 | 某行的 fiber 失败；或没有 Loader 且没有桥接工具；或没有 client 行且没有工具 |
| LSP | 每个已挂载的 `dsh-lsp*` 行都是 active | lsp 服务已挂载，但没有语言服务器行 | 没有 `lsp` 服务、没有 Loader，或某行的 fiber 失败 |
| Disk | 工作区卷上的空闲字节数 | — | 没有工作区根目录，或该卷无法读取 |

具体观测始终会被点名：沙箱模式连同其工作区根目录与后端模块、提供方路由连同其凭据引用、服务器连同其 Loader 行 id，以及字节数连同读数所在的卷。

凭据的值永远不会出现。provider keys 检查先读取每个可配置提供方 settings profile 声明的 `apiKeyEnv` 引用，再向 `ctx.credentials.describe` 询问其是否存在，因此缺失的密钥只按引用名报告。进入报告的所有第三方消息都会先经过守卫的 `redactSecrets`。

各项检查彼此独立：某项探测抛错时，该检查会以 `unavailable` 连同其已脱敏的消息报告，其余检查照常报告。无可读取内容的检查会点明缺失的所指对象——服务、Loader、凭据接缝或工作区根目录。

### 最小配置

这些命令没有配置字段；它们需要命令注册表、工具注册表与模型注册表。各项检查还会使用组合所挂载的 `ctx.settings`、`ctx.credentials`、`ctx.sandboxPolicy`、`ctx.sandbox`、`ctx.lsp` 与 `ctx.loader`，其余一律报告为 `unavailable`。

```yaml
- {name: '@deepseek-ai/dsh-commands'}
- {name: '@deepseek-ai/dsh-tools'}
- {name: '@deepseek-ai/dsh-llm'}
- id: command-inspect
  name: '@deepseek-ai/dsh-command-inspect'
```

headless、ACP 自动化与 JSON-RPC 应用不注册命令适配器，因此无法触达这些命令。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计

- **只报告，不硬探测。** 所有可选服务都用 `ctx.get` 解析，每行报告都会明确说明其缺失，因此未挂载的沙箱或缺失的 Loader 只会让一行降级，而不会让命令失败。
- **一项检查，一个观测。** 每项检查只读取能回答它那个问题的服务，绝不从别处缺失推断某一事实；状态来自探测实际返回的内容。
- **工具以工具注册表为准。** `/doctor` 统计 `ctx.tools.schemas()` 返回的内容，`/mcp` 对同一批名称分组，因此两者都与启用会话中模型收到的目录一致。
- **挂载以 Loader 为准。** `/hooks`、沙箱后端、MCP client 行与 LSP 行都读取插件清单，因此已挂载但被禁用或失败的行会被如实报告，而不会被假定为生效。
- **在边界处脱敏。** 只有 doctor 报告会用第三方消息拼装文本，而它会让每条消息先经过 `redactSecrets`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 5 条命令、它们的用法语法与报告格式 |
| [`src/doctor.ts`](src/doctor.ts) | 5 项检查、其状态规则、`/mcp` 共用的 MCP 工具分组，以及报告渲染 |
| — | 不发布运行时不变式伴生文件；每条命令都是对其他包所拥有服务的只读投影，其输出由包测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [命令服务](../commands/README.zh.md)——`/help` 所报告的命令注册表。
- [工具运行时](../../core/tools/README.zh.md)——`/doctor` 与 `/mcp` 读取的注册表。
- [插件清单](../../host/plugin-inventory/README.zh.md)——各项检查与 `/hooks` 读取的 Loader 投影。
- [凭据](../../credentials/README.zh.md)——无需值即可回答存在性的引用接缝。
- [设置](../../settings/README.zh.md)——声明各提供方凭据引用的 profile 值。

-----

<a id="model-experience"></a>
## 模型体验

### 人类检查输出

#### 模型看到什么

什么都不看到。5 条命令都在 UI 命令平面作答：它们不贡献提示词段落、消息、工具或 schema，也不追加 `user/message` 或生命周期事件，因此该报告不会成为模型之后读到的对话内容。

#### Token 影响

为零。没有任何命令路径组装请求或向请求添加内容；这些命令只读取已经存在的注册表与设置。

#### KV Cache 影响

无。这些命令不改变任何请求前缀，也不自行发送请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了这些命令能说什么。它们是当前的包约束，不是任务清单。

- **只报告可观察事实**——不注册任何内容的能力（桥接自身配置中的 `/hooks` 规则、环境引用背后的凭据）不会被列出，因为命令报告的是运行中进程能看到的内容。
- **MCP 健康是推断的，绝不 ping**——该检查读取已挂载的 client 行与桥接工具；它从不调用服务器工具，因此正在重连的服务器会显示为「已挂载但没有工具的行」。
- **失败的行只点名，不带消息**——Loader 投影携带行的模块、启用状态与 fiber 阶段，而不携带失败激活所抛出的错误。
- **LSP 行描述插件，而非进程**——stdio 提供方在首次匹配查询时才启动其服务器，因此 active 的行并不意味着已有服务器进程在运行。
- **磁盘空间只报告，不判定**——该检查点明它读到的空闲字节数，不施加阈值，由运维者判断卷是否过满。
- **没有逐命令参数**——每条命令要么给出整份报告，要么给出明确的空状态；不支持按提供方、服务器或 agent 过滤，机器可读形式就是报告本身，而不是它选定的子集。
- **仅文本输出**——结果是纯文本行，其中嵌入一行 JSON 供机器消费；需要交互式面板（规划中的管理界面）的客户端会用自己的数据渲染，而不是这些字符串。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

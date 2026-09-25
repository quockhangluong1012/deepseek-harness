---
description: "尽力把 LSP 诊断附加到成功的 edit 与 write 工具结果，供组合本地提供方的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-post-edit-diagnostics

[English](README.md) | 中文

## 概述

使用 `dsh-lsp-post-edit-diagnostics` 在 `edit` 或 `write` 成功后，把改动文件的诊断追加到工具结果；不会额外启动模型轮次。它通过 `ctx.lsp` 查询会话工作区；结果为空或查询失败时，成功的文件操作结果保持不变。基于 base 的 profile 会挂载本插件并自动检测本地服务器。本包既不安装服务器二进制文件，也不隔离服务器进程。

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

基于 base 的 profile 会随 `ctx.tools` 与 `ctx.lsp` 一同挂载本插件。自定义组合必须提供这些服务及语言服务器提供方；`dsh-lsp-stdio` 可检测 PATH 中的常见命令，也可使用显式服务器条目。

### 文件变更后会发生什么

`edit` 或 `write` 成功后，插件读取 `file_path` 和调用方会话的 `header.cwd`，再通过 `ctx.lsp` 查询更新后文件的诊断。若结果非空，会格式化并作为文本块追加到工具结果中。工作区缺失、扩展名不受支持、提供方失败或调用取消时，成功的文件结果保持不变，也不会阻塞编辑。

### 最小组合

```yaml
- id: lsp-post-edit-diagnostics
  name: '@deepseek-ai/dsh-lsp-post-edit-diagnostics'
```

这行假设 `ctx.tools`、`ctx.fs`、`ctx.subprocess` 和 `ctx.lsp` 已由其他插件提供。基于 base 的 profile 还会挂载启用自动检测的 `dsh-lsp-stdio`；自定义组合必须挂载服务器提供方。本插件不安装服务器二进制文件，也不挂载 `lsp` 工具。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxResultChars` | `16000` | 诊断文本上限，包含截断元数据 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsp-post-edit-diagnostics)列出所有受支持字段。

### 失败与恢复

本插件采用尽力而为策略：忽略会话 cwd 缺失、文件扩展名没有注册的提供方、诊断为空、提供方失败或调用取消。成功的 edit/write 结果以及其他 post-execute 监听器附加的上下文都会保留。结果为空时不会添加诊断文本块。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件在工具派发后运行，因此提供方读取的是成功写入后的文件。本插件复用 `dsh-tool-lsp` 的诊断 formatter，并通过 `tools/post-execute` 的 result content 追加文本块。若后续监听器把结果改为结构化值，则通过附加上下文传递诊断，以保留该值。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、post-execute 监听器、尽力调用 `ctx.lsp` 查询 |
| — | 不发布运行时不变式伴生入口；本插件不拥有持久 projection 或事件流，其监听行为由包测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LSP 导航与诊断子系统](../../../docs/subsystems/lsp.zh.md)——操作与结果契约。
- [dsh-lsp-stdio](../lsp-stdio/README.zh.md)——配置发布诊断的本地服务器。
- [dsh-tool-lsp](../tool-lsp/README.zh.md)——直接查询并呈现诊断。
- [lsp 组地图](../README.zh.md)——相关包与组合方式。

-----

<a id="model-experience"></a>
## 模型体验

### 追加的诊断

#### 模型看到什么

成功的 `edit` 或 `write` 产生诊断时，下一次模型请求会在该工具结果中收到诊断文本。文件没有诊断或查询失败时不会添加诊断文本块。

#### Token 影响

追加的诊断文本受 `maxResultChars` 限制，且仅在结果非空时出现。

#### KV Cache 影响

此前的请求内容与工具结果块保持不变；仅成功的 edit/write 结果会增加诊断块。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该插件何时不合适。它们是当前包约束，不是任务积压。

- **不捆绑服务器二进制文件**——基于 base 的 profile 会检测 PATH 中的四种支持命令，但不会安装它们。文件扩展名没有提供方时，`lsp` 工具以 `LSP_UNAVAILABLE` 失败，本插件会保持 edit/write 结果不变。
- **推送诊断尽力而为**——服务器不发布诊断，或未能在 `diagnosticsWaitMs` 到期前完成分析时，结果为空；本插件不会重试，也不会阻塞编辑。
- **触发工具固定**——仅增强内置 `edit` 与 `write` 结果；其他编辑工具保持不变。
- **服务器信任由部署方负责**——提供方以已挂载的 subprocess 和文件系统权限运行配置好的服务器；本插件不增加沙箱。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

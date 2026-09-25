---
description: "在 edit 与 write 成功后尽力附加诊断上下文，供组合 LSP 提供方与文件工具的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-post-edit-diagnostics

[English](README.md) | 中文

## 概述

使用 `dsh-lsp-post-edit-diagnostics` 在 `edit` 或 `write` 成功后附加改动文件的诊断，不会额外启动模型轮次。它使用会话工作区与已配置的 `ctx.lsp` 提供方；若诊断为空或查询失败，成功的文件操作结果保持不变。当编码 profile 需要在编辑后立即收到语言服务器反馈时选择它。本包既不安装语言服务器，也不提供进程隔离。

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

将本插件与已配置的 LSP 提供方及文件系统工具一同挂载；组合中必须已经提供 `ctx.tools` 与 `ctx.lsp`。

### 文件变更后会发生什么

已配置工具调用成功后，插件读取 `file_path` 和调用方会话的 `header.cwd`，再通过 `ctx.lsp` 查询更新后文件的诊断。若结果非空，会作为附加上下文加入下一次模型请求；空结果不会添加上下文。工作区缺失、扩展名不受支持、提供方失败或调用取消时同样不会添加上下文，也不会把成功的编辑变成失败。

### 最小组合

```yaml
- id: lsp-post-edit-diagnostics
  name: '@deepseek-ai/dsh-lsp-post-edit-diagnostics'
```

这行假设 `ctx.tools`、`ctx.fs`、`ctx.subprocess` 和 `ctx.lsp` 已由其他插件提供，并且至少配置了一个 `dsh-lsp-stdio` 服务器来处理工具所改动的文件。本插件不会挂载服务器或 `lsp` 工具。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `toolNames` | `['edit', 'write']` | 成功后触发诊断查询的工具名称 |
| `maxResultChars` | `16000` | 诊断文本上限，包含截断元数据 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsp-post-edit-diagnostics)列出所有受支持字段。

### 失败与恢复

本插件采用尽力而为策略：忽略会话 cwd 缺失、文件扩展名没有注册的提供方、诊断为空、提供方失败或调用取消。原始 edit/write 结果以及其他 post-execute 监听器附加的上下文都保持不变。空结果不会发送给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件在工具派发后运行，因此提供方读取的是成功写入后的文件。本插件复用 `dsh-tool-lsp` 的诊断 formatter，并通过 `tools/post-execute` 的 `additionalContexts` 加入文本；它不替换工具结果，也不新增面向模型的工具。

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

### 附加诊断上下文

#### 模型看到什么

成功的已配置工具调用产生诊断时，下一次模型请求会收到一条独立的 user-context 消息，内容包括文件路径与有长度上限的诊断文本。原始工具结果保持不变。文件无诊断或查询失败时不会添加消息。

#### Token 影响

上下文受 `maxResultChars` 限制，并且仅在结果非空时加入。

#### KV Cache 影响

新消息追加在既有请求前缀之后；它不会改变前面的缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该插件何时不合适。它们是当前包约束，不是任务积压。

- **默认不提供服务器或 profile 挂载**——语言服务器二进制文件由部署方负责；已交付的 profile 未配置 LSP 提供方。仅在 `ctx.lsp` 已配置提供方的组合中挂载本插件。
- **推送诊断尽力而为**——服务器不发布诊断，或未能在 `diagnosticsWaitMs` 到期前完成分析时，结果为空；本插件不会重试，也不会阻塞编辑。
- **默认仅匹配工具名**——默认由 `edit` 与 `write` 触发。若挂载了 `str_replace_editor` 等其他工具，可将其名称加入 `toolNames`。
- **服务器信任由部署方负责**——提供方以已挂载的 subprocess 和文件系统权限运行配置好的服务器；本插件不增加沙箱。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

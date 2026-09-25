---
description: "lsp 组地图：通过 LSP seam、stdio 提供方、面向模型的 lsp 工具与编辑后诊断增强，实现语言服务器代码导航和诊断，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# lsp/：语言服务器代码导航

[English](README.md) | 中文

## 概述

智能体可通过配置好的语言服务器导航代码并查看诊断：定义、引用、实现、悬停信息和文件诊断。`dsh-lsp` 规范化提供方结果；`lsp-stdio` 连接已配置的服务器；`tool-lsp` 提供按需查询；`lsp-post-edit-diagnostics` 在 `edit`/`write` 成功后附加诊断。部署方须提供服务器二进制文件和配置；已交付的 profile 均不挂载这些可选包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`lsp/`](lsp/README.zh.md) | 定义代码导航与诊断服务：按文件扩展名选择提供方、五种规范化操作与结构化错误 | `ctx.lsp` |
| [`lsp-stdio/`](lsp-stdio/README.zh.md) | 通过 `ctx.fs` 与 `ctx.subprocess` 驱动配置好的 stdio 语言服务器并注册为提供方，支持有界诊断等待 | 注册到 `ctx.lsp` |
| [`tool-lsp/`](tool-lsp/README.zh.md) | 通过 `lsp` 工具向模型提供精确代码导航与按需诊断 | 注册到 `ctx.tools` |
| [`lsp-post-edit-diagnostics/`](lsp-post-edit-diagnostics/README.zh.md) | 在 `edit`/`write` 成功后尽力附加目标文件诊断，不额外启动模型轮次 | 监听 `tools/post-execute` |

提供方注册能力而非工具：`tool-lsp` 独占面向模型的名称、schema、提示词指引与呈现，因此更换提供方不会改变模型请求导航或诊断的方式。

-----

<a id="related-documentation"></a>
## 相关文档

- [LSP 导航子系统](../../docs/subsystems/lsp.zh.md)——操作、坐标、请求与结果，以及 `LspError` 错误码。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-lsp)——模型接收的 `lsp` schema。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

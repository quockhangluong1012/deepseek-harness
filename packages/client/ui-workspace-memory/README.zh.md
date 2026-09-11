---
description: "Workspace memory page and its Host workspaceMemory Remote face over the durable store."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-memory

[English](README.md) | 中文

## 概述

`dsh-client-ui-workspace-memory` 拥有 Workspace 页面与 `workspaceMemory` Remote 命名空间。页面从侧边栏的 Workspace 名称打开，展示描述、产出文件、会话与动态标签页，以及指令、记忆、上下文三张卡片；页面自身不绘制输入区，因为会话的输入区停靠进页面名称与描述下方留出的 band。Host 侧基于持久存储提供读取、写入、候选文件、重建，以及实时 follow 流。

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

在 `web-app` 组合包中，将该行与存储、提取器、注入器一并挂载。点击 Workspace 名称打开其页面；展开按钮展开分组。页面占用 frame 的 `shell.page` 席位，因此在中栏绘制在会话之上而非覆盖整个应用；没有打开任何页面时它返回 null。

打开页面时会解析该 Workspace 的空白 Session（`uiWorkspace.connectWorkspace` 复用已有的，否则新建）并选中它，因此会话的常驻输入区——与首页展示的是同一个控件，模型、权限与模式席位都是活的——停靠进页面名称与描述下方留出的 band；在那里输入的提示词直接进入该 Workspace 的 Session。一旦该 Session 被真正对话（首次提示词会清除 blank 标记，回复也就在输入区所属的会话中流式返回）、读者在别处打开任一 Session，或侧边栏调用 `close`，页面就把中栏让回；选择被清空时页面保留，因为无会话视图展示的也是它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

未发布不变式伴随包，因为控制器只投影存储，不持有独立状态。

### 设计理念

Host 服务 `ctx.workspaceMemoryController` 拥有 `workspaceMemory` 命名空间；每个动词都先解析 Workspace，失败时返回 `workspace/not-found`。浏览器页面在打开时调用 `read`，并订阅 `follow`，以便后台提取或产出索引写入落地时实时更新。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host Remote 服务与 follow 数据源 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 Remote 词汇 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器侧 opener 服务、Workspace-Session 连接与页面席位注册 |
| [`src/client/rpc.ts`](src/client/rpc.ts) | 页面动词与 follow 订阅 |
| [`src/client/Seat.tsx`](src/client/Seat.tsx) | 页面状态的席位接入 |
| [`src/client/Page.tsx`](src/client/Page.tsx) | 页面：名称与描述、composer band、产出、标签页、卡片 |
| [`src/client/locales.ts`](src/client/locales.ts) | 类型化词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace Memory 规范](../../../specs/workspace-memory.md)——本包实现的行为约定。

-----

<a id="model-experience"></a>
## 模型体验

间接地经由 `@deepseek-ai/dsh-workspace-memory-context`：该包把编辑后的指令、记忆与上下文渲染进注入的 brief。

#### KV Cache 影响

与实时请求无关：本包从不触及请求前缀，因此不会破坏提供方的缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了页面在何种情况下不适合使用。它们是本包当前的约束。

- **仅限 Web**——页面存在于 web 组合中；其他 profile 没有该界面。
- **产出瓦片打开的是其会话，而非文件**——工作区范围的界面没有文件读取器。
- **记忆是单一文档**——没有按条目的来源记录或历史。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

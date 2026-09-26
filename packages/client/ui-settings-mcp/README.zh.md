---
description: "dsh Web 客户端的 MCP 服务器设置页：列出项目与用户配置文件中声明的服务器及其信任级别和实时连接状态，并通过 Host 添加、编辑或删除它们。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

[English](README.md) | 中文

## 概述

在侧边栏打开 **设置** 并选择 **MCP**，即可看到本项目 `.mcp.json` 与用户配置中声明的全部服务器，以及每个声明携带的信任级别和连接是否正常。该页可以添加声明、编辑声明或删除声明；两个配置文件由 Host 持有，因此每次改动都是一次 Host 调用，由它重新读取合并后的配置并返回结果。若改动扩大了模型可访问的范围，则只有 Host 的审批环节同意后才会写入。已保存的环境变量与请求头的值从不显示。

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

随发行版提供的配置默认挂载 [`mcp-project-config`](../../mcp/mcp-project-config/README.zh.md)，由它提供本页使用的 `mcpServers` Remote，并为每个被接受的声明挂载一个 `dsh-mcp-client`。列表显示每个服务器的名称、所属层（项目或用户）、声明的信任级别、接口地址、它设置的环境变量或请求头名称，以及连接状态：**已连接**、**连接中**、**重连中**（附尝试次数）、**已断开**，或 **未运行**（附声明被拒绝的原因）。

## 添加、编辑与删除

**添加服务器** 会打开编辑器：名称、要写入的配置文件、传输方式、本地进程的可执行文件（每行一个参数、每行一个 `NAME=value`），或远程地址的绝对 URL（每行一个 `Name: value`），以及信任级别。**编辑** 会在已有声明上打开同一个编辑器，其中密钥字段为空——已保存的值从不发送到页面，因此编辑会请 Host 保留它们，并把本次写入的键值合并在其上。**删除** 会先请求确认。

扩大模型可访问范围的声明——新增、替换，或删除会暴露同名用户层声明的项目层声明——只有在 Host 的审批环节作答后才会写入。该页会把审批请求发送到当前查看的会话，提示因此出现在该会话的对话中；若没有打开的回合、没有在线 Agent，或用户拒绝，则不会写入任何内容，页面会说明原因。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 半边是空的 `apply`，仅为让该包持有一行 Loader 记录，使客户端模块系统为其提供浏览器半边。浏览器半边向设置外壳的账本注册一个 `settings.section` 条目，`id` 为 `'mcp'`，外壳因此把它投影为导航行，并在其被选中时渲染该分区；同时通过 `ctx.locale.register` 注册它自己的 `settings.mcp` 词典。

`McpSettingsController` 在快照存储中保存页面状态：合并后的视图、是否有写入正在进行，以及最近一次提示。它通过 `remote.mcpServers.list` 读取视图，通过 `remote.mcpServers.upsert` 与 `remote.mcpServers.remove` 写入，并把拒绝当作数据发布——拒绝结果携带未改变的视图，因此被拒绝的改动会让列表与 Host 报告的完全一致。审批请求所指向的会话在写入那一刻读取，从不缓存，因此会跟随当前选择。

`McpServersSection` 渲染列表与唯一的打开编辑器；`draftDeclaration` 把编辑器中的文本转换为 Host 要写入的声明，并指出第一个无法读取的字段。所有产品文案都放在 `locales.ts`，并通过 `t` 座位传给组件；组件不渲染任何已保存的值，只渲染声明所设置的名称。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [mcp-project-config](../../mcp/mcp-project-config/README.zh.md) — Host 半边：配置发现、`mcpServers` Remote 与审批门。
- [mcp-client](../../mcp/mcp-client/README.zh.md) — 本页所报告状态的连接。
- [ui-settings](../ui-settings/README.zh.md) — 设置页外壳，以及本分区注册进的 `settings.section` 账本。
- [approval](../../interaction/user-approval/README.zh.md) — 扩大范围的改动所要经过的审批环节。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该包是浏览器端设置界面，不注册任何模型可见的表面。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **改动需要审批通道** — 当没有会话持有打开的回合时，扩大范围的改动会被拒绝，因为 `user-approval` 只在回合内作答；页面会报告该拒绝而不写入。
- **值是只写的** — 已保存的 `env` 与 `headers` 值从不回传给页面，因此编辑时只显示名称，并在已保存的键值之上合并。
- **不能控制连接** — 页面只报告每个已挂载客户端声明的状态；它既不重连服务器，也不注销其工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

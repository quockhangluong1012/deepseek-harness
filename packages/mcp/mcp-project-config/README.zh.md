---
description: "读取项目 .mcp.json 与用户级 MCP 配置文件，并按配置的服务器挂载对应数量的 dsh-mcp-client 实例，供不想手写内联 cordis.patch.yml 条目的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-project-config

[English](README.md) | 中文

## 概述

`dsh-mcp-project-config` 从项目文件与用户级文件读取与 Claude Code 兼容的 `.mcp.json` 格式，为每条被接受的服务器声明挂载一个 [`dsh-mcp-client`](../mcp-client/README.zh.md) 实例，并提供 `mcpServers` Remote，供 Desktop 的 MCP 设置页列出、写入与删除这些声明。交付的 profile 默认挂载本包；两个文件都不存在是最常见的情形，此时不挂载任何东西。项目条目会覆盖同名的用户条目。一条格式错误的条目只会带着警告被跳过，不会连累其他已配置的服务器；缺失或无法解析的文件也是同样的处理方式——profile 总能完成启动。

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

交付的 profile 已经挂载了本包一次。把你的 MCP 服务器写进项目根目录的 `.mcp.json`，或写进用户级文件，profile 下次启动时就会连接它们；Desktop 的 **设置 → MCP** 页面会列出它们，并编辑同一批文件。

### `.mcp.json` 格式

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

条目可以携带 `trust` 标签——`trusted`、`untrusted`（字段缺省时的默认值）或 `unknown`——该服务器每个工具的声明都会把它传给 agent kernel；取值超出该范围的条目会像其他格式错误的字段一样被跳过。

没有 `type` 字段的 `command` 条目是 stdio 服务器。`args` 与 `env` 默认为空。`"type": "http"` 条目需要绝对的 `http://` 或 `https://` `url`；`headers` 默认为空。其他任何声明的类型（`sse`、`websocket` 及其他）都不受支持，会被跳过。

### 文件位置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `configPath` | `./.mcp.json` | 项目 MCP 配置，相对进程启动 cwd 解析 |
| `userConfigPath` | `$DSH_HOME/mcp.json` | 用户级 MCP 配置，跨项目共享 |
| `failOnStartupError` | `false` | 某个已配置服务器的初始连接失败时，让本插件的激活失败 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-project-config)是每个受支持字段的穷尽式真源。

同一个（规范化后的）名称在两个文件中都声明时只挂载一次，取项目文件的版本：项目对当前工作更具体，因此项目胜出。

### 失败会降级为"没有服务器"，绝不破坏启动

两个文件都不存在时不挂载任何东西也不记录任何日志——这是每个未配置 MCP 服务器的仓库都会看到的情形。存在但不是合法 JSON 的文件会记录一条指名路径的警告，且不从该文件挂载任何内容；另一个文件（若合法）仍正常挂载。缺少必填字段、形状不对或类型不受支持的单条条目会带着一条指名原始键与原因的警告被跳过；同一文件中的其他条目仍会挂载。

默认情况下（`failOnStartupError: false`），无法连接的已配置服务器仍会挂载：`dsh-mcp-client` 记录连接失败并进入自己的重连策略，其他已配置服务器不受影响。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[base 组合包](../../bundle/base/README.zh.md)拥有这一行，被每个基于 base 的 profile（Web、Desktop、ACP、SDK、headless）继承：

```yaml
- id: mcp-project-config
  name: '@deepseek-ai/dsh-mcp-project-config'
```

### 解析是纯函数；挂载由管理服务负责

[`src/parse.ts`](src/parse.ts) 把一份已经 JSON 解码的 `.mcp.json` 文档解析为已接受服务器的映射，外加一份带原因的跳过条目列表——不访问文件系统、不涉及 Cordis，可独立做单元测试。[`src/mcp-servers.ts`](src/mcp-servers.ts) 负责合并后的视图：读取两个文件（缺失文件视为空，不算错误），以项目优先的规则合并它们，并按顺序为每个被接受的服务器调用一次 `ctx.plugin(McpClient, config)`——与 [ACP bridge](../../acp/acp/README.zh.md) 自己的 `mountAcpMcpServers` 一致，只是后者从协议参数而非文件转换同样的形态。每次管理写入都会重新读取两个文件并调和运行中的实例，因此 Remote 报告的正是实际运行的内容。

### 服务器名规范化

已经匹配 `dsh-mcp-client` 的 `serverName` 模式（`^[A-Za-z0-9_-]{1,32}$`）的 `.mcp.json` 键会原样透传。其他任何键——空格、标点、非 ASCII 字符——都会被音译，并附加一个内容哈希后缀，复现 ACP bridge 对来自已连接编辑器的人类可读服务器名所做的同一套规范化。这两个规范化器是刻意独立的实现：基于文件的 `.mcp.json` 条目由开发者拥有，其信任级别与项目的 `bash`/`edit` 工具相同；而 ACP 的 `mcpServers` 参数来自可能远程的编辑器对端，需要一套更严格的校验策略（例如要求 stdio `command` 必须是绝对路径），本包不需要也不想继承这一策略。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema，以及构建审批通道的 Host 接线 |
| [`src/mcp-servers.ts`](src/mcp-servers.ts) | `mcpServers` Remote 服务：合并视图、挂载调和、需审批的写入 |
| [`src/config-file.ts`](src/config-file.ts) | 读取并重写单份 `.mcp.json` 文档，不动其中的其他键 |
| [`src/types.ts`](src/types.ts) | Remote 线上类型：合并视图、写入请求与拒绝词汇 |
| [`src/parse.ts`](src/parse.ts) | 纯 `.mcp.json` 解析、条目校验、声明的信任级别与服务器名规范化 |

不发布运行时不变式伴生入口：服务的视图来自两个文件、解析器，以及已挂载子实例报告的状态，没有第二个观察者独立记录这些事实。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [MCP 客户端](../mcp-client/README.zh.md)——为每个已配置服务器挂载一次的插件：传输、指令与连接生命周期。
- [MCP 资源](../mcp-resources/README.zh.md)——任一服务器一旦配置即可用的共享资源发现工具。
- [ACP MCP bridge](../../acp/acp/README.zh.md)——由已连接编辑器提供 MCP 服务器时的兄弟挂载路径，而非来自文件。
- [MCP 设置页](../../client/ui-settings-mcp/README.zh.md)——列出这些服务器并通过 `mcpServers` Remote 写入声明的 Desktop 页面。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-project-config)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

间接产生影响，通过每个已挂载的 `dsh-mcp-client` 实例，以及一旦任一服务器已配置，还有 [`dsh-mcp-resources`](../mcp-resources/README.zh.md) 的共享工具。本包自身不注册任何工具、提示词段落或 PTC 声明。

#### KV Cache 影响

没有直接影响；每个已挂载的 `dsh-mcp-client` 实例拥有自己的请求前缀影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **管理写入需要审批通道**——在没有会话持有打开的回合时，新增声明、替换声明，或删除会暴露同名用户层声明的项目层声明都会被拒绝，因为 `user-approval` 只在回合内作答。
- **文件在启动时以及每次管理写入后读取**——在 Host 之外修改的 `.mcp.json` 要等 profile 重启才会被感知；没有文件监视器。
- **不支持 OAuth、旧版 SSE 或 MCP 提示词模板**——只有 `dsh-mcp-client` 支持的子集（stdio、Streamable HTTP）能到达已挂载服务器；其他任何声明的类型都会被跳过。
- **按顺序挂载**——服务器逐个挂载，因此 `dsh-mcp-client` 自身阻塞式的初始连接行为意味着 N 个已配置服务器可能累加各自最坏情况下的启动延迟；这与 ACP bridge 既有的挂载方式一致，而非引入第二种并发约定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

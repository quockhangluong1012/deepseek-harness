# Agent Note: Workspace Memory — Instructions / Memory / Context

Status: implemented

[English](2026-09-10-workspace-memory.md) | 中文

## 问题

同一目录中的会话之间不共享任何持久内容：作者编写的项目规则散落在各处 `AGENTS.md` 文件中，没有按 Workspace 的归属；模型学到的知识在会话结束时蒸发；附加文件每个轮次都要重新粘贴。Workspace 当时只是导航——对模型不可见，没有提示词成本，也没有自己的页面。

## 决定

按 [`specs/workspace-memory.md`](../../../../specs/workspace-memory.md) 发布四个包，按依赖策略与编译面切分：

- `@deepseek-ai/dsh-workspace-memory`（workspace 组）拥有 `workspace_memory` 域上的持久记录（`per-record`，版本 1，记录损坏时明确失败）：描述、指令、带 `memoryUpdatedAt` 的记忆、最新在后的上下文条目、受 `maxOutputs` 上限约束的最新在前的产出，以及 `lastExtraction` 来源记录。读取是同步的；`capacityBytes` 为必填；其余每个上限都是经过校验的 `Config` 字段。容量计入指令、记忆与条目大小；摘要只覆盖这三者，因此描述与产出的写入永远不会重新注入。
- `@deepseek-ai/dsh-workspace-memory-llm`（workspace 组）在 `ctx.workspaceMemoryExtractor` 背后拥有派生：从 `turn/end` 工具调用进行始终开启的产出索引、按 Workspace 的 promise 链上的门控按轮次提取，以及通过 `sessionQuery.filterEvents` 对最新会话按需 `rebuild`。调用是确定性的（`temperature: 0`、`purpose: 'workspace-memory'` 并关闭推理），并且失败时降级为一条警告。
- `@deepseek-ai/dsh-workspace-memory-context`（context 组）渲染单条 `<system-reminder>` brief 并将其拼接进 `agent/pre-step`，在 `maxBytes` 预算内于摘要变化时替换（先丢弃上下文，再丢弃记忆，最后丢弃指令）。
- `@deepseek-ai/dsh-client-ui-workspace-memory`（client 组）拥有 Host `workspaceMemory` Remote 命名空间与 frame 中栏 `shell.page` 席位中的浏览器 Workspace 页面（[决策](../architecture/2026-09-10-center-track-page-seat.zh.md)），以及 `ui-workspace` 可选消费的 `workspacePage` opener——侧边栏名称打开页面，而展开按钮保留展开分组的功能。页面中的产出目录在比较时同样对待两种分隔符，因此 Windows Workspace（`C:\proj`）仍能匹配反斜杠形式的产出路径。

`GenerateOptions.purpose` 在 `'compaction'` 与 `'session-title'` 之外新增 `'workspace-memory'`，并在 `dsh-llm-deepseek` 中像会话标题那样关闭推理。组合行只落在 `web-app` 组合包中，因此 headless、sdk 与 acp 会话从不携带 brief，记录会话快照保持逐字节一致。

## 备选方案

- **用一个包同时承载存储、提取、注入与 UI。** 因客户端／宿主依赖策略与编译面而被否决：存储需要 storage-domain，提取器需要 LLM seam，注入器需要 agent loop，页面需要浏览器面。四个包让每条依赖边都可分类。
- **为 brief 新增一种会话事件。** 否决：brief 搭载在既有的持久 `user/message` 上，并带有类型化的 `workspace-memory` 来源，因此回放、压缩与「模型可见 ⟺ 已记录」在格式不变的前提下成立。
- **带来源记录与历史的按条目记忆。** v1 否决：单份带上限的 markdown 文档不需要第二层存储，并且可直接编辑；未来的数组形式只需改动卡片、`setMemory` 与提取器的合并。
- **把记录存进项目目录。** 否决：`$DSH_HOME` 下的机器本地存储不需要项目写权限；未来可提交的形式保留存储 API，只替换域。
- **保留行点击为展开分组，另加右键菜单入口。** 否决：要求的交互是名称打开页面并配一个专用展开按钮，代价是所记录的测试与快照改动。

## 后果

Workspace 中的每个会话都以部署方选定的每请求成本继承共享知识，Workspace 也获得一个页面（描述、产出、会话／动态、三张卡片）。成本：多一个存储域、每个满足门控的轮次一次后台 LLM 调用，以及每次编辑累积一条被取代的 brief 消息在日志中。文件上下文按请求重新读取，其记录的大小是快照。

## 测试

存储规格在真实存储／域栈上钉住上限、容量、摘要覆盖范围、产出幂等性与读取不泄漏引用。渲染规格钉住字节上限、丢弃顺序、通知行与框架转义。提取器规格钉住配置配对、JSON 框架化、路由优先级与销毁后的静默。页面规格钉住关闭时不渲染任何内容、打开时三张卡片、重新生成时显示忙碌，以及 `too-large` 的卡片文案；侧边栏改动保留 `treeitem`／`aria-expanded`，把展开分组移到展开按钮，并且每个注册包在销毁时移除其 pre-step 监听器、slot 条目或 Remote 命名空间。`snapshots/web/workspace-memory` 通过真实链路回放真实页面并比对 aria 金标，而 headless 记录会话保持逐字节一致。

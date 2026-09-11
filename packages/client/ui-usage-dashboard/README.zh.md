---
description: "用量仪表盘右侧 Sidebar tab 及其 Host usageDashboard Remote 面：经用量台账提供汇总。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-usage-dashboard

[English](README.md) | 中文

## 概述

`dsh-client-ui-usage-dashboard` 在两个位置展示已计费 LLM 用量。左侧 Sidebar 的 **仪表盘**入口打开全视口浮层，展示跨会话总数：今天/近 7 天/近 30 天/全部过滤、总请求数、输入/输出 token、缓存命中数、平均缓存命中率、按天堆叠的输入/输出柱状图（UTC+7），以及按模型的表格。右侧 Sidebar 的 `usage` tab 只保留当前会话：其实时头部与累计统计卡片读会话自身的 `tokenUsage` 与 `sessionStats` 投影，无过滤、无 Remote 拉取。Host 一半（`ctx.usageDashboard`）经 `usageDashboard` Remote 命名空间提供按范围汇总，委托给用量台账；折叠与持久化在台账，不在这里。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

跨会话浮层从左侧 Sidebar 的仪表盘入口打开。浏览器一半无需配置。Host 一半也无需配置：它委托给拥有三个持久化选项的 `ctx.usageLedger`。同时挂载两行：

```yaml
- id: usage-ledger
  name: '@deepseek-ai/dsh-usage-ledger'
  config:
    retentionDays: 90
    writeEveryEvents: 100
    writeIntervalMs: 60000
- id: ui-usage-dashboard
  name: '@deepseek-ai/dsh-client-ui-usage-dashboard'
```

一次已计费请求是 `assistant/message` 或 `assistant/attempt` 事件上的一个 provider 用量样本——重试会计数，因为每个样本都代表此前请求已花掉的 token。输入 token 是已计费提示 token（`uncached + cacheRead + cacheWrite`）；平均缓存命中为 `cacheRead / billedInput`。天固定为 UTC+7。空窗口仍绘制图表框架与其无数据行。

### 组合

```yaml
- {name: '@deepseek-ai/dsh-storage'}
- {name: '@deepseek-ai/dsh-storage-json', config: {root: /var/lib/dsh/data}}
- {name: '@deepseek-ai/dsh-storage-domain', config: {backend: json}}
- id: usage-ledger
  name: '@deepseek-ai/dsh-usage-ledger'
  config:
    retentionDays: 90
    writeEveryEvents: 100
    writeIntervalMs: 60000
- id: ui-usage-dashboard
  name: '@deepseek-ai/dsh-client-ui-usage-dashboard'
```

台账以一个原子文档持久化在 `usage_dashboard` 域上（`single` 布局、`backup-and-skip`）：按天计数、按天按模型计数、按会话折叠游标。同一步内重试成功归因到该步 message 的路由；从未落定路由的步归因到未知路由。

### 如何读数

总数是参考值，不是账单记录：无法证明的样本会被跳过，绝不补零。计数从台账首次挂载开始——此前结束的会话在再次运行前没有贡献。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计思想

浏览器一半不持有账目：跨会话数字经 Remote 来自 Host 台账，会话头部读当前会话的投影。Host 面委托给拥有折叠、游标与写策略的 `ctx.usageLedger`——本包 Host 入口没有任何存储导入，因此符合 client/host 依赖政策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `UsageDashboard` 服务：台账之上的 `summary` Remote |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器一半：当前会话 tab 类型与正文，以及跨会话底部动作注册 |
| [`src/client/DashboardAction.tsx`](src/client/DashboardAction.tsx) | 左侧 Sidebar 触发行与跨会话浮层对话框 |
| [`src/client/display.tsx`](src/client/display.tsx) | 共用的计数格式化、图表几何与汇总正文 |
| [`src/client/UsageDashboard.tsx`](src/client/UsageDashboard.tsx) | 当前会话面板：实时头部与累计卡片 |
| [`src/client/store.ts`](src/client/store.ts) | 按 tab 的过滤范围与已拉取汇总 |
| [`src/client/face.ts`](src/client/face.ts) | 代际守卫的汇总拉取 |
| [`src/client/definition.ts`](src/client/definition.ts) | `usage` 页面类型定义 |

### 折叠流程

折叠在 `@deepseek-ai/dsh-usage-ledger`：`session/event` 把用量样本折叠进按会话区分的按步桶；该步首个落定 message 把早到的未知路由样本搬移到其路由；`step/end` 让桶退役，`turn/end` 与计数/时间节流一起触发持久写。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Token meter](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.zh.md) ——台账校验所对照的 projected-usage 设计。
- [Usage ledger](../../session/usage-ledger/README.zh.md) ——`summary` Remote 背后的持久计数与折叠。
- [Slots reference](../../../docs/subsystems/slots.zh.md) ——本包遵循的两段式 tab 注册。

-----

<a id="model-experience"></a>
## 模型体验

无。本包不增加提示、消息、schema、工具或模型调用。Host 一半折叠持久日志并提供一个只读 Remote；浏览器一半负责渲染。

#### KV Cache 影响

无失效；本包不改变任何请求前缀。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了仪表盘的止境与后续工作的起点。

- **计数从挂载开始**——台账首次挂载前结束的持久会话没有贡献；只有活跃会话会回填，且只从其游标开始。
- **参考性总数**——无法证明的样本按构造少计；台账不是账单记录。
- **手绘图表**——堆叠柱状图是无依赖 SVG；若未来需要更丰富的交互，换图表库也只是一文件的事。
- **固定 UTC+7 天**——报告时区是产品决定，不是部署选项。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时 invariant：**不发布 companion。台账是会话日志的单向折叠，没有可独立观测对照的另一面；重启经由游标与原子文档对账，而非 invariant。

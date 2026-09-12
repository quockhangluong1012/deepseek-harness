---
description: "DeepSeek Harness 用量仪表盘的持久台账：按天、按模型汇总已计费 LLM 请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-usage-ledger

[English](README.md) | 中文

## 概述

`dsh-usage-ledger` 把每个活跃会话的已计费 LLM 请求折叠为持久的按天、按天按模型计数，并向用量仪表盘提供按范围汇总。一次已计费请求是 `assistant/message` 或 `assistant/attempt` 事件上的一个 provider 用量样本——重试会计数，因为每个样本都代表此前请求已花掉的 token。状态以一个原子文档持久化在 `usage_dashboard` 存储域上，每次写都是 fail-soft。

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

当消费者需要跨会话的已计费用量聚合时挂载本插件。本插件没有模型可见面；三个持久化选项都是显式的校验后 `Config`，没有静默默认值：

```yaml
- id: usage-ledger
  name: '@deepseek-ai/dsh-usage-ledger'
  config:
    retentionDays: 90
    writeEveryEvents: 100
    writeIntervalMs: 60000
```

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
```

### 如何读数

`summary(range)` 回答 `today`、`7d`、`30d`、`all` 的总数、按天桶与按模型表。输入 token 是已计费提示 token（`uncached + cacheRead + cacheWrite`）；平均缓存命中为 `cacheRead / billedInput`；天固定为 UTC+7。总数是参考值，不是账单记录：无法证明的样本会被跳过，绝不补零；计数从台账首次挂载开始。

同一套 UTC+7 日历从包根导出——`dayKeyUTC7`、`dayStartUTC7`、`daysOfRange`、`isUsageRange` 与 `windowStartOfRange`——因此报告按天历史的面（即演进时间线）按仪表盘的天分桶，而不是自行重新推导时区偏移。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计思想

台账从持久会话日志派生，从不写回：按会话游标加子会话自有事件范围让重启与 fork 不重复计数，单个原子文档让计数与游标在崩溃前后一致。内存计数永远领先介质，因此丢一次写只意味着下次启动时回填更长。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `UsageLedger` 服务：实时折叠、write-behind 与按范围汇总 |
| [`src/aggregate.ts`](src/aggregate.ts) | 纯折叠：样本校验、UTC+7 分桶、路由搬移、保留期、汇总；其日历辅助函数从包根重新导出 |
| [`src/spec.ts`](src/spec.ts) | `usage_dashboard` 域声明 |
| [`src/types.ts`](src/types.ts) | 共享的范围/汇总词汇 |

### 折叠流程

`session/event` 把用量样本折叠进按会话区分的按步桶；该步首个落定 message 把早到的未知路由样本搬移到其路由；`step/end` 让桶退役，`turn/end` 与计数/时间节流一起触发持久写。Init 打开域、采用其文档，并按游标回填活跃会话——每个事件重新读一次游标，因此回填途中由实时路径折叠的事件绝不会被数两次。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Token meter](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.zh.md) ——台账校验所对照的 projected-usage 设计。
- [Storage subsystem](../../../docs/subsystems/storage.zh.md) ——台账文档背后的域契约。
- [Usage dashboard](../../client/ui-usage-dashboard/README.zh.md) ——读取这些汇总的 Sidebar tab。

-----

<a id="model-experience"></a>
## 模型体验

### 无模型可见表面

#### 模型看到什么

无。本包不增加提示、消息、schema、工具或模型调用；它折叠持久日志，并在 `ctx.usageLedger` 上提供一个只读查询面。

#### Token 影响

零。台账只统计其他包已经计费的 token，既不组装请求，也不向请求添加内容。

#### KV Cache 影响

无失效；本包不改变任何请求前缀。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了台账的止境与后续工作的起点。

- **计数从挂载开始**——台账首次挂载前结束的持久会话没有贡献；只有活跃会话会回填，且只从其游标开始。
- **参考性总数**——无法证明的样本按构造少计；台账不是账单记录。
- **固定 UTC+7 天**——报告时区是产品决定，不是部署选项。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时 invariant：**不发布 companion。台账是会话日志的单向折叠，没有可独立观测对照的另一面；重启经由游标与原子文档对账，而非 invariant。

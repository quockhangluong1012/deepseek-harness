# Agent Note: P1 瓶颈分析批次 7

Status: implemented

[English](2026-09-13-p1-bottleneck-batch-7.md) | 中文

## Problem

全量清扫修复的第 7 批（`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`），日期为 2026-09-13，覆盖 P1 瓶颈发现项。本批落地了一项文档更正，其余发现项均在没有代码改动的情况下完成分诊，并记录了下述使其不值得当下做点式修复的证据。

## Decision

`guard/budgets`：`maxToolCalls` 的文档由 "completed" 更正为 "dispatched" —— 涉及模块 JSDoc、`Config` 字段、`TurnFacts` 注释，以及 `README.md` + `README.zh.md` 的表格、yaml 与正文。计数器读取的是 `tool/call`（派发时点）；对花费控制而言这才是保守而正确的计量口径（模型为产生该次调用已经运行过），因此错的是文档而非代码。无行为变更；13/13 测试通过。

## Alternatives considered

- **改计数器而不是改文档：** 已否决。改为在完成时计量会静默地重新调校所有已部署的预算。
- **`deriveMessages` 的每次调用展开：属于已有文档的微小开销。** 文档块（session `index.ts:823-830`）已写明该契约：O(new) 派生、共享的冻结消息、每次调用新建数组。每次调用的展开只复制引用（即便超长记录也低于毫秒），而新建数组正是调用方能够安全 sort/filter 的原因。共享的冻结视图会带来调用方改写的风险，却换不到任何实测收益。
- **`budgets` 的每步重放：已被证伪。** `tokenMeter.measure` 是增量折叠的（`while (state.consumedEvents < session.seq)`，token-meter `index.ts:231`）——每次调用只对新增事件计价。
- **语料 `load()` 先取列表：延后。** 对存在的会话，整段日志读取的成本压过列表扫描；列表还提供 `SESSION_QUERY_SESSION_NOT_FOUND` 分类与 header 兼容性竞态检查。移除它就得改写 exact-read 取消测试（它们通过 `listOverride` 固定了基于列表的流程），而省下的开销只在缺失 key 的探测上可测。
- **`load()`/`snapshotLive` 中的 `structuredClone`：延后，等待逐后端别名证明。** 实时路径的克隆是必需的（共享可变日志）；冷路径的克隆只有在 `readColdSessionLog` 于每个后端都返回完全自有结构时才属于可疑浪费——这一点尚未逐后端证明，移除它们则有让消费方改写缓存状态的风险。
- **session `list()` 的重扫：延后到后续 spec。** 它需要带修订叙述的索引/记忆设计，而非点式修复。
- **SSE 增量 `block-end`：延后，等待 TTFT 测量。** 在没有测量夹具的情况下调整流式时序，会为信仰式收益引入细微的消费方缺陷（第 3 批出于同样的理由延后）。

## Consequences

`guard/budgets` 的文档现在与代码实际实现的派发时点计量一致，13/13 测试通过且无行为变更。代价是本批其余部分原样交付，其中四项发现是延后而非关闭：语料 `load()` 先取列表的移除与冷路径 `structuredClone` 的移除在等待证据（仅缺失 key 才有的收益；逐后端别名证明），session `list()` 重扫在等待一个带修订叙述的索引/记忆设计（见后续 spec），SSE `block-end` 重排在等待 TTFT 测量夹具。`deriveMessages` 的展开维持在已文档化的微小开销，`budgets` 的每步重放则被直接证伪。

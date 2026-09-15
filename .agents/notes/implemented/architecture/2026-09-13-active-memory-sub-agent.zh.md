# Agent Note：主动的逐轮记忆搜索（演进 harness 规范 §14）

Status: implemented

[English](2026-09-13-active-memory-sub-agent.md) | 中文

## 问题

规范 §14（Active Memory Sub-Agent）想要的是主动检索：在每轮作答前，用用户自己的消息去搜索记忆，按相关性阈值过滤，注入 top-k 幸存者。最接近的既有机制 `dsh-evolution-memory-context`，注入的是一份持久的、按 scope 的简报（instructions/lessons/profile），由内容摘要门控——每轮都是同一段文本，直到记录变化，从不依赖用户刚问了什么。这是真正不同的机制，而不是同一机制的变体。

## 决定

把 `@deepseek-ai/dsh-active-memory-context` 建成独立的包：一个 `agent/pre-step` 监听器，读取该步骤自身提议的消息（绝不读取某个更早监听器已经追加的简报），用与同级包相同的方式解析 workspace 成员关系，并调用 `ctx.sessionQuery.searchSessionsSemantic`，把范围限定在该 workspace 的*其它*会话——当前会话总是被排除，因此一个轮次永远不可能把自己刚提交的消息当作"相关记忆"浮现出来。超过相关性阈值的幸存者渲染成一条带框架的 `user/message`，追加到该步骤上。

### 相关性阈值带来的契约变更

规范 §14 的 `relevance_score >= threshold` 门槛，无法用原来的 `SessionSearchHit` 构建：那个类型故意不携带任何数值分数，因为 `searchSessionsHybrid` 的倒数排名融合输出把两个量纲不可比的通道混合在一起（这是本会话更早 §15 阶段的决定）。但 `searchSessionsSemantic`——单通道方法，从不融合——恰好有一个有意义的数字：针对某一个嵌入模型自身向量的余弦相似度，在同一次部署配置的同一个 provider 内部是可比的。

只拓宽了这一个方法的返回类型为 `SemanticSessionSearchHit`（`SessionSearchHit & { score: number }`），`searchSessionsHybrid` 及其融合后的 `SessionSearchHit[]` 保持不动——"不携带 provider 专属数字"的决定原封不动地留在它本该留的地方。这是一次真实、但范围很窄的契约变更：抽象方法 `searchSessionsSemantic` 的每一个实现（具体的 SQLite 引擎，加上分布在 `session-query`、`tool-session-query`、`subagent`、`tool-subagent-control`、`session-controller`、`session-reference`、`experimental/agent-team`、`experimental/tool-agent-team`、两个 benchmark worker 与一个 CLI 测试 fixture 里的 11 个测试替身）都需要更新返回类型注解。这 11 个替身全都是从不构造真实命中的、直接 reject 的实现体，因此修复纯粹是类型注解改动加每个文件一处未使用导入的清理——除了具体的 SQLite 引擎外，行为哪里都没变；SQLite 引擎现在把它本来就已经算出、此前被丢弃的余弦分数一路传给调用方。

### 自我排除与 workspace 范围限定

在轮次进行中搜索会话自身，会把刚提交的消息当作近乎完美的匹配"找到"——这是纯粹的噪音，而非记忆。`others = scopeIds.filter(id => id !== session.id)` 让这在结构上就不可能发生，而不是指望模型或运维人员去留意。把范围限定在当前 workspace（而非全局搜索）与 `dsh-evolution-memory-context` 已经划定的隐私边界一致；不属于任何 workspace 的会话得不到 active memory，而不是得到一次无范围限定的跨租户搜索。

### 成本纪律

最近邻向量搜索总会给出"最接近"的候选，无论它们实际有多远——余弦相似度本身没有内建"无匹配"这种结果，因此只靠 `topK` 会在偏题轮次上悄悄注入偏题的噪音。`relevanceThreshold`（默认 0.7，与规范一致）就是让"不相关"变得可检测的质量闸门。`turnInterval`（默认 1，与规范字面上的"每次作答前"一致）用与同级包提示间隔相同的方式限制嵌入调用成本，而 `searchedForTurn` 这张 map 防止同一个已观察轮次的重试步骤重新搜索、重复注入。

## 考虑过的替代方案

**扩展 `dsh-evolution-memory-context`，而不是新增一个包。** 它确实是最接近的既有机制，但两者有各自独立演进的触发条件——一个响应记忆*写入*（摘要变化），另一个响应*轮次内容*（每一轮都响应，无论 `evolutionMemory` 里是否写过任何东西）——数据源也相互独立：静态的按 scope 精选字段，对比原始的会话历史搜索。把两者揉进一个包，意味着一个文件要兼顾两套互不相关的缓存失效故事——违反了能力接缝"一个清晰目的"的原则。

**把分数挂在 `SessionSearchHit` 上，从而也挂到 `searchSessionsHybrid` 的融合输出上。** 否决：不携带分数的类型形状，正是让倒数排名融合不会被读成量纲可比的数字的原因，而那个决定本来就是为 `searchSessionsHybrid` 做的。只有 `searchSessionsSemantic`——单通道、从不融合——才有一个有意义的数字，因此只有它的返回类型被拓宽为 `SemanticSessionSearchHit`。

**搜索整个存储，而不是当前 workspace。** 否决：限定 workspace 与 `dsh-evolution-memory-context` 已经划定的隐私边界一致，因此不属于任何 workspace 的会话得不到 active memory，而不是得到一次无范围限定的跨租户搜索。

**不加相关性闸门，直接注入 top-k 命中。** 否决：最近邻向量搜索总会给出最接近的候选，无论它们实际有多远——余弦相似度没有内建"无匹配"——因此只靠 `topK` 会在偏题轮次上悄悄注入偏题的噪音。`relevanceThreshold`（默认 0.7）才是让"不相关"变得可检测的东西。

## 后果

- 这条路径两端都有界：每 `turnInterval` 轮才做一次带嵌入的搜索，且只有达到 `relevanceThreshold`（默认 0.7）的命中能幸存——偏题的轮次什么都不会加，而不是加上它那些同样遥远的最近邻。
- 注入就是在监听器已经检查过的那一步上追加一条带框架的 `user/message`；该步骤的其它部分都不会被改写。
- 不属于任何 workspace 的会话完全得不到 active memory——这是把搜索留在 `dsh-evolution-memory-context` 所划隐私边界之内所付的代价。
- `searchSessionsSemantic` 现在返回 `SemanticSessionSearchHit`，因此每一个实现都带着这个更宽的注解（具体的 SQLite 引擎与 11 个测试替身），而 `searchSessionsHybrid` 及其 `SessionSearchHit[]` 保持不携带分数的契约。
- 这个包不新增任何持久化状态：它唯一的记账就是内存中的 `searchedForTurn` map，用来防止重试的步骤对同一个已观察轮次重复搜索、重复注入。

## 验证

- `packages/session-query/session-query/tests` 及每一个被改动的测试替身所在包：全套测试通过，`pnpm run typecheck` 只剩 7 个既有的 `usage-ledger`/`evolution-memory-context` 错误。
- `packages/context/active-memory-context`：27 个测试（5 个纯渲染测试，22 个针对真实 `SqliteSessionQueryEngine` + `JsonlSessionPersistence` + 一个词袋假嵌入服务的引擎测试），四项指标覆盖率均为 100%。
- 一次由覆盖率驱动的重构：把"cwd 无法解析"与"cwd 解析成功但没有匹配的 workspace"这两个提前返回合并成围绕一个三元表达式的单个 `if`，修复了 `@vitest/coverage-v8` 在函数末尾两个相邻、无 else 的 `if` 块上的一个分支归因缺陷——合并后的写法报告干净，可读性也没有降低。

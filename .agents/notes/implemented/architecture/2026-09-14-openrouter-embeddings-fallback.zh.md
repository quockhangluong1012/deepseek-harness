# Agent Note：§14 在 OpenRouter 上线，并带 provider 层模型降级

Status: implemented

[English](2026-09-14-openrouter-embeddings-fallback.md) | 中文

## Problem

§14（Active Memory Sub-Agent）已完全建成，但在所有部署中都是静默的：`active-memory-context` 只搜向量通道，而没有任何 bundle 挂载 embeddings provider，于是每次搜索都降级为空结果。要解开它，需要回答规范没有回答的两个问题：以 DeepSeek 为中心的 harness 该调用哪个嵌入端点（DeepSeek 不发布嵌入端点，密钥无法共用）；以及端点宕机时怎么办——部署选用的 `:free` 层模型恰恰是最不可靠的。

## Decision

在 web-app bundle 的 autonomy slice 之后挂三行：`embeddings` 注册表（裸行；全部可调项都有默认）、指向 `https://openrouter.ai/api/v1` 的 `embeddings-http`（主模型 `nvidia/llama-nemotron-embed-vl-1b-v2:free`，备用 `nvidia/nemotron-3-embed-1b:free`，`apiKeyEnv: OPENROUTER_API_KEY`），以及 `maxBytes: 16384` 的 `active-memory-context`（沿用两个已挂载 context 包的惯例）。密钥每批从启动环境解析，因此缺 key 也能安全启动——向量通道降级为空结果，直到 key 出现。0.7 相关阈值仍按主模型标定；换模型就要重标。

`fallbackModel` 是 HTTP provider 的新可选字段，而不是第二个挂载行：两个行无法服务同一路由（第二个启动会 `DUPLICATE_PROVIDER` 失败），而第二个路由是死的，因为所有消费者都解析默认路由。主失败时整批在备用模型下重试一次，每次尝试各有自己的 `timeoutMs`；两者都失败时错误同时写明两个模型与两次失败。存储的向量按模型键控，备用向量永远不会被当成主向量读出。

## Alternatives considered

**OpenRouter `models` 数组做降级。**嵌入端点不存在这个参数——只有 `provider.allow_fallbacks`（同模型、备用服务商），而本 provider 并不发送它。因此重试只能上浮一层，做到 provider 里。

**只重试可重试的状态码。**区分 429/529/5xx 与 401/402/404 可以避免把注定失败的调用发两遍，但每个分类分支都要测试，而多发的那一次只发生在端点本来就坏了的时候。按文档采用失败即重试一次。

**把 active-memory 切到 hybrid 通道，让 §14 不依赖 embeddings 也能跑。**关键词分支确实不需要向量，但 RRF 分数不是余弦相似度，0.7 阈值会滤掉一切。那是阈值重设计，是另一个独立 phase，不在这次挂载之内。

## Consequences

`embeddings-http` 增加 4 个测试（共 24 个），语句与分支保持 100%。新增三行后 `verify-cordis-config` 通过；boot lane 覆盖该组合。之前接受的每 turn 成本不变：每轮符合条件的 turn 做一次 query embedding 加一次向量搜索。

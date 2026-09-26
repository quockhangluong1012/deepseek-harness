---
description: "嵌入提供方注册表与带缓存的批量调用：每批一次按路由解析的请求，向量按内容哈希缓存（ctx.embeddings）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-embeddings

[English](README.md) | 中文

## 概述

`dsh-embeddings` 是嵌入能力：一张提供方路由注册表，以及在其之上的批量调用。请求可以具名路由与模型，也可以两者都省略——此时取唯一已注册的路由与提供方自带的默认模型。缓存键由解析后的路由、模型与文本三者共同构成，因此改动其中任一项都对应另一条目而非命中旧向量；缓存有界：达到配置的条目数后丢弃最近最少使用的向量。批量调用只向提供方索取缓存中尚不存在的文本。

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

挂载服务、注册提供方，然后调用批量嵌入。无论提供方以何种顺序作答，向量都按请求顺序返回。

```ts
ctx.plugin(Embeddings)
ctx.embeddings.registerProvider(['http'], provider)

await ctx.embeddings.embed({ texts: ['first', 'second'] })
// { spec: { provider: 'http', model: 'embed-model' },
//   vectors: [[…], […]], cached: 0, embedded: 2 }

await ctx.embeddings.resolve({ texts: [] })   // { provider: 'http', model: 'embed-model' }
```

`resolve` 是取默认值的一步，不调用任何提供方：省略的路由取唯一已注册者，省略的模型取提供方默认值。已注册多个路由却省略路由时以 `AMBIGUOUS_PROVIDER` 失败，而不是猜测。

### 配置

```yaml
- name: '@deepseek-ai/dsh-embeddings'
  config:
    maxCacheEntries: 1024
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxCacheEntries` | `1024` | 每个服务实例保留的向量数，超出后丢弃最近最少使用的一个 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-embeddings)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

注册是全有或全无：一批路由中若有一条已被其他提供方持有，注册即失败并保持注册表原样，因此被拒绝的注册绝不会只服务其中一部分路由。释放时精确释放该次注册取得的路由。

### 缓存

键是解析后的路由、产出该向量的模型与文本三者以不可能出现在任一部分中的分隔符连接后的 SHA-256，因此三者不会互相混淆。模型这一分量是提供方为该批报告的模型，而不是调用方所请求的那一个，因此由提供方以其回退服务的一批会存储在该回退名下，绝不会作为所请求模型的输出被读回。命中会重新插入，从而成为最近使用的键；超出上界时插入会丢弃第一个键，也就是最近最少使用的那个。同一批内的重复文本会全部发送——批量内的重复是提供方的事，不是缓存的事。

### 失败与恢复

提供方返回的向量数与请求数不一致时会被拒绝，而不是按位配对：偏短的答案会让此后每个文本悄悄对应到错误的向量。空批次直接作答，不调用任何提供方。不发布 invariant 伴生包：缓存是派生状态，其唯一权威是提供方，不存在可供核对的第二个独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-embeddings-http`](../embeddings-http/README.zh.md)——随包提供的 OpenAI 兼容提供方。
- [`dsh-llm`](../llm/README.zh.md)——本服务所效仿的同类模型调用注册表。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-embeddings)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无：嵌入服务不添加任何自身内容；由已注册的提供方决定向其后端发送什么。

#### KV Cache 影响

无：嵌入请求不携带会话前缀，因此一次批量不会使在线会话上的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅进程内缓存**——重启会重新嵌入每个文本；按文档的持久复用属于存放这些向量的索引。
- **批内不去重**——同一批内重复的文本会按出现次数各嵌入一次。
- **无提供方并发上限**——调用方同时发起多少批，就产生多少次后端请求。
- **不校验维度与模型**——服务原样返回提供方产出，并按提供方报告的模型缓存它，但不检查调用方在别处保留的向量是否同属一个模型或同一宽度；在同一语料里混用两个模型是调用方自己的错误。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

尚未接入消费者。预期的是 `dsh-session-query-sqlite` 中的向量通道，它也会让缓存对已索引文档的持久对应物变得多余。

</details>

---
description: "ctx.embeddings 的 OpenAI 兼容嵌入后端提供方：每批一次 POST，向量在线上边界处校验。"
kind: "package-reference"
---

# @deepseek-ai/dsh-embeddings-http

[English](README.md) | 中文

## 概述

`dsh-embeddings-http` 由一个 OpenAI 兼容后端服务 `ctx.embeddings` 的一个路由：每批向 `<baseURL>/embeddings` 发一次 POST，响应在任何向量进入缓存之前先被校验。后端地址与模型是必填配置，因为本包不假定任何嵌入模型名；bearer 密钥每批通过凭据接缝解析，因此轮换后的密钥能立刻用于下一次请求，而省略密钥则让请求不带认证，供不需要密钥的后端使用。响应格式即 DeepSeek 兼容网关、Ollama、vLLM 与 LM Studio 所提供的格式。

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

```yaml
- name: '@deepseek-ai/dsh-embeddings'
- name: '@deepseek-ai/dsh-embeddings-http'
  config:
    baseURL: 'https://embed.example/v1'
    model: 'text-embedding-model'
    apiKeyEnv: 'EMBEDDINGS_API_KEY'
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `route` | `http` | 本后端在 `ctx.embeddings` 上服务的路由 |
| `baseURL` | 必填 | 后端基址；会追加 `/embeddings`，并去掉末尾斜杠 |
| `model` | 必填 | 本后端服务的嵌入模型 |
| `fallbackModel` | 未设 | 主请求失败时重试一次的第二个模型；省略则快速失败 |
| `apiKey` | 未设 | 字面 bearer 密钥；优先用 `apiKeyEnv`，以免密钥进入配置文件 |
| `apiKeyEnv` | 未设 | 每批解析一次的凭据引用；不需要密钥的后端可省略 |
| `timeoutMs` | `30000` | 单次请求的截止时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-embeddings-http)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 线上契约

请求体为 `{ model, input }`，其中的模型取自解析后的 spec，因此调用方给出的 `model` 原样抵达后端。答案从 `data` 读取：带数值 `index` 的条目按其放置，不带者保持响应中的位置；未能覆盖每个请求文本的响应体会被拒绝。每个向量值在校验为数值之后才返回。

### 凭据解析

设置了 `apiKey` 时优先使用。否则，`apiKeyEnv` 在挂载了 `ctx.credentials` 接缝时经由该接缝解析，未挂载时经由启动环境解析；已配置的引用解析不到任何内容时以 `MISSING_CREDENTIAL` 失败，而不是发出未认证的请求。解析每批进行一次，因此进程运行期间存入的密钥无需重载即可用于下一次请求。

### 失败与恢复

被拒绝的 HTTP 状态会报告状态码与响应体的一段有界切片。响应体不是 JSON、没有 `data` 数组、遗漏某个文本、把索引放在批次之外，或带有非数值，全部以 `MALFORMED_RESPONSE` 失败——否则被部分读取的响应会被当作完整结果缓存下来。设置了 `fallbackModel` 时，主失败会让整批在备用模型下重试一次（每次尝试各有自己的 `timeoutMs`）；两者都失败时，错误同时写明两个模型与两次失败。不发布 invariant 伴生包：后端是向量的唯一权威，不存在可供核对的第二个独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-embeddings`](../embeddings/README.zh.md)——本提供方注册进的这项能力。
- [`dsh-llm-deepseek`](../llm-deepseek/README.zh.md)——本包所效仿凭据处理方式的同类提供方。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-embeddings-http)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型看到什么

每批一次请求，携带解析后的模型与待嵌入文本，形式即后端自身的 JSON 请求体。没有任何会话、提示词段落或工具模式抵达它。

#### Token 影响

受批次约束：后端对发送给它的文本计费，而共享缓存意味着同一文本在每个服务实例内至多发送一次。

#### KV Cache 影响

无：嵌入请求不携带会话前缀，因此不会使在线会话上的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每实例一个后端**——该路由上的每个文本都发往同一个基址与模型。
- **不重试**——失败的批次把结果报告给调用方，没有任何东西重发它。
- **无批次大小上限**——整批作为一次请求发送，不论大小；语料很大时由调用方切分。
- **自身不做代理配置**——使用启动器安装的进程级 dispatcher。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本包刻意假定 OpenAI 兼容格式，因为本仓库没有自有的嵌入模型；面向特定厂商的提供方应当是另一个包，而不是这里的一个分支。

</details>

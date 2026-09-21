---
description: "面向用户与维护者的 Models 登录伴随界面：在 API 密钥编辑器旁提供 OAuth 与交互式提供方登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-authorization

[English](README.md) | 中文

## Summary

`@deepseek-ai/dsh-client-ui-settings-authorization` 通过 `settings.models.provider-card` 席位，在 Models 页每张 `llm-pi-ai` 卡片内渲染登录伴随界面。页面本身拥有 API 密钥；本伴随界面拥有路由授权流程提供的其余登录方式——订阅的 OAuth、交互式密钥输入、账号选择——因此 Claude Pro/Max 订阅走 pi-ai 自带的流程登录，而不是用订阅从未签发的密钥。它通过 `authorization` Remote namespace 轮询自己打开的 attempt，呈现通知、提示与终态。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

本插件随 web profile 激活，无需配置：在 `llm-pi-ai` namespace 下注册一个 keyed 贡献，接收该家族的全部卡片。路由除 API 密钥外没有登录方式时，卡片不渲染任何内容。

### What the card shows

存有授权的路由显示已登录态与退出操作；没有的显示登录按钮——流程提供多种方式时显示方式选择器加按钮。对话框渲染每条通知及其登录链接与验证码、最新未答提示及其输入框、以及终态；关闭即撤回 attempt。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

本节解释伴随界面背后的设计；可观察行为已在 [Use this package](#use-this-package) 中完整覆盖。

### Design philosophy

伴随界面不持有共享状态：attempt 注册表在 Host，每张卡片只轮询自己对话框打开的 attempt。API 密钥方式被过滤掉，因为页面已经拥有它；第二个界面回答同一个 attempt 会替别人答题，因此对话框从不共享 attempt id。

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 插件入口：locale 注册与 keyed 席位贡献 |
| [`src/client/SignInCard.tsx`](src/client/SignInCard.tsx) | 卡片、对话框与可作答提示的推导 |
| [`src/client/operations.ts`](src/client/operations.ts) | 卡片调用的 Host 操作，以注入回调形式 |
| [`src/client/locales.ts`](src/client/locales.ts) | 类型化的文案字典 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Models page](../ui-settings-models/README.zh.md) — 声明本伴随界面所填席位的分区。
- [authorization Remote](../../credentials/authorization-remote/README.zh.md) — 本伴随界面轮询的 Host namespace。
- [Configure models](../../../docs/user/guide/providers.zh.md) — 从用户视角看登录流程。

-----

<a id="model-experience"></a>
## Model Experience

无。授权是配置时与人的对话，没有任何流程、通知或提示进入模型请求。

#### KV Cache effect

无失效；授权状态不进入请求前缀。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **轮询而非流**——对话框运行时约每秒轮询一次自己的 attempt。
- **一张卡片跟随一个 attempt**——第一页登录时，第二页打开同一记录会收到 `in-flight`，直到前者结算。
- **API 密钥方式留在页面**——伴随界面过滤掉它们，只提供密钥的流程在这里不渲染任何内容。

**Runtime invariant:** 不发布 companion。卡片经 Remote namespace 从 Host attempt 注册表推导一切；不存在可分歧的第二观察。

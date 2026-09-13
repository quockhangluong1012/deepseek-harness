---
description: "面向用户与维护者的 authorization Remote owner：将凭据登录流程暴露给浏览器界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-authorization-remote

[English](README.md) | 中文

## Summary

`@deepseek-ai/dsh-authorization-remote` 是 `authorization` Remote namespace 的 Host owner：浏览器界面驱动 `ctx.authorization` 对话的一半。登录流程是一段对话——Host 展示一个页面，人回答一个问题——而一次 Remote 调用是一个请求产生一个结果。本服务用 attempt 桥接两者：`begin` 打开一个 attempt 并在后台运行流程，`frames` 按 cursor 轮询对话，`answer`/`decline` 结算一个待答提示。Models 页的登录伴随界面渲染这些 frames；seam 自身的流程（例如 `llm-pi-ai` 的提供方登录）保持不动。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

当组合需要服务可登录提供方流程的浏览器界面时挂载本插件——订阅的 OAuth、交互式密钥输入、账号选择。它需要 `authorization` seam 与凭据提供方；流程本身由知道如何获取各自凭据的插件注册。

### The attempt protocol

一次登录走四个调用：

1. `begin(key, method?)` 打开 attempt 并在后台运行流程，返回 `{ attemptId, key, label, method }`。
2. `frames(attemptId, cursor)` 返回 `cursor` 之后的对话——通知、提示、撤回与终态——以及下一次轮询用的 `next` cursor。
3. `answer(attemptId, promptId, value)` 回答一个待答提示；`decline(attemptId, promptId)` 拒绝它，attempt 以 `cancelled` 结算。
4. `cancel(key)` 从第二个调用撤回某记录正在运行的 attempt，供 Cancel 按钮在不持有首次调用的情况下作答。

`list()` 与 `describe(key)` 为选择器报告已注册流程，`status(key)` 只报告是否存有授权（绝不透露其内容），`signOut(key)` 忘记它。登出只删除本地记录，不通知发行方。

### Failures

每次拒绝都带有命名空间化的 code：无法运行的 `begin` 返回 `authorization/no-flow`、`authorization/unknown-method`、`authorization/in-flight`；寻址不到可作答内容的后续调用返回 `authorization/unknown-attempt`、`authorization/unknown-prompt`、`authorization/inactive-prompt`。畸形 id 以 `gateway/bad-request` 失败。抛错的流程把自己的诊断带在 attempt 的 failed outcome frame 上，而不是让某个调用失败。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

本节解释该 namespace 背后的设计；可观察行为已在 [Use this package](#use-this-package) 中完整覆盖。

### Design philosophy

除 attempt 注册表外，本 namespace 不持有自己的对话状态：流程生命周期与提交契约归 seam 所有，本服务只在 seam 的交互回调与 wire frames 之间翻译。提示答案只从浏览器流向 Host；已存凭据值不经过任何方法——`status` 用 `describeRecord` 回答一个布尔值，界面键入的提示答案只保留到流程消费为止。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`AuthorizationRemoteService` 及其 attempt 注册表 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 wire 词汇：流程视图、frames、提示、终态 |

### Registration and lifecycle

本服务注册 `authorization` namespace，每个记录沿用 seam 的单 attempt 槽：运行时第二个 `begin` 被拒绝而不是加入，因为两个界面会让两个人回答同一流程的问题。Attempt 在结算后保留供迟到轮询，超过五十个后按最旧优先、已结算优先逐出。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-authorization](../authorization/README.md) — 本 namespace 所对话的流程注册表。
- [Credentials subsystem](../../../docs/subsystems/credentials.md) — 记录存储与 `authorization/settled` 事件。
- [Configure models](../../../docs/user/guide/providers.md) — 本 namespace 所服务的登录界面。

-----

<a id="model-experience"></a>
## Model Experience

无。授权是配置时与人的对话，没有任何流程、通知或提示进入模型请求。

#### KV Cache effect

无失效；授权状态不进入请求前缀。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **轮询而非流**——界面轮询 `frames` 获取对话。一次登录持续数秒且 frames 很少，一次往返好过第二种传输；流式投影只会搬运同一个 cursor。
- **一个 attempt 一个界面**——两个页面跟随同一个 `attemptId` 都能渲染其 frames，但先答者胜，后者读到 `unknown-prompt` 或 `inactive-prompt`。seam 的单键单 attempt 规则保证两个人不会互答对方的问题。
- **保留五十个 attempt**——超过上限的迟到轮询读到 `unknown-attempt`。Attempt 很小且登录很少见；上限只是防止被遗忘的页面撑大注册表。
- **不撤销**——`signOut` 只忘记本地记录而不通知发行方，与 seam 自身的登出语义一致。

**Runtime invariant:** 不发布 companion。attempt 注册表是本服务的内部状态：frames 派生自 seam 自身的生命周期，不存在可分歧的第二观察。

# Agent Note: Credentialed LLM fetch rejects redirects

Status: implemented

[English](2026-09-13-credentialed-llm-fetch-rejects-redirects.md) | 中文

## Problem

DeepSeek chat-completions 调用与 Files API 客户端通过共享 `fetch` 携带 bearer key，且使用默认重定向模式（`follow`）。恶意或被攻破的网关可以返回 307/308，将请求指向攻击者 origin；key 是否随后续请求发送，取决于 undici 的跨 origin 头剥离行为，而本仓库既未锁定也未测试该行为。静默的 key 外泄绝不能依赖传输层内部实现。

## Decision

两个携带凭据的调用点均传入 `redirect: 'error'`：`packages/llm/llm-deepseek/src/adapter.ts` 中的 chat-completions `fetch`，以及 `packages/llm/llm-deepseek/src/files-api.ts` 中的 `DeepSeekFilesClient.request`（覆盖 upload、list、retrieve、delete 与 file-store 路径）。3xx 现在表现为 `TRANSPORT` 失败——按 misconfiguration 策略大声失败。没有合法流程会重定向：base URL 由部署方配置，Files API 也没有带 CDN 重定向的内容下载路径。

## Alternatives considered

**改为在重定向时剥离 Authorization。** 既保留重定向可用，又保护 key——但要在用户态重新实现传输层行为，需要逐次比较重定向 origin，且保留了跟随行为。落选：代码更多，保证更弱。

**允许同 origin 重定向。** 保留对尾斜杠或协议升级重定向的容忍——但这些 provider 端点从不重定向，origin 比较代码将服务于不存在的情形。落选：YAGNI。

## Consequences

对这些端点实施合法重定向的网关或代理，现在会使每次 LLM 调用以 `TRANSPORT` 失败，而不是静默跟随——符合预期：此类部署属于 misconfiguration，应当修复，而非静默跟随。收益：无论传输层如何剥离头，bearer key 都无法离开所配置的 origin。

## Testing

`files-api.spec.ts`（"fails loud on a gateway redirect instead of carrying the bearer key cross-origin"）：本地 307 网关指向本地攻击者服务器；断言 `TRANSPORT` 拒绝、攻击者零命中、未观测到 auth 头。经 stash 对照验证：修复前红、修复后绿。`adapter.spec.ts`（157 个测试）与 `files-api.spec.ts`（50 个测试）通过；该包作用域内 `tsc --noEmit` 干净。

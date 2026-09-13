# Agent Note: Credentialed LLM fetch rejects redirects

Status: implemented

English | [中文](2026-09-13-credentialed-llm-fetch-rejects-redirects.zh.md)

## Problem

The DeepSeek chat-completions call and the Files API client carry a bearer key through shared `fetch` with the default redirect mode (`follow`). A malicious or compromised gateway can answer 307/308 to an attacker origin; whether the key travels with the follow-up depends on undici's cross-origin header-stripping, which this codebase neither pins nor tests. Silent key exfiltration must not hinge on transport internals.

## Decision

Both credentialed call sites pass `redirect: 'error'`: the chat-completions `fetch` in `packages/llm/llm-deepseek/src/adapter.ts` and `DeepSeekFilesClient.request` in `packages/llm/llm-deepseek/src/files-api.ts` (which covers upload, list, retrieve, delete, and the file-store path). A 3xx now surfaces as a `TRANSPORT` failure — fail loud, per the misconfiguration policy. No legitimate flow redirects: the base URL is operator-configured and the Files API has no content-download-with-CDN-redirect path.

## Alternatives considered

**Strip Authorization on redirect instead.** Keeps redirects working while protecting the key — but re-implements transport behavior in userland, needs per-redirect origin comparison, and leaves follow behavior intact. Lost: more code for a weaker guarantee.

**Allow same-origin redirects.** Preserves tolerance for trailing-slash or protocol-upgrade redirects — but these provider endpoints never redirect, so the origin-comparison code would serve a case that does not occur. Lost: YAGNI.

## Consequences

A gateway or proxy that legitimately redirects these endpoints now fails every LLM call with `TRANSPORT` instead of working — intended: such a deployment is misconfigured and must be fixed, not silently followed. Gained: the bearer key cannot leave the configured origin regardless of transport header-stripping behavior.

## Testing

`files-api.spec.ts` ("fails loud on a gateway redirect instead of carrying the bearer key cross-origin"): a local 307 gateway points at a local attacker server; the test asserts `TRANSPORT` rejection, zero attacker hits, and no observed auth header. Verified red pre-fix via a stash control and green post-fix. `adapter.spec.ts` (157 tests) and `files-api.spec.ts` (50 tests) pass; scoped `tsc --noEmit` on the package is clean.

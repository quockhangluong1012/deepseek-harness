# Agent Note: §14 goes live on OpenRouter with a provider-level model fallback

Status: implemented

English | [中文](2026-09-14-openrouter-embeddings-fallback.zh.md)

## Problem

§14 (Active Memory Sub-Agent) was fully built but inert in every deployment: `active-memory-context` searches only the vector channel, and no bundle mounted an embeddings provider, so every search degraded to no results. Unblocking it needed two decisions the specification does not answer: which embedding endpoint a DeepSeek-centered harness should call (DeepSeek publishes no embeddings endpoint, so the key cannot be shared), and what happens when that endpoint is down — the `:free`-tier models the deployment chose are the least reliable ones.

## Decision

Mount three rows in the web-app bundle, after the autonomy slice: the `embeddings` registry (bare row; every tunable defaulted), `embeddings-http` pointed at `https://openrouter.ai/api/v1` with primary `nvidia/llama-nemotron-embed-vl-1b-v2:free`, fallback `nvidia/nemotron-3-embed-1b:free`, and `apiKeyEnv: OPENROUTER_API_KEY`, and `active-memory-context` with `maxBytes: 16384` (the convention the two already-mounted context packages use). The key resolves from the launching environment per batch, so booting without the key is safe — the vector channel degrades to no results until the key appears. The 0.7 relevance threshold stays calibrated for the primary model; switching models means recalibrating it.

`fallbackModel` is a new optional field on the HTTP provider, not a second mounted row: two rows cannot serve one route (the second boot would fail `DUPLICATE_PROVIDER`), and a second route would be dead because every consumer resolves the default. On any primary failure the whole batch retries once under the fallback model, each attempt with its own `timeoutMs`; when both fail the error names both models and both failures. Stored vectors stay keyed by model, so a fallback vector can never be read as a primary one.

## Alternatives considered

**An OpenRouter `models` array for fallback.** It does not exist for the embeddings endpoint — only `provider.allow_fallbacks` (same model, backup providers), which the provider does not send. Hence the retry lives one layer up, in the provider.

**Retrying only retryable statuses.** Classifying 429/529/5xx versus 401/402/404 would avoid doubling doomed calls, but every classifier branch needs a test and the doubled call only materializes when the endpoint is already broken. Retry-once on any failure, documented as such.

**Switching active-memory to the hybrid channel so §14 works without embeddings.** The keyword leg needs no vectors, but RRF scores are not cosine similarities, so the 0.7 threshold would filter everything. That is a threshold redesign, a separate phase, not part of this mount.

## Consequences

`embeddings-http` grows 4 tests (24 total) and stays at 100% statements and branches. `verify-cordis-config` passes with the three new rows; the boot lane covers the composition. The per-turn cost accepted earlier stands: one query embedding plus one vector search per eligible turn.

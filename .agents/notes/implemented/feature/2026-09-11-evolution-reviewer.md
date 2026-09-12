# Agent Note: Evolution Reviewer — Buffered Turns, Gated Extraction, Rebuild

Status: implemented

English | [中文](2026-09-11-evolution-reviewer.zh.md)

## Problem

The evolution store shipped without a writer: no package indexed produced files, derived lessons from turns, or rebuilt documents from history. Copying the workspace-memory extractor verbatim was blocked twice over: its per-turn backward scan reads session history through `ownEvents()`, which new production code may not call, and its whole-document `setMemory` has no counterpart in the two-tier lessons/profile store with approval staging.

## Decision

Ship `@deepseek-ai/dsh-evolution-reviewer` in the `evolution/` group behind `ctx.evolutionReviewer`, following the [evolution-memory store decision](2026-09-11-evolution-memory-store.md). The reviewer buffers the current turn's admitted rows and tool outcomes per session as `session/event` delivers them and flushes at `turn/end`: output indexing always runs, extraction runs when `enabled`, the admitted text clears `minTurnTextBytes`, the per-scope cooldown elapsed, and a route resolves from the configured pair or the session's folded request header. Scopes resolve from workspace membership under a configured `profile` (default `default`). Extraction calls run at `temperature: 0` with `purpose: 'evolution-review'` and rewrite the whole lessons document with `background_review` provenance — directly, or staged as a `setLessons` op when `writeApproval` is on. Over-budget output clips to the store's own `too-large` cap before one retry, flagged `truncated`. `rebuild` pages history newest-first through `sessionQuery.filterEvents`, skips archived sessions, drops the oldest rows past `maxInputBytes` while keeping a lone over-budget row whole, and always writes directly with `rebuild` provenance, rejecting loudly without a route, without the query seam, or for global and unknown scopes. One scope never runs two extractions at once; teardown and session disposal abort in-flight calls. Usage attributes through the `evolution-review` purpose on the request itself: neither the usage ledger nor the token meter carries a task hook, so no separate ledger write exists.

## Alternatives considered

- **Mirroring the workspace extractor's backward history scan.** Rejected: new calls to `ownEvents()` are prohibited, and the prohibition's prescribed pattern is exactly what shipped — maintain the turn buffer incrementally from delivered events and read history through an explicit asynchronous seam.
- **Falling back to live sessions when `sessionQuery` is absent.** Rejected: the only live fallback reads through the same prohibited synchronous readers. Rebuilds fail loud with `evolution/extraction-failed` instead, which the web composition never hits.
- **Writing the user profile from the same extraction.** Rejected for v1: the prompt returns one document under the Purpose/Preferences/Decisions/References headings and the store's profile tier stays hand-authored; splitting one model output across two documents would invent a framing protocol the spec does not define.
- **Defer queues and subagent review forks now.** Rejected for v1: the per-scope promise chain already serializes overlapping turns, and delegated review with tool whitelists is a separate capability with its own trust surface; the README carries both as deferred work.
- **Importing lesson/subject types through the store's `/types` subpath.** Rejected after the Cordis catalog generator refused it: cross-package type references resolve through the owning package root, so the reviewer imports `EvolutionScopeId`, `EvolutionExtraction`, and `EvolutionOutput` from `@deepseek-ai/dsh-evolution-memory` directly.

## Consequences

Scopes with the reviewer mounted accumulate lessons and a produced-file index at one bounded model call per gated turn, with background writes stageable for approval and rebuilds available on demand. Turns in flight while the reviewer mounts extract from their observed suffix, and rebuilds depend on the session query seam being mounted. The reviewer owns no durable state: buffers and chains are scheduling, and disposal clears them.

## Testing

The 26-case reviewer spec pins file indexing across the full tool-argument matrix, scope resolution including directory fallback, route precedence and routeless skips, trivial/cooldown gating, max-tokens tolerance with prior-document preservation across error, aborted, tool-call, and foreign-finish failures, cap clipping with truncation flags, approval staging with later application, per-scope serialization with superseded-chain drops, disposal aborts, newest-first rebuilds skipping archived sessions, rebuild rejection without route/query/scope, and post-teardown silence over the real storage/domain stack, holding per-file 100% on statements, branches, functions, and lines. The config spec pins pair validation, profile validation, prompt framing, and UTF-8 clipping boundaries.

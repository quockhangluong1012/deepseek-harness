# Agent Note: Proactive per-turn memory search (evolutionary harness spec §14)

Status: implemented

English | [中文](2026-09-13-active-memory-sub-agent.zh.md)

## Problem

Spec §14 (Active Memory Sub-Agent) wants proactive retrieval: before each turn's response, search memory keyed to the user's own message, filter by a relevance threshold, inject the top-k survivors. The closest existing mechanism, `dsh-evolution-memory-context`, injects a durable per-scope brief (instructions/lessons/profile) gated by a content digest — the same text every turn until the record changes, never dependent on what the user just asked. That is a genuinely different mechanism, not a variant of the same one.

## Decision

Built `@deepseek-ai/dsh-active-memory-context` as its own package: an `agent/pre-step` listener that reads the step's own proposed messages (never a brief another listener already appended), resolves workspace membership the same way the sibling package does, and calls `ctx.sessionQuery.searchSessionsSemantic` scoped to the workspace's *other* sessions — the current session is always excluded, so a turn can never surface its own just-submitted message as "relevant memory." Survivors past a relevance threshold render into one framed `user/message`, appended to the step.

### The relevance-threshold contract change

Spec §14's `relevance_score >= threshold` gate cannot be built against `SessionSearchHit` as it stood: that type deliberately carries no numeric score, because `searchSessionsHybrid`'s reciprocal-rank-fused output blends two channels with incomparable magnitudes (a decision from this same session's earlier §15 work). But `searchSessionsSemantic` — the single-channel method, never fused — has exactly one meaningful number: cosine similarity against one embedding model's own vectors, comparable within one deployment's own configured provider.

Widened only that one method's return type to `SemanticSessionSearchHit` (`SessionSearchHit & { score: number }`), leaving `searchSessionsHybrid` and its fused `SessionSearchHit[]` untouched — the "no provider-specific number" decision stays intact exactly where it was made for. This is a real, if narrow, contract change: every implementation of the abstract `searchSessionsSemantic` (the concrete SQLite engine plus 11 test doubles across `session-query`, `tool-session-query`, `subagent`, `tool-subagent-control`, `session-controller`, `session-reference`, `experimental/agent-team`, `experimental/tool-agent-team`, two benchmark workers, and one CLI test fixture) needed its return-type annotation updated. All 11 doubles were trivial-reject bodies never constructing a real hit, so the fix was purely a type-annotation change plus one unused-import removal per file — no behavior changed anywhere but the concrete SQLite engine, which now threads the cosine score it already computed (and previously discarded) through to the caller.

### Self-exclusion and workspace scoping

Searching a session for itself mid-turn would trivially "find" the just-submitted message as a near-perfect match — pure noise, not memory. `others = scopeIds.filter(id => id !== session.id)` makes this structurally impossible rather than relying on the model or an operator to notice. Scoping to the current workspace (not a global search) is the same privacy boundary `dsh-evolution-memory-context` already draws; a session outside any workspace gets no active memory rather than an unscoped cross-tenant search.

### Cost discipline

A nearest-neighbor vector search always answers with its closest candidates, however distant — there is no "no match" outcome built into cosine similarity, so `topK` alone would silently inject off-topic noise on an off-topic turn. `relevanceThreshold` (default 0.7, matching the spec) is the quality gate that makes irrelevance detectable. `turnInterval` (default 1, matching spec's literal "before every response") throttles the embedding-call cost the same way the sibling package's nudge intervals do, and a `searchedForTurn` map prevents a retried step for the same observed turn from re-running the search and re-injecting.

## Alternatives considered

**Extend `dsh-evolution-memory-context` instead of adding a package.** It is the closest existing mechanism, but the two have independently evolving triggers — one reacts to a memory *write* (digest changes), the other to *turn content* (every turn, regardless of whether anything was ever written to `evolutionMemory`) — and independent data sources: static per-scope curated fields versus raw session-history search. Folding both into one package would mean one file juggling two unrelated cache-invalidation stories, a violation of "one clear purpose" per capability seam.

**Carry the score on `SessionSearchHit`, and therefore on `searchSessionsHybrid`'s fused output.** Rejected: the scoreless shape is exactly what keeps reciprocal-rank fusion from being read as comparable magnitudes, and that decision was made for `searchSessionsHybrid`. Only `searchSessionsSemantic` — single-channel, never fused — has one meaningful number, so only its return type widened to `SemanticSessionSearchHit`.

**Search the whole store rather than the current workspace.** Rejected: workspace scoping is the same privacy boundary `dsh-evolution-memory-context` already draws, so a session outside any workspace gets no active memory instead of an unscoped cross-tenant search.

**Inject the top-k hits with no relevance gate.** Rejected: a nearest-neighbor vector search always answers with its closest candidates, however distant — cosine similarity has no built-in "no match" — so `topK` alone would silently inject off-topic noise on an off-topic turn. `relevanceThreshold` (default 0.7) is what makes irrelevance detectable.

## Consequences

- The path is bounded at both ends: one embedding-backed search per `turnInterval` turns, and only hits at or above `relevanceThreshold` (default 0.7) survive — an off-topic turn adds nothing rather than its nearest anyway-distant neighbors.
- Injection is a single framed `user/message` appended to the step the listener already inspected; no other part of the step is rewritten.
- A session outside any workspace gets no active memory at all — the cost of keeping the search inside the privacy boundary `dsh-evolution-memory-context` draws.
- `searchSessionsSemantic` now returns `SemanticSessionSearchHit`, so every implementer carries the wider annotation (the concrete SQLite engine and 11 test doubles), while `searchSessionsHybrid` and its `SessionSearchHit[]` keep their scoreless contract.
- The package adds no persisted state: its only bookkeeping is the in-memory `searchedForTurn` map that stops a retried step from re-searching and re-injecting the same observed turn.

## Verification

- `packages/session-query/session-query/tests` and every touched test-double package: full suite green, only the 7 pre-existing `usage-ledger`/`evolution-memory-context` errors remain in `pnpm run typecheck`.
- `packages/context/active-memory-context`: 27 tests (5 pure render tests, 22 engine tests against a real `SqliteSessionQueryEngine` + `JsonlSessionPersistence` + a bag-of-words fake embeddings service), 100% coverage on all four measures.
- One coverage-driven restructuring: merging the "cwd unresolvable" and "cwd resolves to no workspace" early returns into a single `if` around a ternary fixed a `@vitest/coverage-v8` branch-attribution artifact on two adjacent no-else `if` blocks at a function's tail — the merged shape reports cleanly and reads no less clearly.

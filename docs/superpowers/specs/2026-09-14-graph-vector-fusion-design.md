# Design: Graph+vector fusion through active-memory (§17)

Date: 2026-09-14 Status: approved — awaiting spec review before implementation plan Decisions locked: heartbeat-batch extraction · active-memory pre-step consumer · query-time label bridge

## Background

Spec §17 wants vector search (discover) fused with graph search (navigate). The repository already owns every part except two: `evolution-graph` has a store and query API (`find`/`expand`/`answer`, read via `/graph`) but no production producer — nothing ever calls `observe`, so every graph is empty forever; and graph nodes/edges record no session they were read from, so entity results cannot join session hits directly. The §15 RRF fusion helper (`fusion.ts`) exists and is reused, not reinvented.

## Producer: heartbeat extraction in `evolution-graph`

A heartbeat task `evolution-graph-extract` (`intervalHours`, default 6, same as dreaming) runs per scope. It reads a `lastExtractAt` watermark from an `extract-state` table in the same storage domain; a scope with no new sessions is skipped with zero LLM cost. Otherwise it collects the new session texts, makes one LLM call with the existing `extractionSystemPrompt()`, parses with the existing `parseTriples`, and writes via `observe`. The `maxNodes` / `maxEdges` caps in `observe` already drop instead of throwing, so no new guard is added. The existing `extract` path touches `ctx.llm` without declaring it; this change adds `'llm'` to the service's static inject (a latent wiring bug an independent review already flagged). Out of scope: relation-quality scoring, cross-scope entities, re-extraction of already-extracted sessions (the watermark makes extraction append-only).

## Consumer: graph leg in `active-memory-context` pre-step

After the existing vector leg — and regardless of whether it returned hits, pre-step handler runs: `find(scope, query)` takes the single top-ranked entity as the only seed, `expand(entity, depth)` for neighbor labels (plus the entity itself), one FTS session search over those labels limited to scope siblings, then RRF-merge of the resulting session ids with the vector hits (reusing `fusion.ts`), and the existing brief renderer. Graph access is optional via `ctx.get`: unmounted or empty graph returns `[]` and behavior equals today. Two new defaulted Config fields: `graphDepth` (default 1), `graphLimit` (default 5).

Out of scope: a new engine method (no caller would exist), `/graph` output changes, threshold redesign for RRF-vs-cosine scales (the merge reuses RRF scores as-is; the vector-leg cosine threshold is untouched).

## Error handling

Producer failures (LLM error) propagate to the heartbeat runner, following the dreaming pattern; malformed triples are skipped-and-counted inside `observe` already. The consumer leg never blocks a turn: any failure returns `[]`, mirroring the vector leg's `SessionQueryError` catch. Added per-turn cost is one in-memory `find` plus one or two SQLite FTS queries — no LLM call, no new embedding beyond the existing vector leg.

## Testing

Producer: heartbeat registration, extraction against a fake `llm`, watermark skip asserting no LLM call for idle scopes, malformed-triple tolerance. Consumer: a fake graph with entities proves briefs include neighbor-mentioned sessions; unmounted-graph and empty-graph passthroughs. Keyless throughout; 100% statements/branches per the repository coverage gate.

## Alternatives rejected

Per-edge source sessions (`sessions[]` on edges): precise but needs a stored-record migration, write amplification, and a cap policy. Separate side-index domain: same benefit with an extra package plus a follow-the-graph sync problem. Both lose to the label bridge, which needs no migration and reuses `find`/`expand`/FTS/`fusion.ts`; its fuzziness (label-substring matching) is honest for a recall-enrichment leg.

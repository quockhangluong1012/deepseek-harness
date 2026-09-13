# Comparisons — cross-locus reconcile (Step 6)

All 4 interim positions agree; apparent conflicts resolve by scope, not by picking winners.

## A × B — store vs reviewer (L1 core)

- A: memory writes gated; recordOutputs store-side idempotent newest-first.
- B: observeTurn always-indexes before gating extraction; enabled:false still indexes.
- Reconciled: **single rendezvous (turn/end), dual gates.** Order is load-bearing: index→recall→gate. No contradiction — A describes storage semantics, B describes scheduling. Draft MUST present them as one sequence diagram, not two sections.

## B × D — extraction gate vs brief gate (L1 × L3)

- B: extraction admits only human user + assistant text; injected context never feeds back.
- D: brief injects only on digest change; injected briefs never re-enter transcripts (same admission rule) or recall.
- Reconciled: **feedback loop is closed by construction.** Lessons flow record→brief→model→turn→(admission filter)→extraction→record, and the filter is the same predicate at both ends. No runaway self-amplification.

## C × A — timeline vs store (L2)

- C: timeline is pure read model; no table, no writes.
- A: stamps (UpdatedAt/addedAt/at/createdAt/resolution.at) are the only temporal facts.
- Reconciled: **every timeline row traces to exactly one stamp.** Table in report: stamp → delta kind → bucket rule. Fallback chain (stamps → lastExtraction → memoryUpdatedAt) must be stated to avoid "missing days" confusion.

## C × D — governance surfaces (L5)

- C: /memory vs /skills split; skill-kind approve redirected; skill approve drops only after file write.
- D: createdBy agent only on background_review; foreground user-directed; adopt manual; pin blocks delete/transitions.
- Reconciled: **two queues, one ledger philosophy.** Memory queue edits the record; skill queue edits files then drops the entry. Draft presents side-by-side table.

## D × B — recall vs transcript (L3)

- D: recall is one 'Recall:' context item, rendered last, drops first.
- B: recall query from newest human message, recallLimit 20, same admission rule, no-seam→no-item.
- Reconciled: **recall is the weakest memory tier by design** (first dropped, single slot, replaced on change). Do not oversell it as "long-term memory".

## Global synthesis (feeds Step 11)

Three nested time loops (D's position adopted as framing):
1. **Turn loop** (seconds): pre-step brief → turn → indexOutputs → maybe-extract (defer-bounded).
2. **Day/week loop**: approvals (/memory, /skills) → resolutions ledger → journey buckets → capacity pressure.
3. **Month/quarter loop**: curator transitions/consolidation → trajectory exports → scorer triple → outer-loop training data.
Connective tissue: digest (loop 1), stamps+ledger (loop 2), telemetry+backups (loop 3). Machine-local $DSH_HOME throughout; web-app-only composition.

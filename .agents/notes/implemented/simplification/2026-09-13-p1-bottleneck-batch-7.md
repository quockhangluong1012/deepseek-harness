# Agent Note: P1 bottleneck analysis batch 7

Status: implemented

English | [中文](2026-09-13-p1-bottleneck-batch-7.zh.md)

## Problem

Batch 7 of the full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`), dated 2026-09-13, covered the P1 bottleneck findings. It shipped one documentation correction and triaged the remaining findings without a code change, recording the evidence that made each of them not worth a point fix now.

## Decision

`guard/budgets`: the `maxToolCalls` documentation is corrected from "completed" to "dispatched" — the module JSDoc, the `Config` field, the `TurnFacts` comment, and the `README.md` + `README.zh.md` table, yaml, and prose. The counter reads `tool/call` (dispatch); for spend control that is the conservative correct meter (the model already ran to produce the call), so the docs — not the code — were wrong. No behavior change; 13/13 tests pass.

## Alternatives considered

- **Changing the counter instead of the docs:** rejected. Metering on completion would silently re-tune every deployed budget.
- **`deriveMessages` per-call spread: documented micro-cost.** The doc block (session `index.ts:823-830`) already states the contract: O(new) derivation, shared frozen messages, fresh array per call. The per-call spread copies references (sub-ms even for huge transcripts), and the fresh array is what lets callers sort/filter safely. A shared frozen view risks caller-mutation bugs for no measured gain.
- **`budgets` per-step replay: refuted.** `tokenMeter.measure` folds incrementally (`while (state.consumedEvents < session.seq)`, token-meter `index.ts:231`) — only new events are priced per call.
- **Corpus `load()` list-first: deferred.** For present sessions the full-log read dominates the list scan; the list also supplies the `SESSION_QUERY_SESSION_NOT_FOUND` taxonomy and the header-compat race check. Removing it forces reworking the exact-read cancellation tests (which pin list-based flow via `listOverride`) for savings measurable only on missing-key probes.
- **`structuredClone` in `load()`/`snapshotLive`: deferred pending per-backend aliasing proof.** Live-path clones are REQUIRED (shared mutable log); the cold-path clones are suspect-waste only if `readColdSessionLog` returns fully-owned structures on every backend — unproven per backend, and removing them risks consumer mutation of cached state.
- **Session `list()` rescan: deferred to a follow-up spec.** It needs an index/memo design with a revision story, not a point fix.
- **SSE incremental `block-end`: deferred pending TTFT measurement.** Reordering stream timing without a measurement harness risks subtle consumer bugs for faith-based gain (deferred from batch 3 for the same reason).

## Consequences

The `guard/budgets` documentation now matches the dispatch-time meter the code implements, with 13/13 tests passing and no behavior change. The accepted cost is that the rest of the batch ships untouched, and four of its findings are deferred rather than closed: the corpus `load()` list-first removal and the cold-path `structuredClone` removal wait on evidence (missing-key-only savings; per-backend aliasing proof), the session `list()` rescan waits on an index/memo design with a revision story in a follow-up spec, and the SSE `block-end` reorder waits on a TTFT harness. The `deriveMessages` spread stays a documented micro-cost, and the `budgets` per-step replay is refuted outright.

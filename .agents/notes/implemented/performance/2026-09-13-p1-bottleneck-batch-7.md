# P1-bottleneck analysis batch 7

- Date: 2026-09-13
- Batch: 7 of full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`)

## Code changes

1. `guard/budgets`: `maxToolCalls` documentation corrected from "completed"
   to "dispatched" (module JSDoc, Config field, TurnFacts comment,
   README.md + README.zh.md table/yaml/prose). The counter reads
   `tool/call` (dispatch); for spend control that is the conservative correct
   meter (the model already ran to produce the call), so the docs — not the
   code — were wrong. Changing the counter instead would silently re-tune
   every deployed budget. No behavior change; 13/13 tests pass.

## Triaged without code change (with evidence)

- **deriveMessages spread: documented micro-cost.** The doc block (session
  `index.ts:823-830`) already states the contract: O(new) derivation, shared
  frozen messages, fresh array per call. The per-call spread copies
  references (sub-ms even for huge transcripts), and the fresh array is what
  lets callers sort/filter safely. A shared frozen view risks caller-mutation
  bugs for no measured gain.
- **budgets per-step replay: refuted.** `tokenMeter.measure` folds
  incrementally (`while (state.consumedEvents < session.seq)`,
  token-meter `index.ts:231`) — only new events are priced per call.
- **corpus `load()` list-first: marginal gain, real rework risk.** For present
  sessions the full-log read dominates the list scan; the list also supplies
  the `SESSION_QUERY_SESSION_NOT_FOUND` taxonomy and the header-compat race
  check. Removing it forces reworking the exact-read cancellation tests (which
  pin list-based flow via `listOverride`) for savings measurable only on
  missing-key probes. Deferred.
- **structuredClone in `load()`/`snapshotLive`: aliasing proof burden.**
  Live-path clones are REQUIRED (shared mutable log). Cold-path clones are
  suspect-waste only if `readColdSessionLog` returns fully-owned structures
  on every backend — unproven per backend; removing them risks consumer
  mutation of cached state. Deferred pending per-backend aliasing proof.
- **session `list()` rescan: structural.** Needs an index/memo design with a
  revision story, not a point fix. Deferred to a follow-up spec.
- **SSE incremental `block-end`: needs TTFT measurement.** Reordering stream
  timing without a measurement harness risks subtle consumer bugs for
  faith-based gain (deferred from batch 3 for the same reason).

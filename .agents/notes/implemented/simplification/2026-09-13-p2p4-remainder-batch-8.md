# Agent Note: P2-P4 remainder batch 8

Status: implemented

English | [中文](2026-09-13-p2p4-remainder-batch-8.zh.md)

## Problem

Batch 8 of the full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`) covered the remaining P2–P4 findings. The review split them into small behavior-preserving fixes that could land immediately under TDD, and program-scale work whose size it quantified rather than attempted in this batch.

## Decision

Five fixes shipped, TDD where behavior changes:

1. `llm-fallback/README.md`: the stray "yet" that broke the `verify-package-invariants` reason-sentence regex was dropped (`published` must meet `[.:;—]` immediately). Gate green (39 conform).
2. `schedule/runtime.ts`: the local `MAX_TIMER_DELAY_MS` was replaced with a re-export from `@deepseek-ai/dsh-timeout` (+dep/tsconfig); 26/26 tests.
3. `skill/tool-skill`: `shell.timeoutMs`/`shell.outputMaxChars` are now validated `Config` fields (schema defaults = the old constants); `resolveShell`/`capShellOutput` take resolved values with skill metadata winning. 4 new tests (2 shape updates); 71/71 skill tests pass; the `verify-no-hardcoded-tunables` gate is green.
4. `workspace`: the dead `create(path, title?)` parameter was removed per its TODO (the capability survives via `entity.setTitle`); 3 tests were reworked to the new contract; the README pair was updated including Dev-Note/ToC removal. (`tsc` proves no other callers; the suite is blocked only by a Windows symlink EPERM in fixture setup — environmental.)
5. `usage-ledger/aggregate.ts`: `addSample` reuses `addModelOnly` (a 22-line self-clone gone); 52/52 tests.

## Alternatives considered

- **Deleting the ~197 `.d.ts` twins outright:** rejected as a follow-up program. The twins (e.g. `llm/types.d.ts` vs `types.ts`, semicolon-shifted duplicates) have zero `src` importers, but program membership (tsconfig `include: src`, Typert analysis) and per-file semantic identity need mechanical proof each; the safe form is a deletion script with twin checks plus an allowlist gate (legit `css-modules.d.ts`-style files exist), not a blind mass delete.
- **Extracting the 22 jscpd clones' shared contracts:** rejected for this batch. The rest need cross-package contract extraction with snapshot risk (ui-evolution/evolution types, api feed ↔ ui-workspace-memory, context renders, edit/write + token-meter/usage-ledger structural tool-schema/accumulator shapes), where extraction costs more than it saves; only the safe same-file case (usage-ledger) was fixed.
- **Hoisting the fs-text/sqlite-open/invariant-trace/agent-option extractions into a shared package:** rejected as deferred. Each needs a new shared owner package or dependency edge for 5–15 lines, and the workflow `DEFERRED_*` doc string must stay verbatim (model-visible pin).
- **Fixing the publint ui-evolution CSS failure inside that one package:** rejected. `clientBundle` inlines CSS (no separate files) while the `./types` emitted-tree export ships `lib/types/client/Page.js` with a dangling css import, so the fix belongs in the client build preset policy rather than a one-package hack.

## Consequences

Five focused simplifications landed with their tests and gates green, and the remaining findings now carry their measured size instead of open-ended scope: ~197 `.d.ts` twins and 22/820 jscpd clones measured on a CLEAN main worktree (pre-existing, not from this tree's dirt). Nothing here altered model-visible contracts; two items stay blocked on external state and one gate flake awaits a runner owner.

## Deferred

- **~197 `.d.ts` twins: follow-up program.** Twins (e.g. `llm/types.d.ts` vs `types.ts`, semicolon-shifted duplicates) have zero `src` importers, but program membership (tsconfig `include: src`, Typert analysis) and per-file semantic identity need mechanical proof each — a deletion script with twin checks plus an allowlist gate (legit `css-modules.d.ts`-style files exist), not a blind mass delete. Evidence collected in the review report.
- **22 jscpd clones: baseline-red, program-scale.** Measured 22/820 on a CLEAN main worktree — pre-existing, not from this tree's dirt. Fixed the only safe same-file case (usage-ledger). The rest need cross-package contract extraction with snapshot risk: ui-evolution/evolution types (49), api feed ↔ ui-workspace-memory (26), context renders, edit/write + token-meter/usage-ledger (structural tool-schema/accumulator shapes — extraction costs more than it saves), workspace-memory asymmetry (needs owner analysis: stored path checks source-kind, live path does not).
- **fs-text/sqlite-open/invariant-trace/agent-option extractions: deferred.** Each needs a new shared owner package or dependency edge for 5–15 lines; the workflow `DEFERRED_*` doc string must stay verbatim (model-visible pin).
- **locale copy, client drag/timer hooks: follow-up programs** (per-package dictionaries; ui-primitives hook placement rules).
- **rescope-vendor: blocked by concurrent dirty tree** (other agents' vendor/README + AGENTS.md edits break its exact-edit matching; verify on clean tree/CI).
- **FIXME gate under run-gates on Windows: runner-level flake.** The script passes standalone (`EXIT:0`); parallel gate spawning reports "system cannot find the path specified". Needs gate-runner owner investigation.
- **publint ui-evolution CSS: client-build design question.** `clientBundle` inlines CSS (no separate files) while the `./types` emitted-tree export ships `lib/types/client/Page.js` with a dangling css import. Fix belongs in the client build preset policy, not a one-package hack.
- **node-next-types: blocked on full build outputs** (`pnpm run build` running as job pwsh-26; gate re-run after).

## Triaged without code change

- **tunables gate scope (`tool-*` only): documented intent** ("model-facing tool packages" in the module doc; util zero-dep packages cannot hold Config anyway). The in-scope violations are fixed (item 3 of the Decision).
- **goal/change `@mode`, tool register effect, identity memo: precedent-consistent.** Durable map members carry no `@mode` anywhere (`llm/retry` precedent); tool plugins register directly in `apply` house-wide; identity catches are commented and the memo documented.
- **attachment/settings double-defaults: accepted idiom** (schema default for loader path + `??` for direct construction, mirroring catalogDescription).
- **budgets note prose, archived notes: untouched** (decision history, not live contracts).

# P2-P4 remainder batch 8

- Date: 2026-09-13
- Batch: 8 of full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`)

## Code changes (TDD where behavior changes)

1. `llm-fallback/README.md`: dropped the stray "yet" breaking the
   `verify-package-invariants` reason-sentence regex (`published` must meet
   `[.:;—]` immediately). Gate green (39 conform).
2. `schedule/runtime.ts`: local `MAX_TIMER_DELAY_MS` replaced with a
   re-export from `@deepseek-ai/dsh-timeout` (+dep/tsconfig); 26/26 tests.
3. `skill/tool-skill`: `shell.timeoutMs`/`shell.outputMaxChars` are now
   validated `Config` fields (schema defaults = the old constants);
   `resolveShell`/`capShellOutput` take resolved values with skill metadata
   winning. 4 new tests (2 shape updates); 71/71 skill tests pass; the
   `verify-no-hardcoded-tunables` gate is green.
4. `workspace`: dead `create(path, title?)` parameter removed per its TODO
   (capability survives via `entity.setTitle`); 3 tests reworked to the new
   contract; README pair updated including Dev-Note/ToC removal. (`tsc`
   proves no other callers; suite blocked only by Windows symlink EPERM in
   fixture setup — environmental.)
5. `usage-ledger/aggregate.ts`: `addSample` reuses `addModelOnly` (22-line
   self-clone gone); 52/52 tests.

## Triaged without code change, or deferred as programs

- **~197 `.d.ts` twins: follow-up program.** Twins (e.g. `llm/types.d.ts`
  vs `types.ts`, semicolon-shifted duplicates) have zero `src` importers, but
  program membership (tsconfig `include: src`, Typert analysis) and per-file
  semantic identity need mechanical proof each — a deletion script with twin
  checks plus an allowlist gate (legit `css-modules.d.ts`-style files exist),
  not a blind mass delete. Evidence collected in the review report.
- **22 jscpd clones: baseline-red, program-scale.** Measured 22/820 on a
  CLEAN main worktree — pre-existing, not from this tree's dirt. Fixed the
  only safe same-file case (usage-ledger). The rest need cross-package
  contract extraction with snapshot risk: ui-evolution/evolution types (49),
  api feed ↔ ui-workspace-memory (26), context renders, edit/write +
  token-meter/usage-ledger (structural tool-schema/accumulator shapes —
  extraction costs more than it saves), workspace-memory asymmetry (needs
  owner analysis: stored path checks source-kind, live path does not).
- **fs-text/sqlite-open/invariant-trace/agent-option extractions: deferred.**
  Each needs a new shared owner package or dependency edge for 5–15 lines;
  the workflow `DEFERRED_*` doc string must stay verbatim (model-visible pin).
- **locale copy, client drag/timer hooks: follow-up programs** (per-package
  dictionaries; ui-primitives hook placement rules).
- **rescope-vendor: blocked by concurrent dirty tree** (other agents'
  vendor/README + AGENTS.md edits break its exact-edit matching; verify on
  clean tree/CI).
- **FIXME gate under run-gates on Windows: runner-level flake.** The script
  passes standalone (`EXIT:0`); parallel gate spawning reports "system cannot
  find the path specified". Needs gate-runner owner investigation.
- **publint ui-evolution CSS: client-build design question.** `clientBundle`
  inlines CSS (no separate files) while the `./types` emitted-tree export
  ships `lib/types/client/Page.js` with a dangling css import. Fix belongs in
  the client build preset policy, not a one-package hack.
- **node-next-types: blocked on full build outputs** (`pnpm run build`
  running as job pwsh-26; gate re-run after).
- **tunables gate scope (`tool-*` only): documented intent** ("model-facing
  tool packages" in the module doc; util zero-dep packages cannot hold Config
  anyway). The in-scope violations are fixed (item 3).
- **goal/change @mode, tool register effect, identity memo: precedent-consistent.**
  Durable map members carry no `@mode` anywhere (`llm/retry` precedent);
  tool plugins register directly in `apply` house-wide; identity catches are
  commented and the memo documented.
- **attachment/settings double-defaults: accepted idiom** (schema default for
  loader path + `??` for direct construction, mirroring catalogDescription).
- **budgets note prose, archived notes: untouched** (decision history, not
  live contracts).

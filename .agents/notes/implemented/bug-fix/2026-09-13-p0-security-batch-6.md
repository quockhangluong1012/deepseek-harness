# P0-security fixes batch 6

- Date: 2026-09-13
- Batch: 6 of full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`)

## Code changes (TDD, all failing-first proven)

1. `hooks/hook-protocol/src/runner.ts`: non-positive/non-finite `timeoutSec`
   falls back to `defaultTimeoutMs` instead of arming a degenerate shell
   timeout (enforced at the operation per the seam rule; bridges pass wire
   values through unvalidated). 4-case test added. NOTE: hook suites are
   Windows-excluded in `vitest.config.ts` — the new test runs on Linux lanes;
   `tsc -b` green locally.
2. `web-search-{exa,perplexity,deepseek}` providers: availability now refuses
   embedded-URL credentials (`username`/`password` must be empty) while still
   accepting plain http (required by egress test doubles over `*.invalid` and
   local mocks — an https-only rule would break them). One test per provider,
   all failing-first implied by `URL.canParse` semantics; 104/104 pass with
   egress suites green in isolation.
3. `acp/acp/src/session.ts`: image admission re-resolves from the session's
   LIVE model selection when the prompt carries image blocks
   (`imageEnabledForPrompt`), instead of trusting the initialize-time flag
   after a mid-session model switch. Zero extra cost otherwise (no recompute
   for text-only prompts). This implements the recorded
   `2026-07-23-acp-automation-only-protocol` direction ("prompt admission
   rechecks the live route"); the reverse direction was already fail-loud via
   `assertImageRoute`. New bridge test (failed pre-fix with `not advertised`).

## Triaged without code change (with reasons)

- **hooks halt (`continue:false`): DEFERRED architectural item.** Correct halt
  needs a loop-level contract (cancel vs suppress-wake vs budget) across both
  bridges plus `stop_hook_active` guard semantics; a hurried mapping risks
  breaking automation runs. TODO-marked by the authors; current behavior logs.
  Follow-up spec required, not a P0 edit.
- **bash marker spoof: accepted with nonce analysis.** 122-bit per-command
  UUID, markers stripped from model-facing output, persistent-shell `eval`
  never exposes markers via `ps`, and `lastIndexOf` semantics require the
  CURRENT nonce after the real END marker — unforgeable by remote prompt
  injection. fd-separated status stays a deferred hardening direction.
- **ACL boundary: setup-path, pinned.** Both asserts run at provisioning, not
  per file op; messages pinned by `path-boundary.spec.ts`. No change.
- **invariants ReDoS: operator-trust surface.** Config authors own the box
  (arbitrary plugins via config); compiled once, self-inflicted and
  immediately visible. Contrast hooks.json (clone-arriving, untrusted) which
  WAS hardened above.
- **client/store JSON: deferred versioned-keys.** Same-origin self-written
  cache; per-store zod schemas are a cross-cutting project, and the parse
  failure path already falls back. Recorded for later.
- **Typert loader freeze: same-trust boundary** (a package mutating its own
  manifest is self-sabotage; freezing zod instances risks internals).
  `z.any()` emission already gated by `typescript/no-explicit-any: error`.
- **LSP TOCTOU: seam-mediated + documented.** Goes through `fs.resolve` /
  `contains` / `streamText`; residual is XXX-marked; for-await `break`
  triggers iterator `return()`, so no fd leak.
- **remotes `home`: load-bearing protocol field** (loopback detection, picker
  defaults, pinned shape tests). Opaque-id replacement is a protocol-version
  project, not a P0 fix.
- **vmTimeout/timers, inspector capture, .env precedence, credentials reload:
  accepted designs** (documented trust stance; local-debug tool; inherited env
  wins by precedence with layer logging; warn-and-keep is the deliberate
  fail-safe mirrored with settings-file).
- **worker messages: already hardened** (parse-before-touch, hostile-peer
  rules, `Object.hasOwn` prototype guard, ELU + wall timers).
- **schedule floor, release timeout, preset silence, patch provenance, boot
  sync FS, RPC scans, methodParams: accepted** (abuse-protection invariant in
  pure domain math with no Config surface; fatal-path timing; resolution-time
  fail-loud backstop; debug-only cosmetic; one-time small-file cold start;
  tiny-n with fresh dispatch; fail-loud tested fallback without minification).

## Needs user decision (not unilaterally changed)

- **sandbox `/tmp` narrowing.** Shared `/tmp` + `tmpdir()` in `workspace-write`
  is deliberate, documented (`roots.ts:10-14`), and parity-pinned by test;
  narrowing to a private temp child breaks `/tmp`-socket interop and the
  promised mode meaning across Seatbelt/bwrap/Landlock. Options: (a) keep as
  is, (b) hard-narrow everywhere (breaking), (c) `sharedTmp` opt-in Config.
  Recommend (c) if hardening is wanted — say the word and it becomes batch 8.

## Verification

- hook-protocol `tsc -b` clean (suite runs on Linux lanes).
- web search pkgs: 104/104 + egress suites green solo (parallel egress
  contention is a pre-existing test-isolation flaw: both suites patch the
  global dispatcher — recorded, out of scope).
- acp image subset 7/7 incl. the new switch test; `tsc -b acp` clean.

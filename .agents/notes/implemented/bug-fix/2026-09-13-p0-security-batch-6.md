# Agent Note: P0-security fixes batch 6

Status: implemented

English | [中文](2026-09-13-p0-security-batch-6.zh.md)

## Problem

Batch 6 of the full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`) covered the security findings. Three were live defects: a non-positive or non-finite `timeoutSec` armed a degenerate shell timeout in the hook protocol runner, the web-search providers advertised availability while accepting credentials embedded in the URL, and ACP image admission trusted an initialize-time flag after a mid-session model switch. The remaining findings were refuted, pinned by a deliberate trust boundary, or recorded as follow-up work, and one narrowing decision is left to the user.

## Decision

1. `hooks/hook-protocol/src/runner.ts`: non-positive/non-finite `timeoutSec` falls back to `defaultTimeoutMs` instead of arming a degenerate shell timeout (enforced at the operation per the seam rule; bridges pass wire values through unvalidated). 4-case test added. NOTE: hook suites are Windows-excluded in `vitest.config.ts` — the new test runs on Linux lanes; `tsc -b` green locally.
2. `web-search-{exa,perplexity,deepseek}` providers: availability now refuses embedded-URL credentials (`username`/`password` must be empty) while still accepting plain http (required by egress test doubles over `*.invalid` and local mocks — an https-only rule would break them). One test per provider, all failing-first implied by `URL.canParse` semantics; 104/104 pass with egress suites green in isolation.
3. `acp/acp/src/session.ts`: image admission re-resolves from the session's LIVE model selection when the prompt carries image blocks (`imageEnabledForPrompt`), instead of trusting the initialize-time flag after a mid-session model switch. Zero extra cost otherwise (no recompute for text-only prompts). This implements the recorded `2026-07-23-acp-automation-only-protocol` direction ("prompt admission rechecks the live route"); the reverse direction was already fail-loud via `assertImageRoute`. New bridge test (failed pre-fix with `not advertised`).

## Alternatives considered

**Guard bash output markers against spoofing.** Accepted with nonce analysis instead: the marker is a 122-bit per-command UUID, markers are stripped from model-facing output, persistent-shell `eval` never exposes markers via `ps`, and `lastIndexOf` semantics require the CURRENT nonce after the real END marker — unforgeable by remote prompt injection.

**Move the ACL boundary asserts into each file operation.** Pinned at the setup path instead: both asserts run at provisioning, not per file op, and `path-boundary.spec.ts` pins their messages.

**Make the config invariants ReDoS-proof.** Operator-trust surface instead: config authors own the box (arbitrary plugins via config), and the pattern is compiled once, self-inflicted and immediately visible. Contrast `hooks.json` (clone-arriving, untrusted), which WAS hardened above.

**Freeze the Typert loader manifest.** Same-trust boundary instead: a package mutating its own manifest is self-sabotage, and freezing zod instances risks internals. `z.any()` emission is already gated by `typescript/no-explicit-any: error`.

**Close the LSP TOCTOU window locally.** Seam-mediated and documented instead: the read goes through `fs.resolve` / `contains` / `streamText`, the residual is XXX-marked, and a for-await `break` triggers the iterator's `return()`, so no fd leaks.

**Replace the remotes `home` field with an opaque id.** Not a P0 fix: `home` is a load-bearing protocol field (loopback detection, picker defaults, pinned shape tests), and opaque-id replacement is a protocol-version project.

**Tighten vm timers, inspector capture, `.env` precedence, or credential reload.** Accepted designs instead: the vm/timer trust stance is documented, the inspector is a local-debug tool, inherited env wins by documented precedence with layer logging, and warn-and-keep is the deliberate fail-safe mirrored with settings-file.

**Re-harden worker message handling.** Already hardened: parse-before-touch, hostile-peer rules, an `Object.hasOwn` prototype guard, and ELU + wall timers.

**Change the schedule floor, the release timeout, preset silence, patch provenance, boot sync FS, RPC scans, or method params.** Accepted as is: the floor is an abuse-protection invariant in pure domain math with no Config surface; the timeout is fatal-path timing; preset-default silence has a resolution-time fail-loud backstop; patch provenance is debug-only cosmetic; boot reads are a one-time small-file cold start; RPC scans are tiny-n with fresh dispatch; and method params use a fail-loud tested fallback without minification.

## Consequences

A non-positive or non-finite hook timeout falls back to the documented `defaultTimeoutMs` instead of arming a degenerate shell timeout, web-search availability no longer accepts URL-embedded credentials while the plain-http egress doubles keep working, and ACP image admission follows the live route at no extra cost for text-only prompts. The accepted trust boundaries stay as they are — operator-supplied config, same-package manifest mutation, and protocol fields such as `home` — and the sandbox `/tmp` question is left to the user rather than decided unilaterally.

## Deferred

- **Hook halt (`continue:false`).** An architectural item: a correct halt needs a loop-level contract (cancel vs suppress-wake vs budget) across both bridges plus `stop_hook_active` guard semantics, and a hurried mapping risks breaking automation runs. TODO-marked by the authors; current behavior logs. Follow-up spec required, not a P0 edit.
- **Versioned keys for the client/store JSON caches.** A same-origin, self-written cache; per-store zod schemas are a cross-cutting project, and the parse-failure path already falls back. Recorded for later.
- **fd-separated status for bash markers.** A hardening direction that stays deferred.
- **Sandbox `/tmp` narrowing (needs a user decision).** Shared `/tmp` + `tmpdir()` in `workspace-write` is deliberate, documented (`roots.ts:10-14`), and parity-pinned by test; narrowing to a private temp child breaks `/tmp`-socket interop and the promised mode meaning across Seatbelt/bwrap/Landlock. Options: (a) keep as is, (b) hard-narrow everywhere (breaking), (c) `sharedTmp` opt-in Config. Recommend (c) if hardening is wanted — say the word and it becomes batch 8.

## Verification

- hook-protocol `tsc -b` clean (suite runs on Linux lanes).
- web search pkgs: 104/104 + egress suites green solo (parallel egress contention is a pre-existing test-isolation flaw: both suites patch the global dispatcher — recorded, out of scope).
- acp image subset 7/7 incl. the new switch test; `tsc -b acp` clean.

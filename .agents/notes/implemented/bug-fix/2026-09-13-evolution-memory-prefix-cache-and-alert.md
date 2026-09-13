# Agent Note: Evolution Memory Prefix-Cache Fix and Cache-Hit Alert

Status: implemented

## Problem

A review against `specs/evolutionary-harness-prompt-v6.md` (recorded in [`docs/superpowers/specs/2026-09-13-evolutionary-harness-review-v6.md`](../../../../docs/superpowers/specs/2026-09-13-evolutionary-harness-review-v6.md)) found that `dsh-evolution-memory-context` interpolated a live `{{evolution_memory_usage}}` value into the `evolution-memory-scope` system-prompt section — a decision recorded in [the injector's original Agent Note](../feature/2026-09-11-evolution-memory-context.md). Because the whole system prompt is one surface node that `SystemPromptProjection` (`packages/core/agent-loop/src/runtime-context.ts`) replaces in place whenever its rendered text changes, any evolution-memory write that moved the usage number invalidated the provider's cached prefix for every tool schema and every other static section in the same request — not just the memory-adjacent text. Separately, the usage ledger already computed a `cacheHitAvg` rollup (`packages/session/usage-ledger/src/aggregate.ts`) but nothing watched it, so a cache-hit regression like this one had no way to surface itself operationally.

## Decision

`evolution-memory-scope`'s text is now fixed prose with no interpolated value: `sections.ts` drops the `{{evolution_memory_usage}}` reference, and `index.ts` no longer registers a `USAGE_VARIABLE` prompt variable or the `usageForSession` helper that fed it. Capacity usage remains visible to the model exclusively through the brief's own header (`Memory usage: used/cap (pct%)` in `render.ts`), which already varies with memory content and already replaces itself through the injector's own digest gate — so no capability is lost, only a duplicate, cache-hostile copy of the same number.

`dsh-usage-ledger` gains an opt-in `cacheHitAlertThreshold` (unset by default) plus a `cacheHitAlertMinRequests` floor (default `20`). When configured, `UsageLedger` emits an ephemeral `usage/cache-hit-low` event on a healthy-to-unhealthy crossing of today's rolling cache-hit share, computed from the same `cacheHitAvg` the dashboard already serves. The check runs inline in `foldAttempt` after each sample lands, tracks one `{day, healthy}` pair to stay edge-triggered (fires once per crossing, not on every request while already unhealthy, and can fire again after a recovery), and is a no-op when the threshold is unset.

## Alternatives considered

- **Adding a new `cacheReadTokens`/`inputTokens` ratio to `packages/llm/token-meter`.** Rejected: `dsh-usage-ledger` already computes and exposes this ratio as `cacheHitAvg`; a second computation in a second package would create two sources of truth for the same number.
- **A `PromptBuilder`-style cached-string class for the system prompt**, mirroring the reference prompt's pseudocode. Rejected: `SystemPromptProjection` already gets the same effect at the surface layer (skip when unchanged, replace in place at a real series break) without a second, string-level cache that could drift from the session log.
- **Keeping the usage variable but moving it to a lower system-prompt order** so it changes less often. Rejected: the variable still lives inside the one system-prompt surface node, so any change to it still invalidates the same node regardless of where in that node's text it sits.
- **Polling `cacheHitAvg` from an external monitor instead of an in-ledger event.** Rejected: the ledger already folds every sample inline; adding the check there costs one comparison per fold, versus a poller that would need its own schedule and would lag the actual crossing.

## Consequences

The system prompt is now byte-identical across turns regardless of memory-record changes, restoring the provider's cached-prefix reuse for tool schemas and static sections on every evolution-memory write; the brief still carries the usage number where it already paid the cost of varying. Deployments that want the alert opt in explicitly; unset, the ledger's behavior and shape are unchanged. The `evolution-memory-context` package's original Agent Note ([2026-09-11](../feature/2026-09-11-evolution-memory-context.md)) still describes the camelCase-vs-lowercase variable-naming deviation and the capacity-variable nudge as shipped; both are now historical rather than current — read this note as the up-to-date fact for that mechanism.

## Testing

`evolution-memory-context`: `sections.spec.ts` asserts `MEMORY_SCOPE_SECTION.text` contains no `{{...}}` group, and a new spec drives a real `EvolutionMemoryStore` through a memory write and asserts the assembled system prompt is byte-identical before and after (and for a session outside any scope); `composition.spec.ts`'s real-loop spec asserts the system prompt never contains `usage`. `usage-ledger`: three new specs in `ledger.spec.ts` pin the edge-trigger (fires once per crossing, silent while already unhealthy, fires again after recovery), the `cacheHitAlertMinRequests` floor withholding an early low-sample alert, and the alert never firing when unconfigured. All touched and downstream packages (`evolution-memory-context`, `usage-ledger`, `evolution-controller`, `command-evolution`, `evolution-reviewer`) pass their full suites; `pnpm run build:lib:host` and `pnpm run typecheck:contracts-ready` are clean.

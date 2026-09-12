# Agent Note: Curator host-wide trigger and opt-in consolidation

Status: implemented

English | [中文](2026-09-12-evolution-curator-trigger-consolidation.zh.md)

## Problem

`specs/evolutionary-harness.spec.md` gives the curator two jobs the package did not do. Its trigger was a caller-supplied `maybeRun`, but the spec names three host surfaces — CLI start, gateway housekeeping, `serve` maintenance timer — and the session-local `schedule` facility cannot serve a host-wide maintenance pass. Its second job, opt-in LLM consolidation of agent-created skills, did not exist at all: the package surveyed candidates and stopped there, so keep/patch/consolidate/archive verdicts and the full-package rule had no owner.

## Decision

**The plugin owns the schedule.** `evolution-curator` is mounted once per host, so one timer covers the Electron desktop child, `serve`, and the gateway, and one start-time due-check covers a short-lived CLI run. Mounting observes host-wide `session/event` activity itself (no new cross-package facility), runs one awaited due-check, then installs a `tickMinutes` interval, `unref()`ed and disposed through `ctx.effect`. A due-check runs a pass only when `intervalHours` elapsed since `lastRunAt` and no session event arrived within `minIdleHours`; before this process observes any activity the host counts as idle, which is what lets a CLI start run a pass that was already due. The first check seeds `lastRunAt` and defers one interval, and a scheduled failure is caught and warned so the timer survives. `enabled: false` starts no timer and never touches the bookkeeping. Idleness arrives as an explicit `idleMs` override on `maybeRun` or as the observed activity gap; specs drive both with fake timers, so no test-only clock seam ships.

**Consolidation runs in-package, not through the subagent seam.** A host plugin cannot fork a child agent headlessly: the in-process providers inherit their route from a live parent session's latest request, and a maintenance pass has no session. The fork is therefore a bounded in-package tool loop over `ctx.llm`, whitelisted to `skill_view` (read one candidate package) and `skill_apply` (record one verdict). One cost row `{inputBytes, maxOutputTokens, provider, model, truncated}` reaches the ledger before the first request; the loop spends at most `maxSteps` requests, ends at the first text-only answer, and is bounded by a `timeoutMs` deadline that teardown also aborts.

**The curator performs the writes, so the full-package rule holds regardless of the model.** A `patch` rewrites `SKILL.md` in place. A `consolidate` verdict moves the candidate's whole directory under its umbrella, rewrites every `${DSH_SKILL_DIR}` reference in the moved tree to the new relative root, and appends a reference to the umbrella's `SKILL.md`. An `archive` verdict moves the whole directory into `.archive/`. A package shipping `references/`, `templates/`, `scripts/`, or `assets/` is therefore never flattened to `SKILL.md` alone; when the umbrella is missing, unwritable, or already owns that directory name, the package stays where it is and the verdict is counted as skipped. Merges record a `move` ledger entry carrying both endpoints, and `rollbackPass` moves every relocated package back before restoring lifecycle states, so a consolidation run rolls back as the rest of the pass does.

## Alternatives considered

**Forking the subagent seam from the plugin.** Rejected on evidence, not preference: the composed in-process providers build a child by merging the requested fields over the parent's *latest logged request*, so a caller with no session and no request header has no route to inherit; an out-of-process backend would instead spawn a second harness process for a maintenance pass. A curator mounted as a host plugin therefore cannot spawn headlessly, and the bounded in-package tool loop over `ctx.llm` is the transport that actually ships. If a session-owned caller ever drives consolidation, the seam becomes available to it again.

**A durable cache of the survey or of package hashes.** Rejected: `telemetry.entries()` is already a synchronous read over validated in-memory state, and `skills.list()` is the catalog's own answer, so a durable copy would add a second source of truth for the same records plus an invalidation problem, in exchange for saving a read that costs nothing measurable. The pass also re-derives the candidate set on every run, which is what keeps a skill patched between passes visible.

**`pruneBuiltins: false` as the default.** Rejected: bundled built-ins are product-owned and never belong to the user's curation, so pruning them by default is the conservative choice, and it preserves the previous exclusion behaviour for every existing composition. The field exists so an operator who does want built-ins curated can say so; hub sources stay exempt either way, because a hub skill is shared state whose lifecycle is not this host's to decide.

**Editing `SKILL.md` in place for merges (flattening).** Rejected: it is exactly the failure the full-package rule forbids — a package shipping `references/`, `templates/`, `scripts/`, or `assets/` would lose every file the `SKILL.md` points at. Re-homing the whole directory and rewriting `${DSH_SKILL_DIR}` to the new relative root keeps every reference resolvable without the curator having to understand any file's content.

## Consequences

The maintenance schedule no longer depends on a host calling in: mounting is the whole trigger, and `enabled: false` is now removal-equivalent for both the timer and the bookkeeping. The cost is one unref'd interval per host process and one awaited due-check at mount; on a fresh home that check only writes `lastRunAt`.

Consolidation stays opt-in and fails loudly when it is switched on without a route: a half-set `provider`/`model` pair and an opted-in consolidation missing both reject at load time, so no silent skip can hide a misconfigured fork.

Rollback restores lifecycle states and relocated packages, never a patched body: `patch` verdicts are ledgered for audit only. Merges also rewrite directory references, not schedule entries — no schedule entry references a skill yet, so `protectedNames` remains the schedule-reference guard until the blueprint-to-cron work lands.

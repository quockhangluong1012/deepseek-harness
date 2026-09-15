# Agent Note: Batch 7 dashboard rates on `/curator status` and the journey page

Status: implemented

English | [中文](2026-09-16-batch7-dashboard-rates.zh.md)

## Problem

Review-v6 Batch 7 (P4 polish) asked for two things: refresh the subsystem page for the fixed G1/G2, and a small dashboard showing the newly added `cacheHitRate` and `failureRate`. The G5 open item (does `dsh-client-ui-evolution` exist?) resolved to yes, and the user chose CLI plus UI over CLI-only, with one condition: UI changes must also be checked against the desktop/Electron build.

## Decision

**Two rates, two surfaces, one formula each.** `/curator status` (`executeCuratorStatus`) gains two lines: today's cache-hit share from `ctx.usageLedger.summary('today', signal)` and the aggregate skill failure rate `ΣfailureCount / Σ(useCount + failureCount)` over telemetry entries — the Batch 3/5 formula, now its third use. Either rate names its missing source when unmounted (`usage ledger is not mounted`, `no recorded loads`), following the file's existing `telemetry unavailable` pattern. The journey page carries the same two numbers through `EvolutionCuratorStatus.cacheHitRate / skillFailureRate` (`null` = source missing or empty), rendered as card meta lines above the passes list, hidden when null. Rates show even with zero recorded passes; the `empty` text only covers the passes.

**Wiring notes.** The status executor threads `invocation.signal` into the ledger read. The UI Host face owns no caller cancellation, so its ledger read runs under a never-aborted signal with a comment saying exactly that (precedent: gateway's `NEVER_ABORTED_SIGNAL`). The telemetry dep entered UI devDependencies plus the host project reference — the same two steps Batch 5 needed for the scorer. No new CSS: the card reuses `.meta`. No wire change: `status()` keeps zero args, so the generated Remote descriptor only gains the two fields.

**Desktop/Electron.** No Electron shell lives in this repo; desktop and web both consume the `web-app` bundle plus `api/remotes`. The check is therefore the repo-wide typecheck (both consumers compile against the widened status type) plus the client-face build — both green. No new runtime dependency was added, so nothing new ships to the desktop bundle.

## Alternatives considered

- **Dashboard on the CLI only** — the review's fallback for the G5 open item. Not taken: `dsh-client-ui-evolution` does exist, and the user chose CLI plus UI on the condition that UI changes are also checked against the desktop/Electron build.
- **Keep the review's `1 - failureCount/useCount` rate** — not taken: the CLI line and the page both use the Batch 3/5 aggregate `ΣfailureCount / Σ(useCount + failureCount)`, so all three surfaces read one formula.
- **Say nothing when a source is unmounted** — not taken: each rate names its missing source (`usage ledger is not mounted`, `no recorded loads`), following the file's existing `telemetry unavailable` pattern.
- **Hand-write the G1/G2 prose on the subsystem page** — not taken: the page's overview already describes the brief mechanism the fixes produced, and regen picked up the new `status` face.

## Consequences

`/curator status` prints two more lines — today's cache-hit share and the aggregate skill failure rate — and the journey page shows the same numbers as card meta lines above the passes list (`curator.cacheHit:{"percent":73}` and `curator.failureRate:{"percent":13}`), hidden while either source is missing or empty.

The status type widened by two nullable fields, so every consumer of `EvolutionCuratorStatus` recompiles against them; the wire itself did not change, since `status()` still takes no arguments and the generated Remote descriptor only gained the two fields.

What this costs: `dsh-client-ui-evolution` now depends on the telemetry package (devDependencies plus the host project reference — the same two steps Batch 5 took for the scorer), and the UI Host face's ledger read runs under a never-aborted signal, because that face owns no caller cancellation and so cannot be interrupted there. The pre-existing coverage gaps and lint errors in both packages remain (see Testing).

## Testing

CLI: updated three status expectations plus a new rates test (ledger fake at 73.1% over 142 requests, two skills at 2/16 loads — exercises the rounding to 13%). UI host face: null-rate expectations plus a rates test over fake ledger/telemetry. Page: rates render as `curator.cacheHit:{"percent":73}` / `curator.failureRate:{"percent":13}`. 101 CLI + 39 UI tests pass; the new code is fully covered. The remaining coverage gaps and lint errors in both packages pre-date this change (Batch 4's uncommitted `staged`/`ledger` verbs lack usage-error tests; `no-non-null-assertion` and `max-len` in untouched lines) and are left for their owner.

## Deferred

GEPA-effectiveness metrics (§6 of the review) stay N/A — Batch 6 was skipped by user direction, so there is no optimizer triple to compare yet. The subsystem page needed no hand prose for G1/G2: its overview already describes the brief mechanism the fixes produced, and the regen picked up the new `status` face plus the staged/telemetry methods.

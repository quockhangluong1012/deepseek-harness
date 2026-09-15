# Agent Note: The curator stages failing skills before it moves anything

Status: implemented

English | [中文](2026-09-16-curator-staging.zh.md)

## Problem

Review-v6 §4.3 asked for a "light sleep" staging step inside the curator's existing pass: scan telemetry, write what deserves attention to a ledger, and touch nothing else. Batch 3 had just given the telemetry store the outcome signal that step needs — `failureCount` and `lastOutcome` — so the filter finally had something real to read.

Two facts shaped the work. The pass already had exclusion policy for pins, protected names, and bundled or hub sources, so staging had to decide which of those it shares. And `/curator ledger` lists **passes only**, so a staging ledger with no read surface would have been dead weight the moment it was written.

## Decision

**Selection is pure, policy stays in the pass.** `src/stage.ts` holds `stageCandidate` — a record stages when `useCount + failureCount >= stageMinUses` (default 20) and `failureCount / (useCount + failureCount) > stageFailureRate` (default 0.3), the exact rate formula Batch 3 documented on the field. Sample size gates the ratio because a perfect rate over three loads says nothing, and the comparison is strict because a rate *at* the threshold is not yet over it. `orderStaged` sorts worst first with the name as tie-break, written generically so the ledger read keeps its extra `at` field without a cast.

**Staging shares the pass's exclusions, minus the pin.** Bundled and hub sources and `protectedNames` never stage — they are outside curation entirely. A pinned skill **does** stage: the pin protects a skill from being moved, not from being looked at, and staging moves nothing. This meant reordering the pass loop so the pin check runs after staging; the skip counters still count each skill once.

**Evidence, never movement.** A staged skill appends one `stage` ledger entry — name, both counters, the rate, and the reason — and nothing else changes. `backup.enabled` gates it, which is what that switch already documents ("master switch for snapshots and ledger writes"). The counters are the dedupe key, so a skill still failing at counters already on the ledger is not re-appended; without that, every pass would add one line per failing skill forever.

**A read surface, because the ledger had none for this.** `staged()` reads the newest entry per skill, worst first, and `/curator staged` lists them; `/curator status` gains the count with the worst rate, and `/curator run` names what the pass staged. All the existing ledger commands list passes, so a new entry kind nobody could read would have been a write-only record.

## Alternatives considered

**Widening the consolidation candidate set to every staged skill.** Rejected. Consolidation deliberately covers only agent-created skills — it patches and archives packages, and a user-directed skill is not the curator's to rewrite. Staging is operator evidence and the effectiveness metric §4.3 asks for; the failures it reads already reach a consolidation verdict through the survey's `failures` field.

**A second timer for the light-sleep phase.** Rejected: §4.3 says to reuse the existing pass, and this package's own rule is one host-wide timer. Staging rides the same `run` — and `maybeRun` gets it for free, including the idle gate.

**A separate staging store instead of the ledger.** Rejected: the ledger already carries actors, instants, and evidence, is append-only, and is what rollback and `/curator ledger` read. A second store would need its own retention and consistency story for data with no mutation.

**Staging inside `surveyCandidates`.** Rejected: that method is a read for the consolidation fork and never writes by contract. Staging writes a ledger line, so it belongs to the pass.

## Consequences

Every pass now leaves operator evidence behind: a skill whose telemetry crosses both gates — at least 20 recorded outcomes and a failure share strictly above 0.3 — gets one `stage` ledger entry naming it, both counters, the rate, and the reason. That entry is what `/curator staged` lists, what `/curator status` counts alongside the worst rate, and what `/curator run` names for the pass just completed. Nothing moves: staging flags a skill for review, so no package, file, or pin changes state.

Pinning still stages. A pinned skill produces evidence exactly like any other, because the pin protects it from being moved, not from being looked at; the pass loop's check order changed to make that true, and each skill is still counted once in the skip counters.

What this costs: one ledger line per newly failing skill — bounded by the counters dedupe, since a skill still failing at counters the ledger already carries is not re-appended — and the write sits behind `backup.enabled`, so a deployment with that switch off collects no staging evidence. The `stage` kind is also the first ledger entry the existing pass-only listing cannot show, which is why `staged()` and the two status surfaces exist.

## Testing

Boundary cases at the threshold, under the sample gate, and on never-loaded skills; dedupe across passes and across a counter change; dry-run reporting without writing; `backup.enabled: false` writing nothing; pinned staged while protected is skipped; ordering both by rate and by the name tie-break, the latter with a two-element array in either input order so both comparator arms run whatever the sort does. Both packages are at 100% on statements, branches, functions, and lines for the lines this change touches.

## Deferred

Turn-level skill outcome (whether the skill's advice worked, not whether the load returned), which is the signal a GEPA trigger needs; staged-to-approved conversion counting, which §4.4's metric wants and which needs an `adopt`/verdict correlation the ledger does not yet carry; and the GEPA trigger and optimizer (Batch 5-6).

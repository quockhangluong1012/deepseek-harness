---
description: "Idle-triggered skill lifecycle curation: automatic active/suspect/stale/archived transitions on idleness and recorded evidence, with dry-run previews (ctx.evolutionCurator), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-curator

English | [中文](README.zh.md)

## Summary

Keep skill lifecycles honest: mount the plugin once per host and it moves skills `active → suspect → stale → archived` on idle age and evidence, revives a suspect or stale skill whose newest load answers the evidence against it, and previews each pass with a dry run. `consolidate` has a model merge agent-created skills into umbrella skills; pinned, protected, bundled, and hub skills never move. It reads skill telemetry and degrades to bookkeeping without it. Real passes write snapshots, reversible whole or by entry.

Mounting is the whole trigger: `enabled: false` starts no timer and no bookkeeping.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin once per host. It then owns the maintenance schedule: it observes host-wide `session/event` activity itself, runs one start-time due-check, and repeats a due-check every `tickMinutes` on an `unref()`ed timer disposed with the plugin. A due-check runs a pass only when `intervalHours` elapsed since `lastRunAt` and no session event arrived within `minIdleHours`; before this process observes any activity the host counts as idle. The first check only seeds `lastRunAt` and defers one interval, so a short-lived CLI run contributes its start instant without running anything. `enabled: false` starts no timer and leaves the bookkeeping untouched.

Call `maybeRun` to run the same due-check yourself (the idle gate takes an explicit `idleMs` override), or `run` for an unconditional pass, with `dryRun: true` to preview the report without writing. A pass examines every tracked skill: idle age counts from the last load, or from seeding when never loaded. `active` moves to `stale` past `staleAfterDays`. Evidence moves a skill one rung more slowly than idleness does: every evidence-driven movement lands on `suspect`, which then ages into `stale` on the same idle threshold `active` does.

### Drift signals

A pass reads four §22 signals from records the profile already holds, and any one of them moves an `active` skill to `suspect`. Every signal contributes to the transition reason as `drift: <names>`. `failureSpike` is a decisive grading — a `trigger_review` failure signal for one of the skill's sessions — attributed to the skill by its last trust observation, unanswered by any newer load, and landed within `driftWindowDays`. `conflictingEvidence` is a `conflicting-evidence` uncertainty signal recorded for the skill after its last load or patch. `lowUtility` is the skill's recorded clean-outcome share minus its peers', at or below `lowUtilityFloor`. `versionChange` is a recorded lineage envelope whose `tool`, `model`, `prompt`, `retriever`, `evaluator`, or `env` version differs from the envelope before it, recorded after the skill was last used or patched — the skill's own version is skipped, because the artifact under change is not the environment it was validated in.

Attributed trust failures at `staleTrustFailureFloor` with no newer load answering them, and a load failure rate past `stageFailureRate` over at least `stageMinUses` loads ending in a failed load, also move an `active` skill to `suspect`. A `suspect` skill whose most recent load succeeded and is newer than the instant it entered `suspect` returns to `active`, which is how a load quietly answers the evidence; a `stale` skill whose most recent load succeeded, still inside the stale window and newer than its last attributed failure, also returns to `active`; past `archiveAfterDays` both archive instead, so the horizon always wins over revival. The report names every movement with its reason plus skip counts for pins, protected names, and excluded sources, and carries the pass identity and snapshot filename when a snapshot was written. `lastRunAt` reads the last pass instant for status surfaces.

#### Signals §22 names that no record reaches

Two sources the specification lists are not per-skill anywhere in the profile, so no pass reads them. The knowledge graph's contradicted claims and the memory store's `refutationCount` count per scope and per artifact, and no stored field links an artifact or a claim to a skill; they reach the ladder only through the per-skill `conflicting-evidence` uncertainty signals above. A task-distribution shift needs a task-class axis on skill usage and none exists: skill usage records the sessions that loaded it, never the tasks they asked for, and `evolution-meta`'s `taskClass` is the optimizer's skill under test rather than a task class.

With `consolidate: true` the pass then runs one LLM consolidation over the agent-created skills (see [Consolidation](#consolidation)).

### Staging

Every pass also stages skills whose recorded outcome says the skill is not working. A skill stages when its telemetry record holds at least `stageMinUses` loads and a failure share over `stageFailureRate`, where the share is `failureCount / (useCount + failureCount)` — the rate the telemetry record documents. Staging is evidence, never movement: it appends one `stage` ledger entry per skill and writes nothing to the skill or to telemetry, so a pinned skill still stages. The pin protects a skill from being moved, not from being looked at; bundled, hub, and `protectedNames` skills stay out because they are outside curation entirely.

The counters in the entry are the dedupe key, so a skill still failing at counters already on the ledger is not re-appended — the ledger grows only when the skill was used again. `staged` reads the newest entry per skill, worst failure rate first with ties by ascending name, and the pass report names what it staged. `backup.enabled` gates the write, as it does every other ledger write in this package.

### Regression debt

Every pass also maintains one open debt per decisive failure per skill, in the `debt` table of the `evolution_curator` domain (version 2). A `trigger_review` signal for a new merge key opens a debt counting consecutive passes; a repeated sighting deepens it (`passes`, newest message, most reporting sessions); a revision closes the old debt and opens a fresh one, because the new body has not answered the old failure; a failure gone silent closes its debt even while another persists. `debt()` lists every open debt — most passes, then most sessions, then name and merge key — and the pass report carries the same list. Dry runs write nothing. Debt is the regression backlog the loop has not answered: it names failures, not verdicts, so consolidation and future benchmark growth read what to aim at rather than what was decided.

### Configuration

Intervals, thresholds, retention, and the consolidation route are validated `Config` members changeable from `cordis.yml`. An archive threshold below the stale threshold fails loudly, as does a half-set `provider`/`model` pair or an opted-in consolidation without both.

```yaml
- name: '@deepseek-ai/dsh-evolution-curator'
  config:
    staleAfterDays: 30
    consolidate: true
    provider: deepseek
    model: deepseek-chat
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; off skips every pass, starts no timer, and touches no bookkeeping |
| `intervalHours` | `168` | Minimum hours between two passes |
| `minIdleHours` | `2` | Minimum observed idle hours before a pass runs |
| `tickMinutes` | `15` | Minutes between host-wide due-checks |
| `staleAfterDays` | `30` | Idle days moving `active` to `stale` |
| `archiveAfterDays` | `90` | Idle days moving `stale` to `archived` |
| `staleTrustFailureFloor` | `3` | Attributed trust failures moving `active` to `suspect` while no newer load answers them |
| `driftWindowDays` | `14` | Days a decisive graded failure stays recent for the §22 failure-spike signal |
| `lowUtilityFloor` | `0` | Utility excess at or below which §22 counts a skill's measured utility as low; zero is the pooled peer baseline |
| `protectedNames` | `[]` | Skill names exempt from automatic transitions, such as schedule references |
| `pruneBuiltins` | `true` | Prune bundled built-in skills from passes; hub sources are always exempt |
| `backup.enabled` | `true` | Master switch for snapshots and ledger writes |
| `backup.keep` | `5` | Snapshot tarballs retained after pruning |
| `archiveTtlDays` | `0` | Idle days an archived skill waits before purge eligibility; zero never purges |
| `consolidate` | `false` | Opt-in LLM consolidation of agent-created skills |
| `provider` | unset | Provider route for consolidation; set together with `model` |
| `model` | unset | Model id for consolidation; required when `consolidate` is on |
| `maxInputBytes` | `65536` | Byte budget for the framed consolidation survey |
| `maxOutputTokens` | `2048` | Output-token cap per consolidation request |
| `maxSteps` | `4` | Consolidation requests the bounded tool loop may spend |
| `maxCandidateFailures` | `5` | Recorded failures carried per survey candidate as reflection evidence |
| `timeoutMs` | `60000` | Deadline for one consolidation run |
| `stageMinUses` | `20` | Recorded loads required before a failure rate stages a skill |
| `stageFailureRate` | `0.3` | Failure share a skill must exceed to be staged |
| `maxDiffLines` | `0` | Total changed-line ceiling (added plus removed) a consolidation patch may not exceed; `0` leaves it unbounded |
| `requireVerifierPass` | `false` | Refuse a consolidation patch the verifier ladder did not fully pass — an abstention as well as a failure — instead of committing on levels 0/1 alone |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-curator) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One bookkeeping row in storage domain `evolution_curator`, version `1`, layout `per-record`, table `meta` under the single key `state`. Transitions apply through skill telemetry via `ctx.get`, so curation degrades to bookkeeping instead of failing when the store is unmounted. Unknown catalog names record under the `custom` source rather than escaping curation. The clock and the idle observation arrive as call arguments on `run`/`maybeRun`, while the mounted plugin adds the host-wide parts: a `session/event` listener keeping the newest activity instant, a fire-and-forget start-time due-check that never blocks plugin startup, and an `unref()`ed interval disposed through `ctx.effect`. Specs drive due and idle transitions with fake timers, so the plugin carries no test-only clock seam. Plugin teardown stops the timer, aborts active consolidation, awaits in-flight passes, then closes the domain.

### Consolidation

`consolidate` is off by default and costs real model calls. When on, a real pass surveys the agent-created skills in `active` or `stale` state, frames them within `maxInputBytes`, and appends one `cost` ledger row `{inputBytes, maxOutputTokens, provider, model, truncated}` before the fork starts. Each candidate carries the failures recorded in the sessions that loaded it — up to `maxCandidateFailures`, read from the feedback store when one is mounted — so a verdict reflects what actually broke rather than what the skill's author intended. The fork is a bounded in-package tool loop over `ctx.llm` with a two-tool whitelist: `skill_view` reads one candidate package, `skill_apply` records one verdict (`keep`, `patch`, `consolidate`, `archive`) per candidate. The loop turns over at most `maxSteps` requests and ends at the first text-only answer; a failed request throws and the run's deadline aborts it at `timeoutMs`, as does plugin teardown.

The curator performs every write, so the full-package rule holds regardless of what the model asks. A `patch` body passes the verifier-first ladder (see [`dsh-evolution-verifiers`](../evolution-verifiers/README.md)) before it is committed: levels 0 and 1 decide the frontmatter invariant `skill_manage edit` enforces and the name/instruction invariants deterministically, a body failing either is skipped with its refusing level and reason reported in `refusals`, and a body the deterministic levels pass then meets `maxDiffLines` — a patch that changes more lines (added plus removed) than the configured cap is skipped with `level: 'diff-cap'` in `refusals` before anything is written. The higher levels of the ladder run behind whatever `simulation`/`evaluator`/`review` seams a caller of `applyConsolidation` forwards; this plugin's own pass forwards none today, so they abstain. By default an abstained-but-not-failed ladder still commits on the deterministic evidence alone; `requireVerifierPass` refuses instead, with `level: 'ladder-incomplete'`, so a caller that does forward higher-rung seams can demand every one of them decide before a write lands. A body that clears the ladder and the diff cap is committed by rewriting `SKILL.md` in place — the replaced text is stored as a content-addressed blob first. A `consolidate` verdict re-homes the candidate's whole directory under its umbrella (`<umbrella>/<name>/`), rewrites every `${DSH_SKILL_DIR}` reference in the moved tree to the new relative root, and appends a reference to the umbrella's `SKILL.md` — a package shipping `references/`, `templates/`, `scripts/`, or `assets/` is never flattened to `SKILL.md` alone. An `archive` verdict moves the whole directory into `.archive/` beside the skill. When the umbrella is missing, unwritable, or already owns a directory of that name, the package stays exactly where it is and the verdict counts as skipped. Merges record a `move` ledger entry carrying both endpoints, and lifecycle movements ride the same snapshot, `pass`, and `transition` machinery as an automatic pass; `rollbackPass` moves every relocated package back and restores the lifecycle states.

A host plugin cannot fork the subagent seam headlessly — an in-process provider inherits its route from a live parent session, which the curator has none of — so the loop runs in-process.

### Pass safety

A real pass with movements writes one tarball under the curator home (`snapshots/pass-<timestamp>-<id>.tar.gz`, pruned to `backup.keep`): staged before/after record pairs, resolvable skill directories, and a manifest. Unresolvable names land in the pass evidence instead of failing. One `pass` ledger entry plus one `transition` entry per movement append to the append-only JSONL ledger, with before/after record blobs stored content-addressed. `rollbackPass` restores lifecycle states, relocated packages, and the SKILL.md bodies the pass patched; `rollbackEntry` restores one lifecycle entry. Both verify every record, blob, and recorded move up front — a missing body preimage fails the rollback closed — snapshot current records first so each rollback stays reversible, and record one `rollback` entry per skill, reversed move, or restored body. A patch row written before bodies were snapshotted carries no preimage and is skipped. Unknown ids, missing blobs, untracked skills, a relocated package whose recorded path is gone or whose original path is now occupied, and a missing store all fail before any write. A consolidation run snapshots the packages at their post-run layout, so its `move` entries are the record of the pre-run paths. The ledger is read whole: a line that is not valid JSON fails the read with the ledger path and that line's number, so an operator repairs the evidence instead of reading past the damage.

### Adoption and purge

`adopt` claims one agent-created skill into user-directed standing through the telemetry `markAdopted` write, recording one operator ledger entry; anything without model authorship rejects, and the movement is one-way. `purge` removes archived skills past `archiveTtlDays`: the skill directory goes first (record-only when unresolvable), then the record drops, then one operator ledger entry lands per skill. Pinned skills stay, a zero TTL purges nothing, and `dryRun` previews the removal list without writing. `passes` lists recorded passes newest-first for status surfaces and rollback picks. `surveyCandidates` lists model-authored skills with verdict evidence — routing, state, idle age, use counters, the graded failure signals of the correlated sessions, and the skill's trust and revision — sorted by name, without writing; the keep/patch/consolidate verdict arrives separately.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionCurator` service, pass logic, host-wide trigger, rollback, and bookkeeping |
| [`src/drift.ts`](src/drift.ts) | Pure §22 drift signals: failure spike, conflicting newer evidence, low measured utility, dependency version change |
| [`src/consolidate.ts`](src/consolidate.ts) | Consolidation fork: survey framing, the bounded tool loop, the verifier-gated patch admission, and the full-package applier |
| [`src/safety.ts`](src/safety.ts) | Snapshots, ledger, blobs, pruning, package moves, and rollback read paths |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: bookkeeping schema and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public run options, transition, report, rollback, and pass types |

### Failure and recovery

A failing transition propagates and stops the pass: earlier movements stand, the report is discarded, and the bookkeeping stays unstamped so the next pass re-examines every skill. A failing scheduled pass is caught and warned, leaving the timer and the bookkeeping intact for the next tick. Invalid bookkeeping fails the domain open loudly: a lost `lastRunAt` would rerun the first-run deferral and shift the schedule. Reads throw before the curator starts.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-verifiers`](../evolution-verifiers/README.md) — the verifier-first ladder this package's consolidation patch admission runs.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-curator) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Consolidation fork

#### What the model sees

Only the opt-in consolidation calls a model; automatic transitions register nothing model-facing. Each request carries one auxiliary user message with the fixed instructions plus the JSON candidate survey, followed by the assistant tool calls and the curator's tool results. The request declares exactly two tools:

##### Tool whitelist

```markdown
skill_view(name, file?)                 — read one candidate package
skill_apply(name, action, into?, body?) — record one verdict
```

#### Token effect

Capped: at most `maxSteps` requests per run, each bounded by `maxInputBytes` of framed survey plus prior tool results, and `maxOutputTokens` of completion.

#### KV Cache effect

Independent of live requests: consolidation is a separate one-shot exchange with its own prefix, so it cannot invalidate provider cache reuse on a conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the curator is a poor fit. They are current package constraints.

- **Archiving a package moves files; dispositioning a lifecycle state does not** — an automatic `stale → archived` transition is telemetry only, while a consolidation `archive` verdict moves the whole directory into `.archive/`.
- **Trust is recorded, not enforced** — a skill's standing reaches the survey and the status line; it does not gate what the model may load.
- **Consolidation runs in-process** — a host plugin cannot fork the subagent seam headlessly, so the tool loop runs over `ctx.llm` instead of a child agent.
- **No protected text; no domain simulator built in** — `maxDiffLines` bounds size, not content: it has no notion of text a patch must never remove. `applyConsolidation` can now forward `simulation`/`evaluator`/`review` seams to the ladder and `requireVerifierPass` can demand a full pass, but this plugin's own pass mounts no seams and leaves `requireVerifierPass` at its default `false`, and no package in this repo implements a level-2 domain simulator to mount — building one, and a protected-text convention, are separate, larger decisions this package does not make unilaterally.
- **Merges rewrite directory references, not schedule entries** — a merge rewrites `${DSH_SKILL_DIR}` paths inside the moved package; no schedule entry references a skill yet, so `protectedNames` stays the schedule-reference guard.
- **Adoption is one-way** — adopted skills keep user-directed provenance; no operation returns them to agent-created.
- **Two §22 sources are not per-skill** — the knowledge graph's contradicted claims and the memory store's per-artifact `refutationCount` reach the ladder only as `conflicting-evidence` uncertainty signals, because no stored field links an artifact or a claim to a skill; there is likewise no task-class axis on skill usage, so a task-distribution shift is not derived at all.
- **Purge is off unless configured** — `archiveTtlDays` defaults to zero, so archived skills accumulate until a TTL is chosen.
- **Protected names are explicit** — schedule references enter through `protectedNames` until a schedule-to-skill seam exists to wire them automatically.
- **Machine-local only** — bookkeeping lives under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

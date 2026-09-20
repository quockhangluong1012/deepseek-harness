---
description: "Idle-triggered skill lifecycle curation: automatic active/stale/archived transitions with dry-run previews (ctx.evolutionCurator), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-curator

English | [中文](README.zh.md)

## Summary

`dsh-evolution-curator` runs the automatic, model-free half of skill lifecycle curation — skills move `active → stale → archived` over skill telemetry from idle age and failure evidence, with a revival path for stale skills whose newest load succeeded, plus dry-run previews, first-run deferral, and idle gating — and the opt-in, model-driven half: consolidation of agent-created skills into umbrellas. Pinned skills, protected names, and bundled or hub sources never move. The plugin is mounted once per host and owns its own schedule: it observes host-wide session activity, runs one start-time due-check, and then ticks. Real passes record what they did — every patched body keeps its preimage — and roll back fail-closed as a whole run or a single entry; manual adoption claims model-authored skills, and TTL purge removes archived skills with their directories; each pass also grades the failures correlated with a skill into that skill's trust standing. Without telemetry, automatic methods degrade to bookkeeping or empty reports.

Mounting is the whole trigger: `enabled: false` starts no timer and touches no bookkeeping.

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

Call `maybeRun` to run the same due-check yourself (the idle gate takes an explicit `idleMs` override), or `run` for an unconditional pass, with `dryRun: true` to preview the report without writing. A pass examines every tracked skill: idle age counts from the last load, or from seeding when never loaded. `active` moves to `stale` past `staleAfterDays` — or earlier on failure evidence: attributed trust failures at `staleTrustFailureFloor` with no newer load answering them, or a load failure rate past `stageFailureRate` over at least `stageMinUses` loads ending in a failed load. A `stale` skill whose most recent load succeeded, still inside the stale window and newer than its last attributed failure, returns to `active`; past `archiveAfterDays` it archives instead, so the horizon always wins over revival. The report names every movement with its reason plus skip counts for pins, protected names, and excluded sources, and carries the pass identity and snapshot filename when a snapshot was written. `lastRunAt` reads the last pass instant for status surfaces.

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
| `staleTrustFailureFloor` | `3` | Attributed trust failures moving `active` to `stale` while no newer load answers them |
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

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-curator) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One bookkeeping row in storage domain `evolution_curator`, version `1`, layout `per-record`, table `meta` under the single key `state`. Transitions apply through skill telemetry via `ctx.get`, so curation degrades to bookkeeping instead of failing when the store is unmounted. Unknown catalog names record under the `custom` source rather than escaping curation. The clock and the idle observation arrive as call arguments on `run`/`maybeRun`, while the mounted plugin adds the host-wide parts: a `session/event` listener keeping the newest activity instant, one awaited start-time due-check, and an `unref()`ed interval disposed through `ctx.effect`. Specs drive due and idle transitions with fake timers, so the plugin carries no test-only clock seam.

### Consolidation

`consolidate` is off by default and costs real model calls. When on, a real pass surveys the agent-created skills in `active` or `stale` state, frames them within `maxInputBytes`, and appends one `cost` ledger row `{inputBytes, maxOutputTokens, provider, model, truncated}` before the fork starts. Each candidate carries the failures recorded in the sessions that loaded it — up to `maxCandidateFailures`, read from the feedback store when one is mounted — so a verdict reflects what actually broke rather than what the skill's author intended. The fork is a bounded in-package tool loop over `ctx.llm` with a two-tool whitelist: `skill_view` reads one candidate package, `skill_apply` records one verdict (`keep`, `patch`, `consolidate`, `archive`) per candidate. The loop turns over at most `maxSteps` requests and ends at the first text-only answer; a failed request throws and the run's deadline aborts it at `timeoutMs`, as does plugin teardown.

The curator performs every write, so the full-package rule holds regardless of what the model asks. A `patch` rewrites `SKILL.md` in place after checking the body keeps valid frontmatter naming that skill — a body that would break the skill is skipped like any other inapplicable verdict, and the replaced text is stored as a content-addressed blob first. A `consolidate` verdict re-homes the candidate's whole directory under its umbrella (`<umbrella>/<name>/`), rewrites every `${DSH_SKILL_DIR}` reference in the moved tree to the new relative root, and appends a reference to the umbrella's `SKILL.md` — a package shipping `references/`, `templates/`, `scripts/`, or `assets/` is never flattened to `SKILL.md` alone. An `archive` verdict moves the whole directory into `.archive/` beside the skill. When the umbrella is missing, unwritable, or already owns a directory of that name, the package stays exactly where it is and the verdict counts as skipped. Merges record a `move` ledger entry carrying both endpoints, and lifecycle movements ride the same snapshot, `pass`, and `transition` machinery as an automatic pass; `rollbackPass` moves every relocated package back and restores the lifecycle states.

A host plugin cannot fork the subagent seam headlessly — an in-process provider inherits its route from a live parent session, which the curator has none of — so the loop runs in-process.

### Pass safety

A real pass with movements writes one tarball under the curator home (`snapshots/pass-<timestamp>-<id>.tar.gz`, pruned to `backup.keep`): staged before/after record pairs, resolvable skill directories, and a manifest. Unresolvable names land in the pass evidence instead of failing. One `pass` ledger entry plus one `transition` entry per movement append to the append-only JSONL ledger, with before/after record blobs stored content-addressed. `rollbackPass` restores lifecycle states, relocated packages, and the SKILL.md bodies the pass patched; `rollbackEntry` restores one lifecycle entry. Both verify every record, blob, and recorded move up front — a missing body preimage fails the rollback closed — snapshot current records first so each rollback stays reversible, and record one `rollback` entry per skill, reversed move, or restored body. A patch row written before bodies were snapshotted carries no preimage and is skipped. Unknown ids, missing blobs, untracked skills, a relocated package whose recorded path is gone or whose original path is now occupied, and a missing store all fail before any write. A consolidation run snapshots the packages at their post-run layout, so its `move` entries are the record of the pre-run paths. The ledger is read whole: a line that is not valid JSON fails the read with the ledger path and that line's number, so an operator repairs the evidence instead of reading past the damage.

### Adoption and purge

`adopt` claims one agent-created skill into user-directed standing through the telemetry `markAdopted` write, recording one operator ledger entry; anything without model authorship rejects, and the movement is one-way. `purge` removes archived skills past `archiveTtlDays`: the skill directory goes first (record-only when unresolvable), then the record drops, then one operator ledger entry lands per skill. Pinned skills stay, a zero TTL purges nothing, and `dryRun` previews the removal list without writing. `passes` lists recorded passes newest-first for status surfaces and rollback picks. `surveyCandidates` lists model-authored skills with verdict evidence — routing, state, idle age, use counters, the graded failure signals of the correlated sessions, and the skill's trust and revision — sorted by name, without writing; the keep/patch/consolidate verdict arrives separately.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionCurator` service, pass logic, host-wide trigger, rollback, and bookkeeping |
| [`src/consolidate.ts`](src/consolidate.ts) | Consolidation fork: survey framing, the bounded tool loop, and the full-package applier |
| [`src/safety.ts`](src/safety.ts) | Snapshots, ledger, blobs, pruning, package moves, and rollback read paths |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: bookkeeping schema and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public run options, transition, report, rollback, and pass types |

### Failure and recovery

A failing transition propagates and stops the pass: earlier movements stand, the report is discarded, and the bookkeeping stays unstamped so the next pass re-examines every skill. A failing scheduled pass is caught and warned, leaving the timer and the bookkeeping intact for the next tick. Invalid bookkeeping fails the domain open loudly: a lost `lastRunAt` would rerun the first-run deferral and shift the schedule. Reads throw before the curator starts. Teardown aborts a consolidation run in flight.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-curator) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

Automatic transitions register nothing model-facing. Only the opt-in consolidation calls a model.

### Consolidation fork

#### What the model sees

One auxiliary user message carrying the fixed instructions plus the JSON candidate survey, followed by the assistant tool calls and the curator's tool results. The request declares exactly two tools:

##### Tool whitelist

```text
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
- **Merges rewrite directory references, not schedule entries** — a merge rewrites `${DSH_SKILL_DIR}` paths inside the moved package; no schedule entry references a skill yet, so `protectedNames` stays the schedule-reference guard.
- **Adoption is one-way** — adopted skills keep user-directed provenance; no operation returns them to agent-created.
- **Purge is off unless configured** — `archiveTtlDays` defaults to zero, so archived skills accumulate until a TTL is chosen.
- **Protected names are explicit** — schedule references enter through `protectedNames` until a schedule-to-skill seam exists to wire them automatically.
- **Machine-local only** — bookkeeping lives under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

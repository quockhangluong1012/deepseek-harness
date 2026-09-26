---
description: "Durable per-skill use/view/patch telemetry with a creation record, pin, and lifecycle state (ctx.evolutionSkillTelemetry), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-skill-telemetry

English | [中文](README.zh.md)

## Summary

`dsh-evolution-skill-telemetry` owns the durable per-skill counters behind skill curation: successful model loads, human views, and management mutations, plus a creation record, pinning, lifecycle state, evidence-backed trust, a body-revision chain, and the §40 utility reading from graded task outcomes. Hosts read it synchronously and mark mutations explicitly; a passive `tools/post-execute` observer counts successful `skill`-tool loads, and bundled and hub skills are excluded from every write. It counts repeated produced outputs as skill-creation evidence and records the cost of a consolidation-scale run before its fan-out. Choose it when curation (staleness, consolidation, deletion) should rest on observed use and outcomes, not guesses.

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

Mount the plugin when skill curation needs durable usage evidence. Records are keyed by skill name; an absent record reads as `undefined` and seeds on first mark. Reads are synchronous from validated memory and return detached copies. `markUsed`, `markViewed`, `markFailed`, and `markPatched` resolve to `undefined` for bundled and `hub*` sources instead of writing. `markAgentCreated` records model authorship — the model wrote the skill through `skill_manage`, vouched for later with `/curator adopt` — and resolves without writing when the record already carries both facts. `markAdopted` claims one model-authored skill into user-directed standing without resetting clocks, rejecting missing records and anything without model authorship. `recordTrustObservation(name, outcome, sessionId, failure?)` records one trust observation: a failure with attribution demotes the skill and restamps its anchor, while a success counts only when its session is newer than that anchor and has not counted yet. Either way the session's graded outcome is stored on the record, and `utility(name)` reads the §40 utility record derived from those outcomes. `markRevised(name, content)` hashes the body it was given and advances the revision chain; the same bytes again is a no-op. `drop` forgets one record, reporting whether one existed. A successful `skill`-tool load counts through `markUsed` and stamps `lastOutcome: 'ok'`; a failed load counts through `markFailed`, which bumps `failureCount` and stamps `lastOutcome: 'failed'`. Consumers compute the failure rate as `failureCount / (useCount + failureCount)`.

Two surfaces exist beside the counters. `skillCreationEvidence(paths)` counts produced outputs that repeat, grouping by normalized path (case-folded, `/` and `\` alike, trailing separators ignored) and firing at three repeats — the counted trigger for proposing a skill; it never reads or quotes file content, and no vendor-reported repetition number feeds it. `skillProposalMergeKey(paths)` builds the candidate merge key for the fired paths with the same normalization, order-independently, so re-staging the proposal while it is pending bumps its recurrence instead of duplicating it. `recordConsolidationCost(row)` stores the `{ inputBytes, maxOutputTokens, provider, model, truncated }` row a consolidation-scale run records before its fan-out, and `readConsolidationCost()` returns a detached copy of the latest row or `undefined` when none was recorded.

### Lifecycle states

A skill's `state` follows `active → suspect → stale → archived`. `suspect` is the evidence rung §22 asks for: the curator's pass moves a skill there when recorded evidence — a failure spike, conflicting newer evidence, low measured utility, or a changed dependency version — questions it, and idleness is what moves a skill from `suspect` to `stale`. Entering `suspect` stamps `suspectAt` and leaving it clears the stamp, so a revival is judged against the instant the question was raised rather than against any older clean load. `archivedAt` works the same way. Records written before the member existed carry no `state` and open as `active`.

### Trust and revisions

Trust is `provisional` or `trusted`, derived from independent observations rather than elapsed time. A record starts `trusted` because no evidence exists against it; only an artifact the model wrote (`markAgentCreated`) or that was just edited (`markPatched`, `markRevised`) drops it to `provisional`, which also clears the counted sessions and re-anchors the record at the newest session seen so far. `trustPromotionSessions` newer sessions then promote it back. `trustFailures` counts evidence-driven demotions, and `lastTrustFailure` carries the `mergeKey`/`message`/`at` of the failure that caused the latest one.

The revision chain is linear and keyed by skill name: `revision` starts at 0, `contentSha` is the sha256-hex of the current SKILL.md body, and `parentRevisionSha` is the hash the current revision replaced. Every body change through `markRevised` also commits one row to the durable version registry, and `versions(name)` lists the committed revisions oldest first — revision number, the body hash it committed, the parent hash it replaced, and the recording instant — so lineage is queryable without re-reading files. The same bytes again is a no-op for both the record and the registry; a `drop` clears the history with the record; and excluded sources keep no rows.

### Skill utility

§40 judges a skill by downstream value, and this store keeps the evidence it can: the spec's `uses` is the load counter, `assisted_tasks` is the sessions whose outcome was graded, `successful_tasks` is the graded sessions with no attributable failure, and `cost_overhead` is `uses / successful_tasks` — recorded loads per success, never an estimate.

The specification's `incremental_gain` compares a skill against a no-skill baseline, and this harness records no skill-free run: every counter here belongs to a session that loaded a skill. `incrementalGain` is therefore the **library-relative success excess** — the skill's clean-outcome share minus the pooled clean-outcome share of the other tracked skills — which answers "is this skill better than the library's other skills", not "is it better than doing without one". It is `null` when either share is missing (no assisted task, or no peer with one), and `costOverhead` is `null` when no assisted task succeeded. Per-session outcome evidence clears when the body changes, like trust, so a rewritten body is never credited with the previous body's results.

### Session correlation

`markUsed(name, source, sessionId)` and `markFailed(name, source, sessionId)` record the loading session beside the counter — newest first, deduplicated, capped by `maxSessionIds`. A failed load counts as the skill being in play, so a session that only ever failed to load the skill is still correlated with it. The passive observer supplies the session it ran for, so the correlation needs no extra wiring. This is what lets a consumer pull the failures recorded while a skill was in play, which is the evidence a consolidation verdict reflects on. Views and mutations record no session.

### Configuration

Both fields are validated `Config` members changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-skill-telemetry'
  config:
    maxSessionIds: 20
    trustPromotionSessions: 3
```

| Field | Default | Meaning |
|---|---|---|
| `maxSessionIds` | `20` | Sessions retained per skill for failure correlation, newest first |
| `trustPromotionSessions` | `2` | Independently observed successes that promote a provisional skill to trusted |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-skill-telemetry) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One durable record per skill name in storage domain `evolution_skill_usage`, version `2`, layout `per-record`, table `records`; records written under version `1` open unchanged because the fields added since are defaulted. Source exclusion is a write-time decision shared with the manage package through `isExcludedSkillSource`: bundled skills ship with the product and hub skills arrive from sharing, so neither is locally curated. The observer delegates the tool chain first and only then counts, so telemetry never changes a load outcome; a failing skill provider falls back to the `custom` source rather than losing the count.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionSkillTelemetry` service, marks, session correlation, and the `tools/post-execute` observer |
| [`src/utility.ts`](src/utility.ts) | Pure §40 utility derivation: uses, assisted and successful tasks, library-relative gain, recorded cost per success |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: record schema and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public `SkillUsageRecord`, lifecycle state, creation record, trust state and failure, per-session outcomes, repeated-output evidence, and consolidation cost-row types |

### Failure and recovery

A failing write propagates to the caller, except inside the observer, which logs and keeps the tool result. Marks seed the record on first touch and resolve without writing when nothing changes. `read` and `entries` throw before the store starts; every other method needs the open table the same way.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [Skill package map](../README.md) — the group's packages and their repository position.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-evolution-skill-manage`, whose `skill_manage` tool reports each mutation here and refuses pinned deletions.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the telemetry is a poor fit. They are current package constraints.

- **Machine-local only** — records live under `$DSH_HOME`, never inside the project directory.
- **Only counted flows count** — direct file edits outside `skill_manage` and loads outside the `skill` tool never reach a counter.
- **Correlation is bounded and load-only** — only the most recent `maxSessionIds` sessions are retained per skill, and only `skill`-tool loads contribute; views and mutations record no session.
- **Bundled and hub skills are invisible** — excluded sources never seed records, so curation sees only locally owned skills.
- **Trust advances at the consumer's cadence** — the curator records observations once per pass, so promotion needs independent sessions, not repeated turns within one.
- **Trust is recorded, not enforced** — the standing reaches the survey and the status line; it does not gate a skill's visibility to the model.
- **Utility has no skill-free arm** — `incrementalGain` compares a skill against the library's other tracked skills, because nothing records what a task would have scored without any skill loaded; a true §40 `incremental_gain` needs that control arm, which no store in this harness has.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

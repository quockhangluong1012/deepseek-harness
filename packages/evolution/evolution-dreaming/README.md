---
description: "Three-phase dreaming consolidation: scores recorded failures with the six-signal composite and promotes attributed, gated, deduplicated narratives into durable per-scope dreams (ctx.evolutionDreaming)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-dreaming

English | [中文](README.zh.md)

## Summary

Turn a scope's recorded failures into durable memory in three sleep phases: Light deduplicates gathered failures and episodic notes, REM derives shared themes into a narrative, and Deep scores candidates on the six-signal composite, admitting only attributable evidence clearing every threshold. Candidates restating a held narrative fold in; correcting ones retire the predecessor; promotions keep their preimage, so rollback restores it. One command or the idle heartbeat runs it; `/dream <phase>` runs one phase for diagnosis. Weights are fixed; thresholds, cadence, and retention are configurable. Promotions are durable but unread in model context: mount to consolidate, not recall.

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

Mount it next to the feedback store and, for the automatic cycle, the heartbeat:

```yaml
- name: '@deepseek-ai/dsh-evolution-feedback'
- name: '@deepseek-ai/dsh-evolution-heartbeat'
- name: '@deepseek-ai/dsh-evolution-dreaming'
  config:
    minScore: 0.65
    minRecallCount: 3
    minUniqueQueries: 2
```

```ts
await ctx.evolutionDreaming.dream(scope, sessionIds)   // light → REM → deep
ctx.evolutionDreaming.read(scope)                      // narratives, promotions, ledger
ctx.evolutionDreaming.promotions(scope)                // only the narratives that still answer
ctx.evolutionDreaming.ledger(scope)                    // the passes a rollback can name
await ctx.evolutionDreaming.rollback(scope, entryId)   // restore what one pass replaced
```

`run(phase, scope, sessionIds, now?)` runs one phase for diagnosis; `dream(…)` runs the whole cycle; `dreamAll()` walks every workspace the registry knows and is what the heartbeat task calls. `promotions(scope)` answers with the narratives a correction has not retired, and `rollback(scope, entryId)` restores the promotions array the ledger entry `entryId` replaced.

At the prompt, `/dream` runs the cycle for the invoking scope and `/dream <phase>` runs one phase, both over the sessions the workspace owns.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `minScore` | `0.65` | Composite a candidate must reach to be admitted |
| `minRecallCount` | `3` | Sightings a candidate must reach |
| `minUniqueQueries` | `2` | Distinct sessions a candidate must appear in |
| `staleAfterDays` | `30` | Days a promotion stays durable without being seen again |
| `capacityTriggerRatio` | `0.8` | Share of `maxPromotions` above which the survivors are trimmed to the hard bound |
| `intervalHours` | `6` | Hours between two automatic cycles |
| `maxNarratives` | `20` | Narratives retained per scope |
| `maxPromotions` | `200` | Promotions retained per scope |
| `maxCandidates` | `500` | Candidates one cycle scores |
| `mergeOverlap` | `0.6` | Concept overlap at or above which a candidate restates a narrative the scope holds |
| `supersedeOverlap` | `0.3` | Lower overlap at or above which a candidate corrects the narrative it shares a tool with |
| `maxRestatements` | `5` | Statements one narrative retains as the restatements it absorbed |
| `maxLedgerEntries` | `10` | Promotion passes retained per scope for rollback |
| `profile` | `default` | Scope-identity namespace; must match the profile the readers of these dreams use |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-dreaming) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### The six signals

Each dimension is normalized to `0..1` before weighting, so no signal can dominate by carrying an unbounded raw count:

| Signal | Weight | Normalization |
|---|---|---|
| Relevance | 0.30 | Concept overlap with the text the scope already holds |
| Frequency | 0.24 | `count / (count + 3)` — one half at the recall gate |
| Query diversity | 0.15 | `sessions / (sessions + 2)` — one half at the diversity gate |
| Recency | 0.15 | Halves every 30 days from the last sighting |
| Integration | 0.10 | Days between first and last sighting, full at a week |
| Concept richness | 0.06 | Distinct words, full at twelve |

### Which evidence may promote

A candidate gathers sightings from two sources, and only one of them can vouch for it:

- **Attributed** — the feedback seam's aggregate of failing `tool/result` events. The harness watched the call and its result as they were delivered, so the recorded message carries the tool and the session beside it, and the evidence names where it came from.
- **Unattributed** — an episodic note from the memory store's daily log. That tier records a note's text, its day, and its instant, and nothing that identifies who wrote it: a model extraction, the user, and a system notice read alike. A candidate resting only on such sightings is refused by name (`unattributed-sighting`) whatever it scores, because no gate can vouch for text whose source the store does not record.

One observed sighting vouches for the candidate it folds into, so an episodic note that restates a recorded failure adds to that failure's evidence without ever being able to promote on its own. The gate's decision is a pure rule with its inputs recorded: each admitted narrative keeps the attribution and the counts the gate judged, and each pass reports the candidates it refused by the named gate that refused them.

### Merge and supersede

A narrative's identity is its normalized statement, and the statement never changes: a corrected statement is a second narrative, not an edit. A candidate that clears the gate is compared against the narratives the scope still answers with, and against no other tool's, because two failures of different tools are two subjects however alike their wording. Concept overlap, the same lexical measure the relevance signal reads, decides what it is:

- at or above `mergeOverlap` it restates that narrative, so it folds into it and the retained wordings are listed on the narrative — the durable record collects no near-duplicates, and the canonical statement, its promotion instant, and its evidence stay put;
- between `supersedeOverlap` and `mergeOverlap` it corrects it: a new narrative answers, and the predecessor is marked with the identity of the narrative that replaced it and when. The predecessor keeps its place and its evidence and answers no query, which is exactly what a retired claim does in the claim graph.

An identity the record already answers to — the canonical statement itself, or a wording it absorbed — writes no second narrative, but it does move that narrative's promotion instant, which is what keeps a recurring failure durable while the scope keeps recording it. Every candidate is related against the narratives the same pass has already written, so two restatements arriving together produce one narrative.

### Phase separation

Only the deep phase writes durable memory. Light and REM may run on their own for inspection without changing what the scope has learned, and the automatic cycle runs all three in order. Both writing phases merge into the record current at their write on the domain's write chain, not into the snapshot the phase read first, so a REM narrative and a deep pass that overlap keep both of their fields. Episodic notes re-stage while the memory retention window keeps them, so a note is re-scored with decayed recency rather than tracked as consumed. Promotions live in the plugin's own domain, never in the model-owned lessons document, so two writers never contend for one document.

### Ledger and rollback

Every pass that promotes, folds, retires, or drops a narrative writes one ledger entry, and the entry holds the promotions array the pass replaced as its preimage together with what it installed. A pass that only moved a promotion instant writes the record without an entry: it folded, retired, and dropped nothing, so a rollback has nothing of its own to restore and the bounded ledger keeps its room for the passes that moved narratives. The record is its own blob store, so a preimage cannot go missing between the write and the rollback that reads it, and the entry's evidence records what the pass did — added, folded, retired, dropped — for audit. `rollback(scope, entryId)` fails closed on an unknown identity before anything is written, restores the preimage exactly, and ledgers its own entry, which makes the rollback as reversible as the pass it undid. The ledger is bounded by `maxLedgerEntries`, newest kept, so a long-lived scope keeps a rollback window rather than every pass it ever ran.

### Failure and recovery

Invalid records fail the domain open loudly: a dropped promotion would silently re-offer a consolidated candidate to the next cycle. A missing feedback or memory seam degrades that phase rather than failing the cycle, and a missing heartbeat simply means no automatic schedule. No invariant companion is published because the domain table is the only copy of this state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-evolution-feedback`](../evolution-feedback/README.md) — the recorded failures this cycle consumes.
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.md) — the idle-triggered scheduler that drives it.
- [`dsh-evolution-curator`](../evolution-curator/README.md) — the ledger and rollback shape this package follows.
- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract behind the self-learning family.

-----

<a id="model-experience"></a>
## Model Experience

None, as the cycle adds no content: it scores, gates, folds, retires, and ledgers observations the feedback seam already recorded, and no prompt section, tool schema, or request carries its output yet. No rule on the promotion path calls a model.

#### KV Cache effect

None: the cycle makes no model call, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The read half is deferred** — nothing injects a promoted dream into model context. The one consumer that puts scope memory in front of a model is `dsh-evolution-memory-context`, which builds its brief from the memory store's curated families under its own byte budget and digest contract, and a dream is not one of those families: wiring it in changes another package's prompt surface and needs a logged session event for the injected text. Until that lands, `promotions(scope)` is the answering seam a consumer would call, and the statements it returns restate failures the transcript and the lessons family already carry.
- **The relation rule is lexical** — restatement and correction are decided by shared words, so a paraphrase without shared vocabulary is a new narrative and a correction phrased with the original's words can fold. An embedding provider or a declared relation from the writer would decide both.
- **Relevance is lexical** — the signal compares concepts as words. A semantic comparison through an embedding provider would rank candidates whose wording differs more strictly.
- **A fold keeps the canonical statement, not the better wording** — the first narrative promoted answers for every restatement folded into it, even when a later wording described the failure better.
- **A fold does not reset the decay clock** — `staleAfterDays` measures from the promotion instant, which only a candidate the record already answers to (the canonical statement, or a wording it absorbed) moves; a new restatement folds into the narrative without moving it, so a narrative older than the window can absorb one and be dropped by the same pass. A merge after a long silence is better served by the failure being staged again, which promotes a fresh narrative.
- **Heartbeat cadence is fixed per deployment** — one `intervalHours` applies to every scope.
- **Machine-local only** — dreams live under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The service renders on the Evolutionary Harness subsystem page and in the capability-seams graph, reachable through the `/dream` command in `dsh-command-evolution`.

</details>

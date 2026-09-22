---
description: "Human-facing /memory, /skills, /journey, /curator, /refine, /trajectory, /learn, /suggestions, and /frontier commands governing staged evolution writes, scope activity, session export, and skill curation (ctx.commands), for hosts governing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-evolution

English | [中文](README.zh.md)

## Summary

`dsh-command-evolution` gives chat UIs the human governance of the evolution harness: `/memory` and `/skills` approve or reject staged writes, `/journey` shows the scope's recorded activity, `/curator` reports curation bookkeeping, runs one maintenance pass, and lists skills staged for review, `/refine` rebuilds the scope's lessons, `/trajectory` exports the session or scope, `/dream` consolidates recorded failures into memory, `/frontier` ranks capabilities weakest first from measured evidence, and `/suggestions` lists blueprint-backed skills without scheduling them. Every command but `/learn` answers directly; `/learn` queues one ordinary turn. Choose them when a human must govern what background review proposed before it lands.

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

Type `/memory` or `/refine` in a chat UI when background review staged proposals for the current workspace scope. Scopes resolve the injector way — registry session ids first, falling back to a canonical-path `cwd` match — under the required `profile`; sessions outside any workspace get `This session is outside any workspace scope.` instead of a guess.

### Configuration

`profile` is required: the deployment must name which scope namespace the commands govern. Scopes never share a default namespace.

```yaml
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

| Field | Default | Meaning |
|---|---|---|
| `profile` | required | Scope-identity namespace placed before the workspace key |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-evolution) is the exhaustive source for every accepted field.

### Using the commands

| Input | Result |
|---|---|
| `/memory`, `/memory pending` | List the scope's staged entries as `- <id> [<kind>:<op>] <gist> (session '<origin>', <instant>)`, or `No pending writes.` when nothing awaits approval. An `applyDecisions` entry continues with one indented line per decision. Bare `/memory` reports the same list. |
| `/memory approve <id>` | Apply one memory-kind entry and report `Approved staged <op> (<gist>).`; an unknown id reports `No staged write '<id>'.`; a skill-kind id is redirected to `/skills approve`. |
| `/memory reject <id>` | Drop one entry without applying it and report `Rejected staged write '<id>'.`. |
| `/memory <anything-else>` | `Usage: /memory pending \| approve <id> \| reject <id>` — the grammar is fixed. |
| `/skills`, `/skills pending` | List the scope's staged skill entries, or the empty state naming where proposals come from. Bare `/skills` reports the same list. |
| `/skills approve <id>` | Drop a staged skill entry whose skill write already landed and report the approval with that reminder; an id that is not a staged skill reports `No staged skill '<id>'.`. A creation proposal without a valid capture contract stays staged and reports the missing evidence; a patch is admitted on its approval alone. |
| `/skills <anything-else>` | `Usage: /skills pending \| approve <id>`. |
| `/journey [today\|7d\|30d\|all]` | Render the scope timeline: the window header, one line per active day, capacity and digest, and the staged count. Bare `/journey` reports `7d`. |
| `/journey export [today\|7d\|30d\|all] [--out <path>]` | Bundle the journey timeline and the current session log into a zip archive and report `Journey exported to <path>`; the path defaults to `$DSH_HOME/exports/journey-<scope>-<range>.zip`. A grammar the parser rejects reports `Usage: /journey export [today \| 7d \| 30d \| all] [--out <path>]`. |
| `/journey <anything-else>` | `Usage: /journey [today \| 7d \| 30d \| all]`. |
| `/curator status` | Render the last pass instant, tracked-skill counts by lifecycle state with pins and trust standing, today's cache-hit share from the usage ledger, the aggregate skill failure rate from telemetry, the staged-for-review count with the worst rate, and the newest recorded pass. Either rate names its missing source when unmounted. |
| `/curator run` | Run one maintenance pass now: report the movements, skip counts, and snapshot id. |
| `/curator run --dry-run` | The same pass previewed without writing; the snapshot line reads `Snapshot: none`. |
| `/curator staged` | List the skills the ledger stages for review, worst failure rate first, with the evidence that selected each and when it was staged. |
| `/curator optimize <skill> <scenario...>` | Run one offline optimization over the named corpus scenarios and report the staged skill patch id, or the reason nothing was staged. Requires the optimizer mounted and a workspace scope. |
| `/curator experiments [skill]` | Print the scope's optimization ledger newest first — time, skill, outcome, the operators that produced candidates, the staged id with the operator that produced it, the `+added/-removed` line counts on promoting rows, confidence tally, and reason — so a second run starts from what was already tried. Requires the optimizer mounted and a workspace scope. |
| `/curator adopt <name>` | Claim model-authored skills into user-directed standing and report `Adopted '<name>' (state: <state>)`; anything without model authorship rejects. |
| `/curator purge [--dry-run]` | Remove archived skills past their TTL and report the directory-or-record removals and pin skips; `--dry-run` previews the list without writing. |
| `/curator rollback --id <id>` | Roll one recorded pass back: report the restored lifecycle states, then `Restored bodies: <names>` when SKILL.md bodies were restored from their preimages. |
| `/curator ledger` | List recorded passes newest-first with their transition counts. |
| `/curator pin <name>` / `/curator unpin <name>` | Pin or unpin one tracked skill and report `Pinned '<name>'` / `Unpinned '<name>'`. |
| `/curator history <name>` | List one skill's committed body revisions oldest first as `<n> revision(s) for '<name>':` then `- r<n> <sha8>[ ← r<n-1> <parentSha8>] (<instant>)`; nothing recorded reports `No recorded revisions for '<name>'.` Pin, unpin, and history read telemetry only: without it they report `Skill telemetry is not mounted. Pin, unpin, and history require the telemetry store.` |
| `/curator <anything-else>` | `Usage: /curator status \| run [--dry-run] \| staged \| adopt <name> \| purge [--dry-run] \| rollback --id <id> \| ledger \| pin <name> \| unpin <name> \| history <name> \| optimize <skill> <scenario...> \| experiments [skill]`. |
| `/refine` | Rebuild the scope's lessons through the reviewer and report `Memory rebuild complete.`. |
| `/refine <anything>` | `Usage: /refine (no arguments)` — the command takes no arguments. |
| `/trajectory` | Export the invoking session through the trajectory service and report `Trajectory written to <path> (<n> conversations, <n> bytes).`. |
| `/dream [light\|rem\|deep]` | Consolidate this scope's recorded failures into durable memory, or run one phase; reports what each phase scanned, staged, promoted, and pruned. |
| `/trajectory --out <path>` | The same export written to the given path. |
| `/trajectory --all` | Export every session of the invoking workspace's scope instead of the current session. |
| `/trajectory <anything-else>` | `Usage: /trajectory [--out <path>] [--all]`. |
| `/learn <anything>` | Build a research-and-save prompt and queue it as one ordinary turn: `Started a learning turn for '<topic>'. The skill lands only through the gated skill_manage write.` |
| `/learn` | `Usage: /learn <anything>` — the command needs a topic. |
| `/suggestions` | List the skills whose frontmatter declares a blueprint, as `- <name>: <description> (schedule <schedule>, deliver <session\|file>)`, plus the reminder that nothing is scheduled. |
| `/suggestions <anything>` | `Usage: /suggestions (no arguments)`. |
| `/frontier` | Rank this scope's skills weakest first from measured evidence, as `- <name>: <score> [<wins>/<runs>] [· <n> failures [(top: '<message>')]] · <loads> loads in <sessions> sessions[: <description>]`, ending with the ranking rule. |
| `/frontier <anything>` | `Usage: /frontier (no arguments)`. |
| `/budget` | Settle every recorded batch against its allocation, as `- <batchId> (<candidateClass>, <taskClass>): <spent>/<maxTokens> tokens, <spentMs>/<maxWallTimeMs>ms` with the exact margin left, or `EXCEEDED by <tokens> tokens, <ms>ms` past it. A batch whose allocation priced §37's later dimensions continues with `· cost <spent>/<ceiling> — <left> left, time <spentMs>/<ceiling>ms, parallelism <spent>/<ceiling>`, and a priced dimension nothing recorded reads `unmeasured (ceiling <n>)` rather than a zero it cannot prove; an unpriced dimension is not rendered. Bare `/budget` lists every batch. |
| `/budget spends [<batchId>]` | List the recorded spends, as `- <batchId>: <tokens> tokens, <wallTimeMs>ms, <n> rollouts at <instant>`. |
| `/budget <anything-else>` | `Usage: /budget [spends [<batchId>]]`. |
| `/meta` | List the engine configurations recorded on any task class, best score first, as `- <configId> (<taskClass>): <pct>% pass over <n> runs, <tokens> mean tokens, score <score>`. |
| `/meta runs [<taskClass>]` | List the recorded engine runs, as `- <runId> (<taskClass>) pass\|fail, <tokens> tokens, <wallTimeMs>ms at <instant>`. |
| `/meta recommend <taskClass>` | Name the configuration the store recommends for one task class with its operator, evaluator, budget, and routing choices, the workflow it ran as `workflow: <component>=<choice>>…` (or `workflow: unrecorded`), and the numbers behind the rank; a class without enough evidence reports so instead. |
| `/meta <anything-else>` | `Usage: /meta [summaries [<taskClass>] \| runs [<taskClass>] \| recommend <taskClass>]`. |
| `/operators <artifactClass>` | Rank that artifact class's mutation operators, best first, as `- <operator>: <n> attempts, <pct>% accepted, mean delta <delta>, <pct>% regressions, score <score>`. The acceptance and score come from the ranking; the regression rate is joined from the class's statistics rows. |
| `/operators` | Count the artifact classes with recorded statistics and name them, without ranking. |
| `/operators <anything-else>` | `Usage: /operators <artifactClass>`. |
| `/router` | List the measured route rows, as `- <provider>/<model> (<role>, <taskClass>): <pct>% pass over <n>, <tokens> mean tokens, <ms>ms mean`. |
| `/router effectiveness [<taskClass>] [<role>]` | The same list narrowed to the given task class and §28 role; an unusable role reports usage. |
| `/router recommend <taskClass> <role>` | Name the route the store recommends for that pair with the numbers behind the rank, or report that no route has enough outcomes yet. |
| `/router <anything-else>` | `Usage: /router [effectiveness [<taskClass>] [<role>] \| recommend <taskClass> <role>]`. |
| `/evaluator-strategy` | List the recorded evaluator trust rows, as `- <evaluator> (<taskClass>): <n>/<m> independent corroborations over <n> verdicts, weight <weight> at <instant>`. |
| `/evaluator-strategy rank <taskClass>` | Rank that class's evaluators most trusted first, with the corroboration counts and weight behind each rank. |
| `/evaluator-strategy <anything-else>` | `Usage: /evaluator-strategy [strategies [<taskClass>] \| rank <taskClass>]`. |
| `/metrics [<taskClass>]` | Report the north-star metric and the supporting set over the recorded engine runs, as `- <id>: <value> — <caveat>` with the store each value came from, or `- <id>: not measured — <reason>` naming the record that is missing. |
| `/graph <entity>` | List the entity's immediate connections as `<label>:` followed by one `- <path> → <label>` line per neighbour reached in one hop; an entity this scope's graph does not hold reports `No entity matching '<entity>' in this scope's graph.` Without the graph mounted: `The knowledge graph is not mounted.` |
| `/graph <entity> <relation>` | Traverse one relation outward and render `<subject> —<relation>→ <object>, <object>`; a subject without that relation reports `<subject> has no '<relation>' relation.`, and an unknown entity the same `No entity matching` message. A double-quoted argument keeps its spaces together. |
| `/graph <anything-else>` | `Usage: /graph <entity> [relation]` |
| `/claims [query]` | List the scope's active claims most believed first as `<n> active claim(s):` followed by `- <statement> [confidence <x.xx>, <n> supporting / <n> contradicting source(s), evidence <x.xx>, source <x.xx>, newest <instant>]`; a query matching nothing reports `No active claim matching '<query>' in this scope.`, and a retired claim is never listed. |
| `/claims <anything-else>` | `Usage: /claims [query]` — one query, quoted when it carries spaces. |
| `/reflection [limit]` | List the newest stored reflections of this scope's sessions as `<n> reflection(s) (newest first):` then one block per row: `- <symptom> (confidence <x.xx>)`, `  expected: <…>`, and `  cause:`, `  avoid:`, `  instead:`, `  check:` when recorded. The limit defaults to 5; nothing stored reports `No reflections stored for this scope.` Without the feedback store mounted: `The evolution feedback store is not mounted.` |
| `/reflection <anything-else>` | `Usage: /reflection [limit]` — the limit is an integer of at least 1. |
| `/trace <sessionId>` | Project that session's committed log into its learning trace: `Trace of <id>: <n> turn(s)` plus `, updated <instant>` (or ` (no events)`), then one `Turn <n> [<outcome>]` line per turn with its request, `  · <tool> ok` or `  · <tool> failed: <message>` per tool call, and `    ← <cause>` per ranked root cause. An unknown session reports `No trace for session '<id>'.` Without the trace store mounted: `The evolution trace store is not mounted.` |
| `/trace <anything-else>` | `Usage: /trace <sessionId>` — exactly one session id. |
| `/curriculum` | Measure the current capability gaps, stage one grounded task per gap, and list the open proposals: `Staged <n> new task(s).` or `No new tasks staged from the measured gaps.`, then `No open curriculum tasks.` or one `- <id> <capability>: <task>` line each. Without the curriculum store mounted: `The evolution curriculum store is not mounted.` |
| `/curriculum retire <id>` | Retire one staged proposal and report `Retired curriculum task '<id>' (<capability>).` |
| `/curriculum <anything-else>` | `Usage: /curriculum [retire <id>]` |
| `/benchmark` | Summarize the store by state as `Benchmark: <n> fresh, <n> search, <n> validation, <n> holdout, <n> contaminated, <n> retired.` and list up to ten fresh tasks as `- <id> <capability>: <task>`. Without the benchmark store mounted: `The evolution benchmark store is not mounted.` |
| `/benchmark admit` | Admit the curriculum's open proposals as fresh tasks and report `Admitted <n> benchmark task(s), <n> duplicate(s) skipped.`; without the curriculum store it reports `The evolution curriculum store is not mounted; admit needs open proposals.` |
| `/benchmark promote <id> [state]` | Move one task one rung up the learning ladder, or to the named state, and report `Promoted '<id>' to '<state>'.`; a task already at the ladder's end reports `No promotion from '<state>' for '<id>'`, an unknown id `evolution-benchmark: unknown task '<id>'`. |
| `/benchmark retire <id>` | Retire one task and report `Retired '<id>'.` |
| `/benchmark <anything-else>` | `Usage: /benchmark [admit \| promote <id> [state] \| retire <id>]` |
| `/evaluators` | Summarize ensemble health as `Evaluator health: <n> verdict(s), approved <pct>% (recent <pct>%, drift ±<n> points), unanimous <pct>%, false positives <pct>% of approvals.` and `Channels: <channel> <pct>%, …`. Without the store mounted: `The evaluator-health store is not mounted.` |
| `/evaluators runs [<skill>]` | List the ten newest recorded verdicts as `<n> verdict(s):` then `- <id8> <skill>: <status>[ approved][ unanimous\| (split: <evaluators>)] at <instant>`; nothing recorded reports `No recorded evaluator verdicts.` |
| `/evaluators <anything-else>` | `Usage: /evaluators [runs [<skill>]]` — at most one skill. |
| `/population <skill>` | List the population as `Population '<skill>': generation <n>, <n> candidate(s).`, then `- g<n> <id8> [<status>] <operator>:` with `<pass> pass, <tokens> tokens, <ms>ms` or `unmeasured` when the triple is absent, closed by ` · root` or ` ← <parent8>`; finally `Elite: <id8> (g<n>), …` or `Elite: none approved yet.` A skill with none reports `No candidates recorded for '<skill>'.` Without the store mounted: `The evolution population store is not mounted.` |
| `/population <skill> lineage <id>` | Walk one candidate's ancestry oldest first from `Lineage of '<id>' in '<skill>':`, marking the newest `← newest`; an unknown id reports `No candidate '<id>' for skill '<skill>'.` |
| `/population <skill> approve <id>` / `/population <skill> reject <id>` | Move one staged candidate's standing and report `Marked candidate '<id8>' (g<n> <skill>) as '<approved\|rejected>'.` |
| `/population <anything-else>` | `Usage: /population <skill> [lineage <id> \| approve <id> \| reject <id>]` |
| `/routes` | List each role's recorded routes as `Routes:` then `<role>: <provider>/<model>[ (pinned)]: <n> run(s), <pct>% pass, <n> tokens avg · …[ → recommended <provider>/<model>]`; with none recorded: `No route assignments yet. The optimizer records candidate-generation routes; pin the rest.` Without the store mounted: `The evolution model-routes store is not mounted.` |
| `/routes pin <role> <provider> <model>` | Pin one route for a §28 role and report `Pinned '<role>' to <provider>/<model>.`; an unusable role or an empty provider or model reports the usage line. |
| `/routes evidence [<role>]` | List the ten newest evidence rows as `<n> evidence row(s):` then `- <id8> <role>: <provider>/<model> <pass> pass, <tokens> tokens at <instant>`; nothing recorded reports `No recorded route evidence.` |
| `/routes <anything-else>` | `Usage: /routes [pin <role> <provider> <model> \| evidence [<role>]]` |
| `/canary` | Summarize the deployments as `Canary: <n> shadow, <n> canary, <n> promoted, <n> rolled-back, <n> rejected.` and list up to ten as `- <id8> <skill>: <state>[ → next <stage>][ (<pass>, <tokens> tokens)]`; none yet reports `No deployments yet. The optimizer records staged writes as shadow.` Without the store mounted: `The evolution canary store is not mounted.` |
| `/canary status [<skill>]` | The same deployment list narrowed to one skill; a skill with none reports `No deployments for '<skill>'.` |
| `/canary rollout <id>` | Move one shadow deployment to canary and report `Deployment '<id8>' (<skill>) moved to '<state>'.` |
| `/canary promote <id>` | Move one canary deployment to promoted, with the same report. |
| `/canary reject <id>` | Exit one staged rollout to rejected, with the same report. |
| `/canary rollback <id>` | Exit one staged rollout to rolled-back, with the same report. |
| `/canary <anything-else>` | `Usage: /canary [status [<skill>] \| rollout <id> \| promote <id> \| reject <id> \| rollback <id>]` |
| `/novelty` | Summarize the archive as `Novelty archive: <n> entry(ies) across <n> skill(s).` then `- <skill>: <n> entry(ies), mean novelty <x.xx>`, sorted by skill; none recorded reports `No recorded novelty archive entries. The optimizer records staged writes as descriptors.` Without the store mounted: `The evolution novelty-search store is not mounted.` |
| `/novelty <skill>` | List one skill's descriptors as `Novelty archive '<skill>': <n> entry(ies), mean <x.xx>.` then up to ten `- <id8>: <n> features, novelty <x.xx> at <instant>` lines; a skill with none reports `No recorded novelty archive entries for '<skill>'.` |
| `/novelty <anything-else>` | `Usage: /novelty [<skill>]` |
| `/stagnation` | Summarize every skill with recorded runs as `Stagnation:` then `- <skill>: <n>/<threshold> generations since improvement` closed by ` — STAGNANT → <strategy>` or ` — ok`; none recorded reports `No recorded stagnation runs. The optimizer records staged writes as runs.` Without the store mounted: `The evolution stagnation store is not mounted.` |
| `/stagnation status <skill>` | Render one skill in three lines: `Stagnation '<skill>': <n> run(s), best <pass> pass, <tokens> tokens, <ms>ms.` (or `best no best yet.` when nothing is measured), `<n> generation(s) since improvement, threshold <threshold>.`, then `STAGNANT → strategy: <strategy>` or `Not stagnant — continue <strategy>.` |
| `/stagnation runs [<skill>]` | List the ten newest runs as `<n> run(s):` then `- g<n> <id8> <skill>: <pass> pass, <tokens> tokens, <ms>ms[ improved] at <instant>`; nothing recorded reports `No recorded stagnation runs.` |
| `/stagnation reset <skill>` | Drop that skill's history and report `Reset stagnation history of '<skill>': dropped <n> run(s).` |
| `/stagnation <anything-else>` | `Usage: /stagnation [status <skill> \| runs [<skill>] \| reset <skill>]` |
| `/islands` | List the lanes as `Islands:` then `- <island> '<name>' [<objective>] <skill> g<n>[ · migration due]`; none registered reports `No islands registered.` and points at the `/islands register <island> <name> <objective> <skill>` form. Without the store mounted: `The evolution islands store is not mounted.` |
| `/islands list [<skill>]` | The same schedule list narrowed to one skill, headed `Islands '<skill>':`. |
| `/islands register <island> <name> <objective> <skill>` | Register one lane and report `Registered island '<island>' '<name>' [<objective>] for '<skill>'.`; an objective outside the registered set reports the usage line. |
| `/islands migrate <from> <to> <candidate> [<reason>]` | Record one candidate migration and report `Migrated candidate '<id8>' <from> → <to> (<reason>).`; the reason is `schedule` (the default), `elite`, or `diversity`. |
| `/islands migrations [<skill>]` | List the ten newest log rows as `<n> migration(s):` then `- <id8> <candidate8> <from> → <to> (<reason>) at <instant>`; nothing recorded reports `No recorded island migrations.` |
| `/islands <anything-else>` | `Usage: /islands [list [<skill>] \| register <island> <name> <objective> <skill> \| migrate <from> <to> <candidate> [<reason>] \| migrations [<skill>]]` |
| `/selfmodel` | Render the capability frontier weakest first as `Capability frontier (weakest first): <n>`, then `- <capability>: score <x.xx>, confidence <x.xx>, <n> skill(s), <n> observations`, and `Next to learn: <capability>`; with nothing measured: `No measured capabilities yet. The optimizer records capability observations as it stages writes.` Without the store mounted: `The evolution self-model store is not mounted.` |
| `/selfmodel <skill>` | Render one recorded self-assessment as `Self-model '<skill>' (revision <n>, confidence <x.xx>):` followed by the non-empty `strengths`, `weaknesses`, `uncertain areas`, `failure modes`, `preferred tools`, and `evaluator blindspots` lists; an unrecorded skill reports `No self-assessment recorded for '<skill>'.` |
| `/selfmodel <anything-else>` | `Usage: /selfmodel [<skill>]` |
| `/uncertainty [<skill>]` | Render the queue as `Evaluation queue[ '<skill>']: <n>` then `- <skill> (skill-wide)` or `task <taskId>`: `priority <x.xx>, [<kinds>], <n> signals`; with no signals: `No uncertainty signals. The scorer records evaluator disagreement as signals.` Without the store mounted: `The evolution uncertainty store is not mounted.` |
| `/uncertainty <anything-else>` | `Usage: /uncertainty [<skill>]` |
| `/adversary` | List the recorded probes as `Adversarial probes[ '<skill>']: <n>` then `- <id8> [<category>] <skill>: weakness found` or `no weakness`, plus ` · repaired`; none recorded reports `No adversarial probes recorded.` and points at the `/adversary probe <skill> <category> <probe>` form. Without the store mounted: `The evolution adversary store is not mounted.` |
| `/adversary list [<skill>]` | The same probe list narrowed to one skill. |
| `/adversary probe <skill> <category> <probe>` | Record one probe, the phrase taking every word after the category, and report `Recorded a '<category>' probe for '<skill>'. Mark it repaired with /adversary repair <id> once the weakness is fixed.`; a category outside the registered set reports the usage line. |
| `/adversary repair <probeId>` | Mark one probe repaired and report `Marked probe '<id8>' repaired.` |
| `/adversary challenge <skill>` | Name the next probe to run: `Next adversarial probe for '<category>' (<n> recorded): <reason>` |
| `/adversary defenses` | List the evaluator-gaming checklist as `Evaluator-gaming defenses:` then `- <defense>: satisfied` or `- <defense>: open`; none recorded reports `No evaluator-gaming defenses recorded.` |
| `/adversary defense <name> <satisfied>` | Set one checklist entry from `true` or `false` and report `Set defense '<name>' to satisfied.` or `Set defense '<name>' to open.` |
| `/adversary <anything-else>` | `Usage: /adversary [list [<skill>] \| probe <skill> <category> <probe> \| repair <probeId> \| challenge <skill> \| defenses \| defense <name> <satisfied>]` |
| `/lineage` | List the envelopes newest first as `Experiments[ '<skill>'] (newest first): <n>` then `- <id8> <skill> <outcome> by <operator>` (`?` when unrecorded)`: <pass> pass, <tokens> tokens, <ms>ms`; none recorded reports `No experiment envelopes recorded. The optimizer records staged writes as envelopes.` Without the store mounted: `The evolution lineage store is not mounted.` |
| `/lineage list [<skill>]` | The same envelope list narrowed to one skill. |
| `/lineage compare <idA> <idB>` | Prove two envelopes comparable: `'<a8>' vs '<b8>': comparable — no compared dependency changed.` or `'<a8>' vs '<b8>': incomparable — changed dependencies: <names>.`; an unknown id reports `Unknown experiment id in /lineage compare.` |
| `/lineage replay <id>` | Render one envelope's record as `Experiment <id> (<skill>, <outcome> by <operator>):`, `- pass <bool>, <tokens> tokens, <ms>ms`, `- dependencies: <key=value, …>` or `- dependencies: none`, and `- seeds: <ids>` or `- seeds: not recorded`; an unknown id reports `Unknown experiment '<id8>'.` |
| `/lineage <anything-else>` | `Usage: /lineage [list [<skill>] \| compare <idA> <idB> \| replay <id>]` |
| `/sleeptime` | List the anticipated tasks likelihood-first as `Anticipated tasks[ '<domain>'] (likelihood first): <n>` then `- <taskId> (<domain>): <pct>%, <n> expected queries, <n> tokens each`; none anticipated reports `No anticipated tasks. Anticipate likely future tasks to seed sleep-time compute.` Without the store mounted: `The evolution sleeptime store is not mounted.` |
| `/sleeptime tasks [<domain>]` | The same task list narrowed to one domain. |
| `/sleeptime artifacts [<taskId>]` | List the precomputed artifacts as `Precomputed artifacts[ '<taskId>']: <n>` then `- <id8> [<kind>] for <taskId>: <n> hits, <n> tokens saved, cost <n>`; none recorded reports `No precomputed artifacts recorded.` |
| `/sleeptime plan` | Show the offline-cost plan as `Sleep-time plan:` then `- <taskId> (<domain>): net <n> tokens — <reason>`; nothing worth building reports `Nothing worth precomputing now. Anticipate tasks to seed the plan.` |
| `/sleeptime <anything-else>` | `Usage: /sleeptime [tasks [<domain>] \| artifacts [<taskId>] \| plan]` |

An `applyDecisions` entry names its batch in the gist — the counts of confirms, contradicts, and new — and continues under that line with one indented line per decision: `new '<statement>'`, `confirms '<current statement>'` or `contradicts '<current statement>'`, and `contradicts '<current statement>' → '<replacement>'` when the contradiction carried a corrected statement. A `confirms` or `contradicts` target renders as the statement the record currently holds for it, and as the artifact's id when the record no longer holds it — that id is the normalized statement the artifact was created from, so it still reads as text. Every other op prints its gist line alone, and so does an `applyDecisions` entry whose payload the renderer cannot read: an unreadable staged payload renders no detail lines instead of failing the list.

### What you see

The commands turn each expected failure into a stable message you can show directly; the situation on the left is what produced the message on the right.

| Situation | Message you see |
|---|---|
| Session outside any workspace (scoped commands) | `This session is outside any workspace scope.` |
| Approving a skill-kind entry through `/memory` | `Staged skill '<id>' (<op>) is decided by '/skills approve <id>': write the skill with skill_manage first, then approve there to drop the entry.` — the entry stays staged. |
| A cap or substring rejection on approve | `Cannot approve '<id>' (<code>): <detail>. The entry stays staged.` |
| A creation proposal without admission evidence on approve | `Cannot approve '<id>' (evolution/staged-blocked): staged evolution write '<id>' is blocked: <needed evidence>. The entry stays staged.` |
| Approving or rejecting an unknown id | `No staged write '<id>'.` |
| `/skills approve` for an id that is not a staged skill | `No staged skill '<id>'.` |
| `/refine` without the reviewer mounted | `The evolution reviewer is not mounted.` |
| `/curator status` without the curator mounted | `The evolution curator is not mounted.` |
| A rebuild rejection | `Memory rebuild failed (<code>): <detail>.` |
| `/trajectory` without the exporter mounted | `The evolution trajectory exporter is not mounted.` |
| `--all` outside every workspace scope | `This session is outside any workspace scope.` |
| A rejected export | `Trajectory export failed (<code>): <detail>.` |
| `/suggestions` without the skill registry mounted | `The skill registry is not mounted.` |
| `/frontier` without the optimizer mounted | `The evolution optimizer is not mounted.` |
| `/frontier` without telemetry mounted | `Skill telemetry is not mounted. The frontier needs the telemetry store.` |
| `/frontier` with no skills anywhere | `No measured capabilities yet.` |
| `/suggestions` with no blueprint-backed skill | `No blueprint-backed skills. A skill appears here when its frontmatter declares a blueprint; this command never installs the schedule it names.` |

Cancelling `/refine` stops the wait: the registry settles the invocation with the abort reason, matching the `/compact` cancellation contract. Failures other than these expected cases surface as errors rather than being silently converted.

### Composing the commands

Mount the command registry, a workspace registry, and the evolution memory store; `/refine` needs the reviewer, and `/curator` reads the curator plus skill telemetry when they are mounted:

```yaml
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-workspace'
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-evolution-reviewer'
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

Surfaces without `ctx.commands` cannot invoke them; staged writes then wait for a mounted command adapter or the controller. `/curator status` is host-wide and works from any session, including one outside every workspace scope; the curator, telemetry, trajectory exporter, reviewer, and skill registry are optional services read through `ctx.get`, so a deployment without them still gets the command with an honest short answer.

### What happens to the conversation

Approving applies the staged memory op through the store's own write chain, so cap and substring rejections keep the entry staged exactly as a direct store call would; rejecting drops either kind. A staged `applyDecisions` batch is one write: approval applies the whole batch against the record read at approval time, so a cap rejection keeps every decision of it staged together. The command lifecycle is recorded in the session log but never enters model history. `/learn` is the one command that starts a turn: it queues a prompt-authored message as the sole ordinary message of its own turn, and the model then gathers material with the tools it already has and proposes one skill through the gated `skill_manage` writer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the commands; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The commands are built on five commitments:

- **Governance without new durable state.** The plugin owns no domain: pending lists and the journey read the scope record (and the curator reads its own ledger through the curator service), mutations delegate to `approveStaged` / `rejectStaged`, rebuilds forward scope plus signal to `evolutionReviewer.rebuild`, exports forward the session or scope to `evolutionTrajectory`, and suggestions read the skill catalog. The store stays the single authority.
- **The approver performs skill writes first.** Approving a skill-kind entry only drops it in the store, so `/skills approve` says so: the human writes the skill (via `skill_manage`), then approves to drop the entry, and `/memory approve` redirects skill-kind ids there. Nothing is silently discarded or silently applied.
- **Reads report only what the record proves.** `/journey` emits a delta per fact the record carries — each document family from its own write stamp, every context item, every indexed output, every staged entry — and counts each decided entry on the day its decision landed, on the dashboard's UTC+7 calendar; it never guesses which field an unexplained `updatedAt` moved.
- **Queueing is not writing.** `/learn` builds a prompt and queues one ordinary turn; the command itself writes nothing, so the only save path is the proposal-gated `skill_manage`. `/suggestions` reads blueprints and schedules nothing.
- **Quiescent teardown.** The lifecycle effect unregisters the commands before draining already-started handlers, so root teardown cannot pass an in-flight rebuild the way `/compact` cannot pass an aborted compaction.

### Membership and scope

Scope resolution copies the injector's membership rule without its cache — commands are one-shot, so registry session ids plus the canonical-`cwd` fallback run per invocation with no retained state; `/curator status` is host-wide and resolves no scope at all. The `profile` gate matches the injector's: empty or `:`-carrying namespaces fail plugin load loudly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command registration, scope resolution, staged failure mapping, export failure mapping, the `/learn` prompt builder, blueprint parsing, lifecycle drain |
| [`src/journey.ts`](src/journey.ts) | Pure `/journey` read model: per-family and context/output/staged deltas, decided-entry counts, day buckets, cumulative accounting, rendering |
| — | No invariant companion is published; this command adapter owns no state or event stream; the evolution memory store owns the single durable domain table and the command registry owns registration and dispatch lifecycle. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the commands to the store, the reviewer, and the design decisions.

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract these commands govern.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Commands package](../../interaction/commands/README.md) — the registry and dispatch contract behind chat commands.
- [Usage ledger](../../session/usage-ledger/README.md) — the UTC+7 calendar and window helpers the journey buckets with.
- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — where the family's behaviour, including the CLI slice these commands land, is described (`/suggestions` remains planned).

-----

<a id="model-experience"></a>
## Model Experience

### Human governance commands

#### What the model sees

The slash inputs and the direct results (such as `No pending writes.`) never enter a model request. An approved memory write separately reaches the model later as part of the injected evolution brief; a rebuild rewrites the stored lessons the next brief renders. `/learn` is the exception by design: its prompt-builder output is queued as an ordinary user-role turn, so the model sees exactly the research-and-save instruction the command built — including the reminder that the `skill_manage` write is proposal-gated.

#### Token effect

The command lifecycle adds no model tokens; results are human-only command text. `/learn` starts a turn, so it spends the same tokens any other turn on that prompt would.

#### KV Cache effect

Discovery and command bookkeeping do not affect the cache. An approved lessons change invalidates reuse from the next injected brief, exactly as a direct store write would.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the commands are a poor fit; they are the current package constraints.

- **No skill-write application** — `/skills approve` drops a staged skill entry; the skill file is written by `skill_manage`, and the command never writes skill files itself.
- **`/learn` depends on the gated writer** — the command only queues a turn; if the composed agent has no `skill_manage` (or no gathering tools), the turn cannot save anything, and the prompt says so instead of pretending a skill landed.
- **`/suggestions` only suggests** — it reads blueprints and schedules nothing; installing the cron entry a blueprint names stays a separate, deliberate act by the human.
- **Blueprint reader tolerates two surfaces** — a skill's blueprint is read from the parsed frontmatter field, or from the frontmatter bag it was parsed from, because discovery publishes one of the two; an unaccepted shape is simply not suggested.
- **Exports need the exporter** — `/trajectory` reports `The evolution trajectory exporter is not mounted.` when the composition omits it, and the export itself owns the file layout.
- **One scope per invocation** — the scoped commands govern the invoking session's scope only; there is no cross-scope view (only `/curator status` and `/suggestions` are host-wide).
- **Command adapters only** — surfaces without `ctx.commands` cannot invoke them; staged writes then wait for a mounted adapter or the `evolutionController` Remote namespace.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Injector membership convergence, undecided** — scope resolution duplicates the injector's membership rule without its cache. Extracting one shared helper (owned by the memory package or the workspace registry) waits until a third consumer needs it; two copies with one noted owner is cheaper than a premature seam.

</details>

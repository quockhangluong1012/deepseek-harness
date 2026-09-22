# Agent Note: Sleep-time driver and the workflow axis

Status: implemented

English | [中文](2026-09-22-sleeptime-driver-and-workflow-axis.zh.md)

## Problem

Two mechanism families shipped their recording half and nothing acted on it.

§25's sleep-time compute landed as a store with an economic plan, and every writer was a test. `/sleeptime` reported an empty plan in the shipped product because nothing anticipated a task outside a unit test, the [sleep-time note](2026-09-22-sleep-time-compute.md) recorded heartbeat-driven anticipation as deferred, and the package README's first Known Limitation said idle time was "planned, not yet automatic". The economics were also unrecorded end to end: `planFor` computed a net and a reason, and `precompute` dropped the reason on the floor, so a cached artifact could not say what justified it.

§26's meta-evolution landed as a five-store family recording one *scalar* configuration per run, and the specification's ladder has five levels. Level 2 — "evolve workflows" — had no representation at all: an `EngineRun` held four opaque component choices and nothing about the order they ran in, so two runs of the same components in different orders were one configuration with a blended pass rate, and `recommend` could only ever name a scalar choice. The README did not say which level each store covers, or that all five read empty because their only writer, `evolution-optimizer`, ships `disabled: true`.

## Decision

**§25 — a heartbeat pass over recorded recurrence.** `evolution-sleeptime` registers one heartbeat task, `sleeptime-anticipation`, through the `ctx.get('evolutionHeartbeat')` seam `evolution-dreaming` already uses, and `anticipateAll(signal?)` runs one pass:

1. **Anticipation is derived, never invented.** The pass reads the occurrences the mounted sources already recorded — `evolutionRouter.outcomes()`, and for each tracked skill the `evolutionTrace.summary()` rows of the sessions `evolutionSkillTelemetry` recorded — and `recurrenceOf` counts each source-and-class inside `recurrenceWindowHours`. Only a class with at least `minRecurrences` sightings is anticipated; `anticipationOf` sets its likelihood to its share of the recurring occurrences, its expected queries to its own recurrence, and its expected saving to the mean tokens one recorded occurrence spent. `classKeyOf` namespaces a class by its source, so a skill and a route that read alike are two candidates. A source that is not mounted contributes nothing, and a pass with no recurrence records nothing.
2. **A precompute needs recorded evidence, not a plan's word.** The pass precomputes only for classes that appear in both the plan and the recorded recurrence, so an operator-anticipated task the plan rates but nothing recorded recurring is skipped rather than filled with invented content.
3. **The decision travels with the artifact.** `PrecomputeArtifact.decisionReason` holds the plan's reason, so a cached artifact names the offline-cost-versus-savings comparison that justified it, and `precompute` accepts the reason from the caller.
4. **Hits come from recorded turns, through a cursor.** `hit(artifactId, occurrences)` accounts every occurrence of the artifact's own class strictly newer than `servedThroughAt`, one hit and that turn's recorded tokens each, and advances the cursor. The cursor is the artifact's own precompute instant while it has never been served, so a turn that ran before the artifact existed is never credited as its consumer, and a repeating pass over unchanged evidence is a no-op. This replaced the operator-supplied `hit(artifactId, savedTokens)` entry point, whose saving was a caller's guess rather than a recorded turn.
5. **The new fields are a domain version.** `evolution_sleeptime` moves to version 2 with `decisionReason` and `servedThroughAt` defaulting to null and `compatibleVersions: [1]`, so a stored v1 artifact opens and is accounted from its own instant.

**§26 level 2 — the workflow axis.** An `EngineRun` now carries `workflow`, a recorded sequence of `WorkflowStep` — each naming the `EngineComponent` it reached for and the choice it used, in the position the run performed it. `workflowIdOf` renders it (`operators=portfolio-v1>evaluator=scorer-v1`) and `configIdOf(config, workflow)` closes the configuration identity with it, so the same components in a different order are two identities, two summaries, and two candidates. `recommend` returns the workflow and its id beside the configuration, and its reason names the sequence the winning runs performed. The store records the sequence as given: an absent one stores empty and the reason says `workflow unrecorded`, because deriving an order from a configuration is exactly the inference level 2 exists to avoid. `evolution_meta` moves to version 2 with `workflow` defaulting to `[]` and `compatibleVersions: [1]`.

**§26 — the level map is stated.** The `evolution-meta` README carries a table naming, per level, what it evolves, the store that covers it, and its state; it says plainly that all five levels are unreachable while `evolution-optimizer` ships disabled, that a disabled writer is not an implemented level, and that nothing at any level changes what the engine runs.

## Alternatives considered

- **Anticipate from scratch rather than from recorded recurrence.** Rejected: the specification asks for precomputation "especially when future queries are predictable", and a host that mounted the router, the skill telemetry, and the trace store already holds that prediction as recorded fact. A pass that invented likelihoods would spend the offline budget on its own guesses, and nothing could audit them.
- **Put the driver in `evolution-actuator`.** Rejected: the actuator reads a recorded verdict and performs the step it licenses, which is why it must run after every store. Sleep-time precomputation writes artifacts for a future that has not happened, which is a producer, not an actuation of something already recorded — and the pass needs the store's own private tables, so it belongs to the store.
- **Derive the workflow from the configuration instead of recording it.** Rejected: the whole point of level 2 is that the order is a variable. A derived sequence would make every run of one configuration share one workflow, so a workflow could never be recommended over another.
- **Make the workflow a separate grouping key beside `configId`.** Rejected: two identities for one candidate invite a caller to group by one and rank by the other. Extending `configIdOf` answers both questions with one key, and the field order is fixed by construction, so the identity never depends on object key order.
- **Require the workflow on `EngineRunInput`.** Rejected: the only writer is the optimizer's recorder seam, which this change does not touch. A required field would either fail every existing record call or force a caller to assert a sequence it did not observe; an optional one records the absence honestly, and the reason string reports it.
- **Precompute every precompute kind for each recurring class.** Rejected for now: the pass caches one `summary` per class, which is the artifact the recorded recurrence alone can fill without composing prose. The other kinds stay `precompute` calls, recorded as a limitation.

## Consequences

- Idle time is automatic: a host with the heartbeat and any one of the three source stores mounted now anticipates and precomputes without an operator, and the heartbeat's own `lastError` reports a failing pass without stopping its sibling tasks.
- An artifact's payback ledger is now evidence-backed. `hits` and `savedTokens` count recorded turns, `servedThroughAt` bounds them, and `decisionReason` says why the artifact was built — so `savingsOf` measures a real return against the offline spend rather than a caller's estimate.
- The meta store's recommendation names a workflow. Two orders of the same four choices rank separately, `/meta recommend` reads back the sequence it recommends, and the reason string carries it.
- Two domains moved to version 2 with `compatibleVersions: [1]`, so a deployed store opens and keeps its rows.
- The level map is now a statement a reader can check: five stores mounted, five commands answering, five levels empty in a shipped profile, one switch — the optimizer row — between them and evidence.
- Both README triples and the sleep-time note were brought along, and the note's deferred-heartbeat claim was rewritten in place rather than left contradicting the code.

## Deviations from the plan

The plan put the §25 economics rule and the §26 workflow axis in one change because both are small additions to stores that already derive everything at read time. The workflow axis needed one thing the plan had not anticipated: `EngineRunInput.workflow` had to stay optional, because the only production writer is the optimizer's recorder seam, which this change does not own. Recording an absent sequence as empty, and saying so in the reason, is the honest version of a level whose writer is disabled.

## Fixes found on the way

- `evolution-meta`'s restart-and-summary test asserted that `summaries()[0]` is the `writer` row of a two-run configuration. `summarize` groups by task class ascending, so `reader` sorts first — the assertion was wrong and passed only while the fixture still had an unrelated defect. It now asserts the documented order (class ascending, then score) and finds the writer row by lookup.
- The same suite's `runs()` ordering test recorded two runs back to back after a fake-timer segment, so both could land in the same millisecond and fall to the run-id tie-break. It now separates them by a real delay.
- `evolution-sleeptime`'s `hit` had to stop taking a caller's token count: `savingsOf` is only meaningful if the saved tokens are the tokens a recorded turn spent, and no caller can know that about a turn it did not observe.

## Testing

`packages/evolution/evolution-sleeptime/tests/anticipate.spec.ts` covers the pure derivation without a context: source-namespaced class keys, the window computation and its exclusion of older occurrences, per-class grouping and ordering, the recurrence minimum with its likelihood share and tie-break, the artifact summary text, and cursor-bounded consumption including the never-served artifact, the unconsumed case, and the same-instant tie-break. `tests/driver.spec.ts` boots the heartbeat (disabled, so no timer), a real router over an in-memory backend, and stubs for the trace projection, then drives the registered task: a recurred class is anticipated with its recorded numbers and precomputed once with the plan's reason on the artifact; a second pass adds neither a second task nor a second artifact; no recurrence records nothing; a later recorded occurrence accounts exactly one hit with its tokens, and two further passes leave it at one; a task the plan rates with no recorded recurrence behind it stays unprecomputed while `plan()` reports it; skill recurrence comes from telemetry and trace rows while an unloaded skill and a trace row with no instant contribute nothing; an aborted pass reads the route source and stops before the skills; the recurrence minimum, window, cadence, and per-pass bound are honored. `packages/evolution/evolution-meta/tests/store.spec.ts` adds the workflow to what it already pinned: the recorded sequence survives a restart, an unreported sequence records empty, and the same four choices in two orders produce two candidates whose recommendation names the sequence. Both packages pass and every file under each `src/` is at 100% statements, branches, functions, and lines.

## Left alone

The optimizer is untouched, so nothing populates the workflow axis in a shipped profile and the level map says so. Neither store applies what it recommends: the meta store still recommends rather than configures, and the sleep-time store precomputes artifacts no turn is required to consult — a model that wanted the cached summary would have to ask for it, which is the §58.12 boundary this change does not move. Accounting matches an artifact's `taskId` against the namespaced class key, so an operator-precomputed artifact whose id is a bare name is not automatically accounted; that asymmetry is recorded as a package limitation rather than papered over with a looser match.

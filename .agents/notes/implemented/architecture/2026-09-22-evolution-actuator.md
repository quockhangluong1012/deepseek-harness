# Agent Note: Evolution actuator

Status: implemented

English | [中文](2026-09-22-evolution-actuator.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` describes loops, and the repository had built only their recording halves. §7 asks for migration between islands "on a generation/budget schedule"; §18's rollout ends in `MONITOR → rollback / learn`; §32 says a stagnant skill "automatically switch[es] strategy"; §43 turns uncertain evaluations into "high-value tasks for additional evaluation". Each of those mechanisms exists as a durable store, and nothing acted on any of them:

- `evolution-canary` holds a five-state ladder and performs only the transition a caller names. Its own README named the gap: the store "records the winner's measured triple, not a hidden-response comparison against a production baseline; that replay-based comparison is the deferred monitoring work (§18's compare step)".
- `evolution-islands` computes a `due` flag on every schedule row, and the only caller of `migrate` was the human `/islands` verb. `MigrationReason`'s `diversity` value had no writer at all.
- `evolution-stagnation` derives `strategy` from the §32 ladder and stringified it for `/stagnation`; no code performed the rung.
- `evolution-uncertainty` derives a prioritized evaluation queue, and `resolve()` had no production caller.
- `evolution-curriculum` stages grounded tasks, and the only path into the benchmark store was the human `/benchmark admit` verb.

The product profile stated the posture outright: each evolution row "is a record rather than a policy: nothing here changes what the engine runs" (`packages/bundle/web-app/cordis.patch.yml`). That was accurate, and it meant the engine could accumulate evidence indefinitely without ever acting on it.

## Decision

Add one package, `packages/evolution/evolution-actuator`, that registers five heartbeat tasks — one per recorded verdict — and one pure decision rule per task.

1. **Actuation is one package, not five.** The five loops share one contract: read a recorded verdict, perform the step it licenses, through the store that already accepts it. A host enables them together, and five packages would have meant five more rows in a profile that already carries thirty evolution rows. The group now has a package that writes (`evolution-optimizer`), one that reads (`evolution-metrics`), and this one that acts.
2. **The trigger is the heartbeat, and the dependency is declared.** `inject = ['evolutionHeartbeat']` makes mount order irrelevant: the plugin applies when the scheduler exists instead of reading `ctx.get('evolutionHeartbeat')` once at apply time. The stores stay optional seams, so an unmounted store makes its one loop a no-op and leaves the other four working.
3. **Every decision rule is a pure module** — `rolloutDecision`, `migrationTarget`, `recoveryStep`, `benchmarkInput` — so a rule change is a unit test rather than a host fixture, and the loop performs only the call the rule names.
4. **Every loop is idempotent by construction**, which is what makes a cadence safe: a decided rollout leaves `canary`, a recorded migration resets its lane's due flag, the curriculum store skips an already-open task, the benchmark store deduplicates by content, and the uncertainty drain drops the signals it acted on.
5. **A rollout is ended, never started.** `shadow → canary` is the medium-risk step §49 routes to an operator, so the monitor only decides a rollout that already runs live: it promotes a patch whose recorded evidence holds against the incumbent, and rolls back one that failed its corpus or costs more on the engine's own elite order.
6. **A rung with no writable target is reported, not invented.** §32's ladder climbs from diversity over new mutation operators, new tasks, and new evaluators to switching the model. Two rungs name something a store accepts — a `diversity` migration into the skill's novelty lane, and a curriculum proposal from its measured gaps. The rest are decisions the optimizer, the evaluator-strategy, and the model-routes packages own, and no store records such a switch, so `recoveryStep` returns `unactionable` for them.
7. **Mount it in the product profile**, last, after every store it reads.

## Alternatives considered

- **Five packages, one per loop.** Rejected: the loops share a contract and a trigger, and a host that wants one wants the rest; the per-loop `Config.loops` field gives the same selectivity without five profile rows, five README pairs, and five catalog entries.
- **Extending each store with its own consumer.** Rejected for three of the five: the stagnation recovery spans the stagnation, islands, population, and curriculum stores, the drain spans uncertainty and benchmark, and the admission spans curriculum and benchmark. Putting them in the stores would make each store depend on its siblings, which is exactly the coupling the optional-seam pattern exists to avoid.
- **Acting from the command plane instead of the heartbeat.** Rejected: `/canary`, `/islands`, and `/benchmark admit` already act on a human's word. The gap is that nobody acts when nobody asks, and a command is by definition someone asking.
- **Promoting a rollout whose triple is unmeasured.** Rejected: `rolloutDecision` returns `hold`. A patch that was never measured has no evidence, and the store's `triple: null` exists precisely to say so.
- **Deciding the rollout on tokens alone.** Rejected: the check follows the engine's elite order — pass, then billed tokens, then wall time when tokens tie — which is the precedence `evolution-stagnation`'s `betterThan` already uses, so a rollout and a stagnation run judge a patch the same way.
- **Synthesizing a benchmark task text from an uncertainty signal.** Rejected: no store holds a generated task for a signal, and inventing prompt text in an actuator would make the benchmark store's contents unaccountable. The admitted task carries the observed note, and the README states that as a limitation.
- **Retiring a curriculum proposal once it is admitted.** Rejected: `/benchmark admit` leaves it open and relies on the benchmark store's content hash, and two paths that disagree about the same proposal's lifecycle would be worse than one that repeats a deduplicated write.
- **A per-loop enable flag beside each cadence.** Rejected as eight fields doing one job: `loops` selects, and every other field stays a cadence or a threshold.

## Consequences

- Five heartbeat tasks appear in `ctx.evolutionHeartbeat.state()`: `evolution-rollout-monitor`, `evolution-island-migration`, `evolution-stagnation-recovery`, `evolution-uncertainty-drain`, `evolution-curriculum-admission`. Each runs only after its interval elapsed and the host stayed idle, so mounting the package changes nothing immediately.
- What the loops did is visible in the stores they wrote — `deployments`, `migrations`, `proposals`, `tasks` — through the commands that already render those stores, and each task's outcome is in the heartbeat's `lastError`.
- A store that rejects an action (a person advanced the same rollout first, for instance) fails that task's attempt, which the heartbeat records and retries on the interval without stopping the other tasks.
- The package opens no domain, so it publishes no invariant companion; every value it acts on belongs to the store that recorded it.
- The catalog gates carry one new package row, one configuration table, and one module-graph node.

## Deviations from the plan

The plan was the ranked remainder of the previous batch's gap audit, which put the record-only loops first. Two ranked items are deliberately not here: the per-task outcome record and the dreaming provenance gate. The first is a recording change in `evolution-benchmark` and the scorer, not an actuation; the second was a gate inside `evolution-dreaming`'s promotion path rather than a loop over recorded verdicts, and it has since shipped with that package ([the provenance, merge, and rollback decision](2026-09-22-dreaming-provenance-merge-and-rollback.md)). The outcome record and the retriever seam remain open.

## Fixes found on the way

None. One suspicion was investigated and dismissed: fifteen evolution rows in the product profile name a plugin whose `Config` schema has only defaulted fields while the row carries no `config:` key, and `ctx.plugin(plugin)` with no argument rejects an undefined config for such a schema. The loader does not pass undefined — booting `@deepseek-ai/dsh-evolution-skill-telemetry` (strict schemastery schema, no `config:` key in the YAML) through the app-boot `boot()` path reaches inject-waiting rather than a config error, so those rows are correct as written and the new row needs no `config:` key either.

## Testing

`packages/evolution/evolution-actuator/tests/actuator.spec.ts` covers each decision rule without a context (the rollout table including the unmeasured hold and both cost-regression branches, the lane rotation with its wrap and its single-lane refusal, the rung mapping including the unactionable strategies (`newOperators` became actionable later — see `2026-09-22-adversarial-probes-and-budget-gates.md`), and the queue-to-benchmark mapping with its empty-input refusal), then boots the heartbeat, seven real stores over an in-memory backend, and the plugin for the behaviour that matters:

- a passing rollout promotes while a failing one rolls back in the same pass, and a later patch that passes but costs more than the promoted incumbent rolls back on the next pass;
- every due lane migrates the skill's elite, and the same instant migrates nothing twice;
- a stagnant skill on the diversity rung moves its elite into the novelty lane, and one on the newTasks rung stages the tasks its stubbed telemetry and trace gaps derive, once across two passes;
- the uncertainty drain admits the queued task with the signal's note and empties the queue;
- the curriculum admission admits an open proposal and admits nothing on a second pass;
- every loop records a successful pass when none of its stores is mounted.

`verify-cordis-config` passes 144 config files, `constraints` passes, and the four generators run clean and are idempotent.

## Left alone

The actuator acts only on recorded state and gates nothing: a promoted rollout does not make a skill visible, an admitted benchmark task does not run, and no loop reaches a model prompt. §58.12's recorded-not-enforced boundary therefore still holds after this change. The unactionable ladder rungs stay unactionable rather than being approximated by a configured evaluator or model switch, because the policy for those belongs to the packages that own the evaluator set and the route table; `newOperators` was later made actionable as a read of `evolution-operators`' recommendation (`2026-09-22-adversarial-probes-and-budget-gates.md`). The loops are host-wide, not scope-keyed, and run sequentially inside the heartbeat's pass; both are documented as current constraints rather than fixed, because a per-scope policy needs a scope key on the underlying domains.

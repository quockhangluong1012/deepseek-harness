# Agent Note: Condition-based evolution nudges

Status: implemented

English | [中文](2026-09-22-condition-based-nudges.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §53 lists "Periodic Nudge → Event/condition-based metacognitive triggers" among the highest-value upgrades to existing mechanisms. The nudge tier of `packages/context/evolution-memory-context` was the unupgraded half: two sections of fixed text, `evolution-memory-scope` and `evolution-lessons-skills`, rendered on turns where `Math.max(turn, 1) % interval === 0` — the scope sentence every `memoryNudgeInterval` turns (default 1, so every turn), the lessons-to-skills sentence every `skillNudgeInterval` (default 10). The turn counter decided when a nudge appeared, and the text depended on nothing the harness knew: it told the model to record durable lessons whether or not anything had failed, and to stay inside the directory scope whether or not anything had been staged.

Meanwhile the sibling packages had filled with exactly the evidence a metacognitive trigger reads. `evolution-memory` holds pending staged writes with their staging instants; `evolution-skill-telemetry` holds each skill's trust standing and its recorded demotions; `evolution-feedback` aggregates failure signals and grades the decisive ones `trigger_review`; `evolution-graph` tracks each active claim's contradicting evidence; `evolution-benchmark` holds every task's rung, including which capabilities never reached `holdout`. The nudge tier read none of it, so the model's reminder to act was as likely to arrive when nothing was wrong as when something was.

## Decision

1. **A nudge is a recorded condition, and the condition names the store that decides it.** `src/conditions.ts` holds the five conditions as data — `staged-writes`, `contradicted-claims`, `skill-trust`, `failure-signals`, `holdout-gaps` — each with the section it renders into, the service it reads, and the subject it names when that service is unmounted, plus one store-backed evaluator per condition in an exhaustive `Record<NudgeConditionId, NudgeEvaluator>`. Every line builder is pure: the caller fetched the evidence, so the wording is a unit test rather than a host fixture.

   | Condition | Store it reads | Evidence that fires it |
   |---|---|---|
   | `staged-writes` | `ctx.evolutionMemory.read(scope).staged` | the oldest pending entry is older than `stagedWriteWaitMinutes` |
   | `contradicted-claims` | `ctx.evolutionGraph.claims(scope)` | an active claim carries contradicting evidence |
   | `skill-trust` | `ctx.evolutionSkillTelemetry.entries()` | a skill stands at provisional trust after a recorded demotion |
   | `failure-signals` | `ctx.evolutionFeedback.signals(scope sessions, scan limit)` | a signal's own grade is `trigger_review` |
   | `holdout-gaps` | `ctx.evolutionBenchmark.tasks()` | a capability is in a learnable state with no `holdout` task |

2. **The interval becomes the cadence ceiling, not the trigger.** Every condition a section carries is evaluated at assembly; one that fired is remembered per session and condition and stays quiet until `interval` further turns have been observed, so the field a host sets today keeps its number and gets the §53 meaning. Two consequences came out of that: the predicate is a cooldown (`nudgeDue(lastFired, turn, interval)`) rather than a modulo, and it treats the turn that fired as still firing, so two assemblies inside one turn render the same prompt instead of the second one dropping the nudge the first one showed.

3. **The line states the condition, not advice.** Each fired line names the count, the instant or state it read, and the operator surface that acts on it (`run /memory pending`, `run /claims`, `run /curator status`, `record the durable lesson with skill_manage`, `run /benchmark`), and a section renders nothing while none of its conditions holds. The two fixed sentences are gone with it: standing advice is what the upgrade replaces, and the README records that a deployment wanting it back owns its own section.

4. **Unevaluable is a third answer, not silence.** A condition whose store is not mounted renders `"<subject> cannot be checked: the <store> store is not mounted."` instead of quietly reporting nothing. Silence means "the store looked and the condition does not hold"; a missing store has not looked, and a reader must be able to tell the two apart. A session in no registered workspace has no scope at all, which is different again: the two scope-bound conditions have nothing to be about there and stay quiet while the three global ones still render.

5. **No new session event, because the section already is one.** The nudge text rides the same `systemPrompt.section` registration it always did — a named section of the logged prompt tier — so a condition-driven line is as recorded as the fixed text was. Nothing here pushes: conditions are evaluated when the prompt is assembled, which is where the existing rendering path already ran.

6. **Every threshold is either the store's own verdict or a config field.** Only two conditions needed a new field: `stagedWriteWaitMinutes` (a real wait — how long is a deployment willing to leave a staged write undecided) and `failureSignalScanLimit` (how many graded signals one evaluation scans). The rest are the stores' own boolean verdicts — a claim either carries contradicting evidence or does not, a signal is either graded `trigger_review` against the feedback store's `triggerReviewSessions` or is not — so the condition reads the store's threshold instead of duplicating it.

## Alternatives considered

- **Keeping the fixed advice beside the condition line.** Rejected: §53's upgrade is that a nudge says something, and carrying the old sentence on every fired line would put the always-on token cost back while adding the condition's own.
- **Subscribing to store events instead of reading at assembly.** Rejected as a bigger mechanism for a smaller result: the stores publish no events for these transitions, so the trigger would have to be a new session event plus a queue, and a nudge is only useful in a prompt the model is about to read anyway. The condition is evaluated at exactly that moment.
- **Deriving the conditions from the session log rather than the stores.** Rejected: the stores hold derived verdicts — a claim's contradiction count under the graph's belief model, a signal's actionability under the feedback store's attribution rules, a skill's trust under the telemetry store's demotion rules. Re-deriving them in a context package would be a second implementation of each store's rules, drifting from the first.
- **A time threshold for every condition, since one already needed one.** Rejected: only a staged write genuinely *waits*. A contradicted claim, a demoted skill and a graded failure signal are the stores' own verdicts, and inventing an age for them would turn an event into a decay.
- **Per-condition interval fields.** Rejected: five more config fields where the section's ceiling already answers the question a host asks — how often may this tier repeat itself.
- **Removing the interval fields.** Rejected: hosts set them today, and the ceiling is the reason a standing condition (an unrepaired holdout gap, a staged write nobody decides) does not repeat on every assembly forever.
- **A logger warning instead of a prompt line for an unmounted store.** Rejected as a silent failure with better manners: the requirement is that a missing store be distinguishable from a satisfied condition, and the prompt is the surface where the difference is visible per session.
- **Making the whole tier condition-driven, session-search hint included.** Rejected: the hint is not about recorded evidence, it is a standing instruction about how to recall, and nothing in the harness records "the user was asked to repeat context".

## Consequences

- The system-prompt tier now follows store state: a memory write alone leaves it byte-identical (lines carry counts, instants and store identities, never memory text), while a condition starting or ceasing to hold changes it from that point on. The README states that as the tier's KV-cache effect and as a limitation.
- A quiet tier is now information. A deployment that mounts `evolution-memory` alone sees four notices naming the stores it does not mount, once per interval, in place of the four conditions it cannot evaluate — the honest reading, and the one an operator can act on.
- Four new peer and dev dependencies (`evolution-feedback`, `evolution-graph`, `evolution-benchmark`, `evolution-skill-telemetry`) and two new `Config` fields (`stagedWriteWaitMinutes`, `failureSignalScanLimit`), so the generated configuration catalog and the package's tsconfig references must follow (the catalog regeneration and the four project references are the main agent's edit).
- `isNudgeTurn` and `lessonsSkillsText` are gone; `nudgeDue` replaces the first and the second has no replacement, because the skill section's text is now evidence rather than a constant.

## Deviations from the plan

§53 asks for event/condition-based triggers. Only the condition half is here: triggers are still evaluated when the prompt is assembled rather than pushed by an event. A push would need a new session event and a queue in front of the prompt tier, and it would deliver a nudge between steps that the model reads anyway on the next assembly; the recorded condition is the part that changes what the model is told.

## Fixes found on the way

None. One suspicion was checked and dismissed: the fixed text's `Math.max(turn, 1)` treated a session with no observed turn as its first turn, which is what let the default `memoryNudgeInterval` render before the first `turn/start`. The cooldown predicate keeps that behaviour for free — a condition that has never fired is due, and an unobserved session is at turn 0 — so no special case was needed to preserve it.

## Testing

`packages/context/evolution-memory-context/tests/conditions.spec.ts` pins the condition vocabulary and every line builder without a context: the staged-write window (empty, inside the window, waited), the contradiction count, the `trigger_review` grade, the provisional-after-demotion trust standing, and the holdout gap against a covered capability and a terminal-only one. It then drives each entry of `NUDGE_EVALUATORS` with synthetic dependencies to pin the three answers per condition — quiet, fired, and the unmounted-store notice naming its service — plus the scope-bound conditions staying quiet with no scope and the failure scan passing the scope's session ids and the configured limit through.

`packages/context/evolution-memory-context/tests/sections.spec.ts` boots the prompt tier with the real stores over an in-memory backend and covers the behaviour a host sees: five recorded conditions each rendering their own line, silence while none holds, the unmounted notices beside a mounted condition still rendering, a standing condition quiet for `memoryNudgeInterval` turns and firing again after them (with the same-turn reassembly agreeing and two sessions running independent cadences), the skill section dropping while `skill_manage` is invisible, a session outside every workspace losing only its scope-bound lines, assembly without a session, and the prompt staying byte-identical across a memory write. The loader suite in `tests/inject.spec.ts` gained the two new fields' rejections.

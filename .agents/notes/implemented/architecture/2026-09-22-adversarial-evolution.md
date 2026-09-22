# Agent Note: Adversarial evolution

Status: implemented

English | [中文](2026-09-22-adversarial-evolution.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §45 defines adversarial evolution — Generator → Candidate → Adversary → Find weaknesses → Repair → Verify — with probes targeting eight weakness families (edge cases, prompt injection, stale memory, retrieval traps, contradictory evidence, tool failures, ambiguous instructions, evaluator gaming), and §46 adds the evaluator-gaming defense checklist, because a skill that only ever sees friendly evaluations learns to please the evaluator instead of surviving real use. The harness had no durable record of which weakness families a skill had been probed against, no notion of "next category to probe", no repair tracking for exposed weaknesses, and no checklist showing which gaming defenses still stand open.

## Decision

One new package, `dsh-evolution-adversary`, holding a durable per-skill probe log with a derived challenge plus the defense checklist:

1. **Every probe is a durable fact, recorded unrepaired.** `probe(input)` stores `{ probeId, skill, category, probe, foundWeakness, repaired: false, at }`; repair is a separate explicit `setRepaired` step, so a recorded weakness is never silently marked fixed, and an unknown probe id throws loudly. Nothing here calls a model (§58.12): probing, repair, and defense satisfaction are operator judgments recorded as facts.
2. **Coverage is pure and zero-filled.** `categoryCoverage` counts one skill's probes per category with unprobed categories reading 0; `uncoveredCategories` names the categories below the configured `minProbesPerCategory` in canonical order; `nextChallenge` takes the first uncovered category, or — when all are covered — the least-probed category with canonical tie order, so probing rotates instead of stopping. `weaknessRate` shares found weaknesses over the skill total, null without probes.
3. **The checklist tracks the six automatable §46 defenses.** `defenses()` renders all six in canonical order with unset defenses reading unsatisfied at a null instant, so the checklist is safe to render from an empty store; `defenseGaps` names the open defenses. Human spot checks stay operator-side by design.
4. **One durable domain, record-only store.** The `evolution_adversary` domain (v1) holds a `probes` table keyed by probe identity and a `defenses` table keyed by defense. The challenge derives from history at read time, so minimum changes re-rank the next category without rewriting probes; stored defense rows always carry an instant (`DefenseRow`), while the read model synthesizes open rows (`DefenseStatus` with a null instant).

## Alternatives considered

- Derive challenges from the scorer's `evaluatorDisagreement` directly — rejected: the scorer measures dissent per candidate, while the adversary store records which weakness families were actually probed and repaired; disagreement is the dissent source worth probing, linked from the README, not the probe log itself.
- Reuse the islands' adversarial lane — rejected: an island objective names an evolution lane, not a concrete prompt; the probe log records the prompt, the weakness verdict, and the repair state per skill.
- Enforce defenses automatically — rejected: §58.12 keeps trust recorded-not-enforced; the checklist names the open defenses, and satisfying them remains an operator's job.

## Consequences

- Adversarial coverage is now visible and actionable: `challenge('writer')` names the exact next weakness family, so no family goes untested and a fully probed skill rotates instead of stopping.
- Repair has a paper trail: every exposed weakness stays unrepaired on record until an explicit `setRepaired`, and the weakness rate marks which skills need repair before further optimization.
- The gaming checklist is durable: unset defenses read open, setting one never disturbs another, and operator-side spot checks stay out of the store by design.

## Deviations from the plan

None beyond routine. The stored defense row and the read model split into two types — `DefenseRow` (instant always present) versus `DefenseStatus` (null instant for never-set defenses) — because the durability boundary validates what is stored while the checklist must render from an empty store.

## Fixes found on the way

`z.enum` needs a tuple-shaped constant, so both canonical lists use the canary precedent (`as const satisfies readonly T[]`): spec order pinned once and shared between the pure helpers and the zod rows. The newest-first probe listing sorts ties by probe id ascending, so same-millisecond batches resolve deterministically; the order test asserts the gapped pair by index and the rapid tail as a set, never exact order of same-millisecond rows.

## Testing

Adversary helpers: canonical order pinning, zero-filled coverage with cross-skill isolation, uncovered sets at minimum one and two, uncovered challenge wording, full-coverage rotation to the least-probed with canonical tie order, weakness-rate null and fractions, defense gaps in canonical order with missing rows counting as open. Store: probe defaults, repair round-trip with explicit unrepair plus unknown-probe throw, newest-first listing with filter and detached copies, challenge end to end under the default and a configured minimum, checklist defaults through set rows, restart persistence through the zod spec, reads-before-start. 15 adversary tests and 8 store tests pass; the new package is at 100% statements/branches/functions/lines.

## Left alone

The store records probes, it does not run them: executing probes against a skill and judging weakness remains an operator's job per §58.12 (documented in the package's Known Limitations). One `minProbesPerCategory` applies to every weakness family; per-category minimums are deferred. Human spot checks stay operator-side; the checklist tracks only the six automatable defenses.

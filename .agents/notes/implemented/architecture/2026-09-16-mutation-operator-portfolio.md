# Agent Note: Mutation operator portfolio

Status: implemented

English | [中文](2026-09-16-mutation-operator-portfolio.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §8 (P1 item 13) warns against letting one LLM prompt be the only mutation mechanism, and the survey of §51 confirmed the optimizer had exactly one: `mutationInstructions` opened every request with "You improve one skill package in a single rewrite pass", so `maxCandidates` bought several samples of one rewrite style. A skill whose failure is a missing precondition, or evidence the body states too verbosely, was handed the same instruction as one whose failure is unclear ordering.

## Decision

A named portfolio of built-in operators in `dsh-evolution-optimizer`, each contributing one instruction line to the request header it frames:

- `rewrite` — clarity and ordering, changing only what the evidence implicates (the historical instruction, and the default).
- `compress` — the shortest body that still states every rule the evidence shows matters.
- `guard` — the precondition, refusal, or validation the evidence implicates, and nothing else.
- `exemplify` — one worked example per implicated rule, dropping nothing that works.
- `generalize` — widen each implicated rule to its failure class, not just the failing instance.
- `decompose` — split the implicated procedure into separately checkable steps, keeping every rule.
- `compose` — merge duplicated or overlapping implicated rules into one.
- `reorder` — move the implicated check earlier, changing no rule text.
- `remove-step` — delete the step the evidence shows never fires, keeping the rest byte-identical.
- `change-tool` — replace the implicated tool call with the tool that answers the question.
- `change-retrieval` — change only what the body retrieves: queries, sources, or lookup order.
- `change-evaluator` — change only how the body checks its own result: thresholds, assertions, or verification steps.

Two specification members stay out deliberately: `merge-two-candidates` needs two input bodies while the frame carries one, and `adversarial-patch` belongs to the contamination review rather than repair mutation. The selection guide lives on `MUTATION_OPERATORS` in `mutate.ts` because the optimizer README is another change's work in progress.

`operators` (Config, default `['rewrite']`) selects ids in request order; `resolveOperators` rejects an unknown id while the plugin resolves its configuration, so a typo fails at load rather than after a mutation call. `distributeCandidates` splits `maxCandidates` evenly across the selection, leading operators taking the remainder, and each entry becomes one `mutateOnce` call. `EvaluatedVariant` carries the producing `operator`, the staged payload records the winner's operator, and the staged gist names it. Bodies two operators happen to return identically collapse into one candidate credited to the earlier operator.

## Alternatives considered

**Default to the full portfolio.** Rejected: the candidate budget is the deployment's, and twelve operators with the default `maxCandidates: 3` would turn one mutation call into three without the operator asking. Defaulting to `['rewrite']` keeps today's cost and makes breadth an explicit choice, the same shape as `screenScenarioCount: 0` and `budgetTokens: 0`.

**`maxCandidates` per operator.** Rejected: it silently multiplies both the call count and the evaluation cost by the portfolio size, and it makes the meaning of `maxCandidates` depend on another field.

**Framework-style operator registry** (third-party operators registered through a Cordis service). Rejected as speculative: the twelve built-ins cover the shapes the evidence in this repository actually shows, and a registry owned by one package with one caller is machinery without a consumer. A deployment that needs another operator changes the built-in list in the same place its instruction is defined.

**Operator attribution with per-operator outcome tracking** (which operator wins how often, kept durably to reweight the portfolio). Deferred at the time to its own decision; that decision has since landed as [structured reflection and operator effectiveness](2026-09-20-evolution-p0-operators-and-reflection.md): `operatorEffectiveness` summarizes attempts, acceptances, mean token delta, and regression rate per failure signature from the ledger rows this change already records, without changing the lineup ordering.

## Consequences

A run can now attack one skill from several angles, and the staged evidence says which angle produced the winner. The cost is explicit and documented: every selected operator is its own model call, so a four-operator portfolio at `maxCandidates: 4` is four calls rather than one, and a portfolio wider than `maxCandidates` leaves trailing operators unused (`distributeCandidates` drops them).

Verification: 49 optimizer tests (portfolio resolution, unknown-id rejection at load, budget distribution with remainder, per-operator candidate tagging, cross-operator duplicate collapse, plus the existing scoring and governance paths) and 100% statements, branches, functions, and lines on `packages/evolution/evolution-optimizer/src`. The portfolio has since grown to twelve operators: `mutate.spec.ts` (11 tests) resolves every id with distinct instructions, and `effectiveness.spec.ts` (3 tests) covers the per-signature effectiveness summaries.

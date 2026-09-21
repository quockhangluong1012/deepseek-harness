# Agent Note: Candidate admission gate and frontmatter-free novelty

Status: implemented

English | [中文](2026-09-21-candidate-admission-gate.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §12 makes the deterministic verifier the first judge — "do not use an LLM judge when a deterministic verifier exists" — and §53 pairs a skill promotion with the gates before it. The curator had one (`isValidSkillBody` refuses a verdict body that would break the skill) and the scorer had one (`checkBehaviorContract`), but the optimizer had none: it drew candidate bodies from the mutation operators and scored every one of them over fresh replay processes, including bodies whose frontmatter the model had dropped or renamed. Such a body cannot be landed — `skill_manage edit` refuses it — so a run could spend a full overlay evaluation, a holdout check, and repeated confirmation pairs on a winner nobody could write, and report it as a promotion.

Reading the novelty measure while wiring that gate exposed a second, smaller defect. `novelty.ts` documents itself as measuring the candidate's own instruction lines, but `instructionLines` split on every newline, so frontmatter counted as instruction lines. Both bodies in a real comparison restate the same frontmatter, so it only ever inflated the denominator: a candidate that added one rule to a five-line body reported 1/6 where the module promises 1/5, and that number decides the tie-break between candidates that measured the same.

## Decision

Two corrections in `dsh-evolution-optimizer`, both about what counts as a candidate body.

1. **Admission before evaluation** (`src/index.ts`). Every body a mutation call returns goes through `checkBehaviorContract(request.skill, candidate)` before it enters the candidate pool. A refusal is not a candidate: it never reaches `scoreVariant`, so it never buys a scoring run over fresh processes, and it is not recorded in the experiment ledger's operator tallies — the ledger already remembers only operators that produced a *usable* candidate. The count of refusals is carried to the `no-improvement` reason when every body was refused, so the operator reads "3 refused for breaking the skill frontmatter" instead of a bare "no usable bodies".
2. **The request states the requirement** (`src/mutate.ts`). `mutationInstructions` gains one line requiring frontmatter that names the same skill and carries a routing description. The gate is not a trap for a compliant model: it is the deterministic check behind an instruction the model can follow.
3. **Novelty measures instruction lines** (`src/novelty.ts`). `instructionLines` drops the leading frontmatter block before splitting, so the share is computed over lines the candidate actually authored. A body that never opens with `---` is unchanged (the `closing` lookup returns `-1`, and `slice(0)` keeps every line), and a mid-body `---` rule stays content.

## Alternatives considered

- **Reuse the curator's private `isValidSkillBody`** — rejected: it is a copy of the same invariant, and the scorer already publishes the check as `checkBehaviorContract`. The optimizer imports that one, so the write path, the behavior gate, and this loop share a single implementation of "a body that can be committed".
- **Gate the winner instead of every candidate** — rejected: it refuses after the run paid for the screen, the full evaluations, the holdout, and the confirmation pairs. The cheapest gate belongs first, which is the same ordering `evaluateBehavior` already applies to its three channels.
- **Add a `status` for a fully refused run** — rejected: `no-improvement` already means "nothing this run produced was worth staging", and a new status would ripple into the ledger schema, `describeOutcome`, `/curator optimize`, and every surface that switches on it. The refusal count rides the existing `reason` instead.
- **Filter inside `parseMutationResponse`** — rejected: the parser's contract is shape (complete, distinct, non-empty, different from the baseline), not skill validity, and it takes no skill name; adding one would make a pure text parser depend on the frontmatter invariant of another package.
- **Leave novelty counting frontmatter** — rejected: the module's own JSDoc already promised instruction lines, and the gate guarantees every production candidate carries frontmatter, so the denominator would be inflated on every run rather than by accident.
- **Skip only the `---` fence lines rather than the block** — rejected: the fences are not the problem, the metadata between them is; and a body with a later `---` horizontal rule would then lose the content up to the next one.

## Consequences

- A candidate that could not be landed no longer reaches the human as a promotion recommendation, and no longer buys a scoring run.
- Refusal is deterministic and free: one frontmatter parse, no model call, no process boot.
- A run whose every candidate was refused is diagnosable from its reason alone, including how many were refused.
- Novelty is now the share its documentation describes, so the tie-break between equal candidates ranks authored material rather than restated metadata. The change is in the reported number: a candidate of a body with frontmatter scores higher than before for the same edit.
- The gate checks frontmatter only. A well-formed body that hijacks another skill's triggers still reaches the human; that check is the scorer's routing gate, which the optimizer does not run. Recorded in the package README's limitations rather than implied.

## Deviations from the plan

- None: the slice is the §12 verifier-first gate for the optimizer's own candidates, plus the novelty correction the gate exposed.
- The `packages/evolution/evolution-optimizer/tests/optimizer.spec.ts` fixtures carried bare `'# writer'` strings as bodies. They were not skill-shaped because nothing had ever checked them; every fixture body is now built through a local `skillBody` helper, which is the honest cost of adding a real gate.

## Testing

- `tests/optimizer.spec.ts`: a broken body beside a valid one is refused before scoring (the score call count proves no evaluation was bought) while the valid candidate still stages; a run whose every body was refused reports `no-improvement` with the refusal count and scores nothing.
- `tests/novelty.spec.ts`: reworded frontmatter with an identical body reports 0, an added rule reports the authored share, a body with no leading `---` keeps every line, an inner `---` rule stays content, and an unterminated frontmatter block keeps every line.
- Optimizer suite green (116 tests); `command-evolution`, `evolution-scorer`, `evolution-curator`, and `evolution-feedback` suites green (275 tests).

## Left alone

- Running the scorer's full `evaluateBehavior` (routing plus replay) inside the optimizer: it needs a routing catalog and trigger queries the `OptimizeRequest` does not carry, and adding them changes the caller contract for every `/curator optimize` invocation.
- Wiring `checkBehaviorContract` into `/skills approve`, where a staged body still reaches the human unverified: `skill_manage edit` refuses a broken body at write time, so the file is safe; the gate's value here was the wasted evaluation, which is now avoided.
- Contract-editing flows, benchmark generation, and the P2/P3 mechanism families remain future slices.

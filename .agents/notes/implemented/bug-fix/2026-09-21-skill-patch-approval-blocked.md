# Agent Note: A staged skill patch could never be approved

Status: implemented

English | [中文](2026-09-21-skill-patch-approval-blocked.zh.md)

## Problem

`/curator optimize` ends by staging a skill patch and telling the operator to land it: `Optimized 'writer': staged skill patch <id>. Write the skill with skill_manage, then '/skills approve <id>' to drop the entry.` That second step could never succeed. `EvolutionMemoryStore.approveStaged` gated **every** skill-kind entry on a capture contract, and the optimizer's payload — `{ skill, body, operator, baseline, winner }` — carries none. So the promotion a run reports as staged came back as `Cannot approve '<id>' (evolution/staged-blocked): staged evolution write '<id>' is blocked: contract must be an object. The entry stays staged.` for every id, forever, on every deployment.

The gate was right for what it was written for. §58.1 row 12 admitted it because skill *creation* was admitted on procedure-only evidence, and the contract demands independent validation evidence — its module doc calls it "the admission gate for skill proposals". A `patch` is not a proposal of a capability: it revises one the catalog already admitted, and the evidence that justifies it is the baseline-versus-candidate measurement the optimizer recorded, which this store has no way to read. Gating by `kind` alone conflated the two, and because no producer stages a patch with a contract, the conflation made the optimizer's whole promotion lane unreachable — the same class of defect as the candidate gap fixed in [the admission-gate note](../architecture/2026-09-21-candidate-admission-gate.md): a promotion was reported for something that could not be landed.

## Decision

Gate the capture contract on the operation, not on the kind: `approveStaged` demands a valid contract for a skill-kind entry whose `op` is `create`, and drops a skill-kind entry of any other op on the human's approval. `skillContractIssues` and its JSDoc follow ("Name the admission evidence a creation proposal is missing"), as does the `approveStaged` contract.

The reviewer's creation proposals are unchanged: they still stay staged with `blockedReason: 'capture-contract'` and their `neededEvidence` until a contract is supplied, which is the defect §58.1 row 12 exists to prevent.

## Alternatives considered

- **Have the optimizer stage a capture contract of its own** — rejected: the contract requires `validationRefs` disjoint from `procedureRefs`. The optimizer can name its search scenarios as procedure, but its only disjoint validation evidence is the holdout, which defaults to `[]`. Under the default configuration that closes the lane again, for a reason the operator cannot see; with a holdout it would make approval depend on a configuration the shipped example does not set.
- **Let the validator accept either a contract or a recorded measurement** — rejected: the validator reads a payload, not a ledger, so it would have to take the proposer's own numbers on trust. A gate that accepts an unverified claim is not a gate.
- **Drop the capture-contract gate entirely** — rejected: creation proposals would return to procedure-only admission, which is exactly what §58.1 row 12 and its `CaptureContract` were added to stop.
- **Give patches their own admission evidence instead of exempting them** — not now: the optimizer's own gates already refuse a winner by an approved floor, by the holdout, and by a lost confirmation pair, and the body it stages is checked against the commit invariant before it is ever scored. A second admission rule for patches needs evidence the store does not own.

## Consequences

- `/curator optimize` → `/skills approve <id>` works as its own output describes.
- A revision is admitted by the human decision plus the gates its proposer already enforced; a new capability claim still needs independent validation evidence.
- `/skills pending` and the blocked-entry path are untouched, so a creation proposal that fails admission still reports exactly which evidence is missing.
- The command README and the error table now say *creation* proposal, because a patch is no longer gated.

## Deviations from the plan

- None: the change is the gate's scope, its two JSDoc contracts, the package and command READMEs, and the generated subsystem page.

## Testing

- `packages/evolution/command-evolution/tests/command-evolution.spec.ts`: a staged `patch` with an optimizer-shaped payload approves and drops the entry. Before the change this failed with the exact `evolution/staged-blocked` text quoted above; the existing creation-proposal tests continue to assert the block and its missing evidence.
- `packages/evolution/evolution-memory/tests/store.spec.ts`: the store-level pair — a `patch` approves without a contract, a `create` does not.
- `evolution-memory` and `command-evolution` suites green (291 tests).

## Left alone

- **No command supplies a contract yet.** `supplyStagedContract` is store-level, so a creation proposal that fails admission still cannot be approved from a chat command. That is a missing producer, not a wrong gate: the reviewer cannot fabricate independent validation evidence, and inventing one would be the defect the gate prevents.
- The optimizer's staged patch carries no capture contract, so the scope record's staged payload is not self-describing about why the patch was admitted. Its `gist` names the operator and the winner's triple, and the ledger row holds the measurement.

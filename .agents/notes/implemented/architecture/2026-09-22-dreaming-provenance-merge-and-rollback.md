# Agent Note: Dreaming gates provenance, merges restatements, and reverses a promotion from its preimage

Status: implemented

English | [中文](2026-09-22-dreaming-provenance-merge-and-rollback.zh.md)

## Problem

§53's Dreaming row asks for a provenance gate, merge/supersede, and preimage rollback, and §19 frames what they mean: promotions use score, recall-frequency, and query-diversity gates; untrusted or system-derived candidates are kept out of the durable promotion path; accepted rewrites retain preimages and reviewable dream reports.

The package had the first half of that and none of the rest. `dsh-evolution-dreaming` ([the dreaming decision](2026-09-13-dreaming-and-reranker-decision.md)) scores every staged candidate with the six-signal composite and promotes those clearing three numeric gates, and its README stated the other two gaps outright: promotions were "a dead end until read", and nothing injected a promoted dream into model context. Beside that:

- Light stages candidates from two sources with different epistemic standing — recorded failing tool results from the feedback seam, and episodic notes from the memory store's daily log — and Deep treated them alike, so a model-extracted note promoted exactly as a failure the harness watched fail.
- A promotion's identity is its normalized statement, so a cycle that re-reported the same failure saturated its gates again, and a paraphrase of a promoted statement became a second durable entry. Nothing retired a statement a later one corrected, and the record had no marker for either case.
- Every deep pass rewrote the promotions array wholesale, and only the newest state survived: a decay sweep or a bad promotion had no way back.

## Decision

**Provenance is the first gate, and the sources it trusts are named.** A candidate's sightings now carry provenance: `attributed` for the feedback seam's aggregate of failing `tool/result` events, which records the tool and the session beside the message, and `unattributed` for an episodic note, which the memory store records as text with a day and nothing that identifies its author. `decidePromotion` refuses an unattributed candidate by name (`unattributed-provenance`) before it compares any threshold, so an unattributable candidate cannot reach the durable path by scoring well. One observed sighting vouches for the candidate it folds into, so a note restating a recorded failure still adds to that failure's evidence — `mergeProvenance` treats `attributed` as absorbing — while a candidate resting only on notes can never promote.

**One relation rule decides both merge and supersede.** `relateNarrative` compares a gated candidate against the narratives the scope still answers with, and only those naming the same tool: two failures of different tools are two subjects however alike their wording. Concept overlap — the same lexical measure the relevance signal reads — classifies the relation as `identical` (an identity the record already answers to, including a wording it absorbed), `restates` at or above `mergeOverlap`, or `corrects` between `supersedeOverlap` and `mergeOverlap`. A restatement folds into the narrative it restates, listing the absorbed wordings, so the record collects no near-duplicates and the canonical statement, promotion instant, and evidence stay put. A correction installs a new narrative and marks the predecessor with the identity of what replaced it and when; the predecessor keeps its place and its evidence and answers nothing, which is the rule `evolution-graph` already applies to a retired claim. Candidates are related against what the same pass has already written, so two restatements arriving together produce one narrative. Every candidate that would promote still passes the gate first, so a correction that fails a threshold retires nothing.

**The ledger and its rollback follow the curator's shape.** Every pass that changes the promotions appends one entry holding the promotions array it replaced (`before`), the array it installed (`after`), the actor, the action, and what the pass did — added, folded, retired, dropped. Unlike `evolution-curator`, which content-addresses blobs on disk, the entry holds its preimage inline: dreaming's durable state *is* a storage-domain record, so the record is its own blob store, a preimage cannot go missing between the write and the read, and no second storage mechanism is added for one package's state. `rollback(scope, entryId)` fails closed on an unknown identity before writing, restores the preimage exactly, reports the narratives it put back into answering, and appends its own entry — which makes the rollback as reversible as the pass it undid. The ledger is bounded by `maxLedgerEntries`, newest kept, so a long-lived scope keeps a rollback window rather than every pass it ever ran.

**The read half stays deferred, and the README says why.** The one consumer that puts scope memory in front of a model is `dsh-evolution-memory-context`, which renders a brief from the memory store's curated families under its own byte budget and digest contract; a dream is not one of those families, so injecting it changes another package's prompt surface and needs a logged session event for the text it adds. What the change provides instead is the seam a consumer would call — `promotions(scope)` answers with the narratives no correction has retired — and a truthful statement of what is missing.

**Everything new is a validated configuration field.** `mergeOverlap`, `supersedeOverlap`, `maxRestatements`, and `maxLedgerEntries` join the existing thresholds, and `resolveConfig` rejects a `supersedeOverlap` above `mergeOverlap`, which would make every related candidate a restatement and leave a correction unable to retire anything.

## Alternatives considered

**Trusting an episodic note because a human approved it into the log.** Rejected: the episodic tier records a day, a text, and an instant. The reviewer's extraction writes those notes, the user can write them, and the store cannot tell the two apart, so an "approved" note is still text nobody can vouch for. The trust boundary had to fall where the provenance is recorded, which is the feedback seam's observed tool result.

**Refusing to promote anything a note touched, rather than only note-only candidates.** Rejected: a note that restates a recorded failure is exactly the independent-context evidence the recall and diversity gates are trying to measure, and discarding it would have removed the note path's only remaining purpose. Provenance is therefore a property of the candidate, absorbing upward from its sightings.

**Deciding restatement versus correction from a declared relation, as `evolution-graph` does with `supersedes`.** Rejected: the graph's relations arrive in a model-extracted batch, and this path calls no model by construction. The lexical rule costs a documented ceiling — a paraphrase with no shared vocabulary is a new narrative — and buys a decision that is testable without a provider.

**Two rules, one for folding and one for retiring.** Rejected: both questions have the same input and the same answer shape, and two thresholds over one overlap meant two chances to disagree about the same pair of statements. `relateNarrative` returns one relation with the overlap that decided it, and `evolveNarratives` performs the write the relation names.

**Content-addressed preimage blobs on the filesystem, exactly as the curator stores them.** Rejected: the curator's state is a skill tree plus a JSONL ledger, so it needed a blob directory; dreaming's state is a single domain record, and a filesystem store beside it would be a second durability mechanism, a second cleanup path, and a second thing to keep consistent with the record that replaces it. The preimage array travels with the entry that invalidated it.

**Recording gate refusals durably on the narrative.** Rejected: REM writes the narrative before the deep phase runs, so a durable refusal list would need the deep phase to rewrite the previous phase's record. The refusals are returned by the phase report and summarized in the ledger entry's counts, which is where an operator looks after a pass.

**Wiring the read half by rendering dreams into the memory brief.** Rejected for now: the brief's budget and digest belong to `dsh-evolution-memory-context`, the injected text would be a new model-visible surface needing its own session event, and the material is largely what the transcript already shows — the promoted statements restate failures the model has already seen. The seam exists; the injection is a decision for the package that owns the brief.

## Consequences

- **A note-only candidate can no longer promote**, which is the one visible behavior change to the shipped mechanism: the package README previously said a note repeated across days could promote, and that sentence is now the gate's refusal. Notes still stage, still add context to the six signals, and still reinforce a failure the feedback seam also reported.
- Promotion writes are reversible per pass: `read(scope).promotions` after `rollback(scope, entryId)` is the exact array the pass replaced, including any narrative the pass folded into, retired, or dropped, and the rollback is itself a ledger entry.
- The durable record grows by one ledger entry per changing pass (bounded by `maxLedgerEntries`) and by four fields on each promotion: the gate's evidence, the restatements it absorbed, and the supersession marker. Every one of them carries a zod default, so records written before them open unchanged and the `evolution_dreams` domain stays at version 1.
- A correction is a new row rather than an edit: the retired narrative keeps its identity, statement, score, signals, and evidence, and only the supersession fields say it has been replaced. A reader that wants the live set asks for it (`promotions(scope)`); a reader that wants the whole story reads the record.
- The cycle still makes no model call, adds no prompt section, and publishes no new durable surface a model can see, so §58's recorded-not-enforced boundary is unchanged.

## Testing

`packages/evolution/evolution-dreaming/tests/narrative.spec.ts` covers the pure rules without a context: identity normalization, provenance absorption, each gate's refusal and the admission, all three relation kinds plus the retired, different-tool, and unrelated refusals, the strongest-overlap pick, and the fold, cap, identity, and supersession writes. `tests/dreaming.spec.ts` drives the service over an in-memory storage backend for the behavior that needs one:

- a note-only candidate is refused as `unattributed-provenance` and writes nothing, and the same text arriving as a recorded tool result promotes with the note sightings absorbed into its evidence;
- a restatement folds into the narrative it restates in the same pass that promoted it, leaving one entry with the absorbed wording listed;
- a corrected statement promotes while its predecessor stops answering, keeps its place and evidence in the record, and names what replaced it;
- `rollback(scope, entryId)` restores the exact preimage array, reports the narratives it put back into answering, and ledgers a reversal whose own rollback restores what the rollback replaced;
- an unknown ledger identity fails before anything is written, and the ledger keeps only the newest `maxLedgerEntries` passes;
- the phase report names each refusing gate with its count.

The package keeps its per-file 100% coverage across `src/`.

## Related

- [The dreaming decision](2026-09-13-dreaming-and-reranker-decision.md) — the cycle this change gates, deduplicates, and reverses.
- [Evolution actuator](2026-09-22-evolution-actuator.md) — the gap audit that listed the provenance gate as the open half of §53's Dreaming row.

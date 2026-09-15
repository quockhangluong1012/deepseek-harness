# Agent Note: Evidence-graded skill trust, revision lineage, and body rollback

Status: implemented

English | [中文](2026-09-16-evidence-graded-skill-trust.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §58 is decision-complete and was unimplemented: failure observations were displayed but decided nothing, skill lifecycle moved on elapsed time alone, `skill_manage` wrote `SKILL.md` blind (no revision, no hash, no preimage), `applyConsolidation` committed whatever body the fork returned, and rollback restored lifecycle state and relocated packages but never a patched body.

## Decision

One governed loop, seven steps, all in the same change because step 4 consumes step 1's shape:

1. **Graded signals** (`dsh-evolution-feedback`). `signals(sessionIds, limit)` grades the same aggregation `summary` already produced: `evidenceStatus` is `complete` only when the failing call itself was observed, and `actionability` is `trigger_review` when a complete signal reaches `triggerReviewSessions` distinct sessions, `ranking_only` below that, `observe_only` without attribution. `summary` keeps its exact ordering.
2. **Trust and lineage** (`dsh-evolution-skill-telemetry`). New records are `trusted` (no evidence against them); the model writing a body (`markAgentCreated`) or any edit (`markPatched`, `markRevised`) drops the skill to `provisional`, clears the counted sessions, and anchors it at the newest session seen then, so pre-fix evidence cannot self-promote. `recordTrustObservation` demotes on an attributed failure and counts sessions newer than the anchor; `markRevised` hashes the exact bytes written, so one place defines `contentSha` and the revision chain is linear per skill.
3. **Authorship** (`dsh-evolution-skill-manage`). `create`/`patch`/`edit` now carry model authorship and record a revision of the body they wrote; supporting-file writes keep resetting trust without advancing the revision.
4. **Evidence enters decisions** (`dsh-evolution-curator`). Each pass records one trust observation per skill through `recordTrustObservation`, skipping that step under `dryRun` and logging (never failing the pass) when the store errors. `SurveyFailure` is deleted: the survey carries graded `FeedbackSignal`s plus the skill's trust, revision, `contentSha`, and last attributed failure, and the consolidation prompt states that only a provisional skill or a `trigger_review` signal justifies patch or archive.
5. **Admission gate plus preimage** (`dsh-evolution-curator`). A `patch` verdict is refused unless the body keeps valid frontmatter naming that skill (the same invariant `skill_manage edit` enforces, one implementation), the replaced text is stored as a `blobs/<sha>.md` body blob, and the ledger row carries real `before`/`after` hashes. `rollbackPass` restores those bodies after verifying every preimage up front; a row written before bodies were snapshotted has no preimage and is skipped.
6. **Mount** — `evolution-feedback` was already mounted in `packages/bundle/web-app/cordis.patch.yml` before the curator; only its comment needed to name the second reader.
7. Docs, catalogs, and this note.

## Alternatives considered

- Leave the consolidation prompt on `summary`'s flat counted failures and let the model judge them — rejected: a count is not a decision, so `signals()` grades the same aggregation (`complete` only when the failing call itself was observed) and the prompt is told that only a provisional skill or a `trigger_review` signal justifies patch or archive.
- Build `signals()` on `summary(sessionIds, limit)` with the caller's limit applied first, as the plan said — rejected: a merely counted failure could truncate away the decisive one the caller asked for, so the whole aggregation is graded and sorted before slicing.
- Gate what the model may load on trust — rejected: a product behavior change beyond what was asked (§58.12); trust is recorded and surfaced only.
- Keep a second frontmatter check inside the admission gate, or trust the verdict's body as `applyConsolidation` did — rejected: one invariant, one implementation, reusing the check `skill_manage edit` already enforces; the unchecked write is what left a broken skill with no way back.
- Add OpenSpace's three-gate behaviour evaluation to the admission gate — rejected: it needs a baseline-vs-candidate replay corpus, deferred while there are no agent-created skills to evaluate (§58.1 row 10).
- Add a separate background-authorship flag for `markAgentCreated` — rejected: `createdBy: 'agent'` now means "the model wrote this through `skill_manage`", broader than the old JSDoc's background-review framing, accepted because `consolidate` defaults to `false` and `/curator adopt`, `/curator pin`, and `protectedNames` remain; a narrower semantics would need its own flag (§58.11).

## Consequences

- The loop closes: a tool-call failure grades into a signal, the signal now moves skill trust through the curator's pass, and the survey carries both into the consolidation prompt.
- Skill life no longer moves on elapsed time alone — only a provisional skill or a `trigger_review` signal justifies patch or archive.
- Any body or supporting-file write resets trust, clears the counted sessions, and re-anchors the skill, so evidence collected before a fix cannot promote the skill that never got the fix.
- Bodies are recoverable: every write carries a revision and `contentSha`, a patch stores its `blobs/<sha>.md` preimage, and `/curator rollback --id` reports the bodies it restored. A row written before bodies were snapshotted has no preimage and is skipped rather than restored.
- A patch that would drop frontmatter is refused before commit, and the `patch` tool text states the frontmatter requirement so the new gate cannot refuse every model patch.
- Trust is recorded and surfaced (survey, `/curator status`) only; it does not gate what the model may load, and it moves at the curator's pass cadence because it needs independent sessions rather than repeated turns within one.

## Deviations from the plan

- `signals()` grades the whole aggregation and slices after sorting: the plan's "built on `summary(sessionIds, limit)`" would let a merely counted failure truncate away the decisive one the caller asked for.
- A pass that only patched bodies still records its `pass` ledger row, so `/curator rollback --id` can reach the bodies. Without it, body restoration was reachable only from a pass that also archived or merged something.
- The patch ledger `after` hash is computed from the committed body rather than from the store's return value, deleting a branch whose two sides were the same hash by construction.
- The `patch` tool description and instruction line now say the replacement must include frontmatter; without that the new gate would refuse every model patch.

## Fixes found on the way

- `packages/skill/evolution-skill-telemetry/src/` carried tracked build output (`*.js`, `*.js.map`, `*.d.ts`, `*.d.ts.map`) on the source plane. Those files made the package's coverage report measure 66% while the suite passed. Removed; the package measures 100% without them. The remaining mirrors across the repo are batch 8's deferred program.
- `evolution-scorer`'s class JSDoc sat on its `declare module` block, which `verify-cordis-catalog` rejects; the same generator also required `SERVICE_PAGE` and unclassified-type entries for both `evolutionScorer` and the feedback and telemetry types this change adds.
- Running `hygiene` surfaced two more owner-local gaps in the same working tree: `evolution-optimizer`'s README never recorded why it publishes no invariant companion, and `python/sdk-runtime` never declared `@deepseek-ai/dsh-embeddings` after the session-query vector channel made it a required peer of `session-query-sqlite`. Both are fixed here. The remaining hygiene failures (vendor rescope, publint's `./src/*` export, NodeNext types needing a full build, vendored links on another agent's dirty `vendor/`, and `client/ui-*` react/clsx placement) reproduce on `HEAD` and are batch 8's.

## Testing

`signals` grading, ordering, and limit behaviour; the whole trust ladder including anchor exclusions and no-op writes; revision chains from `skill_manage` and from `markRevised`; the curator's demotion, success, dry-run, and failing-store paths; the admission gate with both false reasons; a body rollback that restores the exact prior bytes and skips a preimage-less row; and the `/curator status` trust counts and `Restored bodies:` line. 100% statements/branches/functions/lines on `evolution-feedback`, `evolution-skill-telemetry`, `evolution-skill-manage`, and `evolution-curator`; 108 command tests pass.

## Left alone

`command-evolution` still misses coverage on batch 4's journey-export argument parsing and the ledger/unknown-verb usage errors, and `client-ui-evolution` keeps its own gaps — both pre-date this change and neither is on this loop's path. Trust is recorded and displayed only; it does not gate what the model may load.

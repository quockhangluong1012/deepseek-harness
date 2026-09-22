# Agent Note: Failure-memory reflection authoring

Status: implemented

English | [中文](2026-09-22-failure-memory-reflection.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §4.1 asks for the persistent association failure → explanation → corrective heuristic → later retrieval, §4.2 fixes the twelve-field shape of one structured reflection, §4.3 makes failure memory P0 rather than optional, and §21 asks for explicit "do not do this" knowledge with a trigger condition and a regression case. §51 ranks failure memory with anti-patterns and structured reflection as P0 items 2 and 3.

The repository had built the recording half. `evolution-feedback` observed failing tool results, deduplicated them per session, aggregated them by tool and message, graded each aggregate by how decisive it is, and derived the ledger half of a reflection in `reflect`. Nothing consumed it:

- `recordReflection` had no production caller — the package README said so outright — and the intended authors were dreaming's REM phase and reviewer extraction, neither of which writes.
- `reflect` therefore returned `rootCause`, `correctedStrategy`, `reusableWhen`, `antiPattern`, and `candidateTest` as null for every failure, so the §4.2 schema stayed half empty and §21's anti-pattern knowledge was never stored at all.
- No read path returned a stored reflection at all: a reflection could only be assembled over session ids the caller supplied, and nothing read one back as evidence.
- `evolution-curriculum` staged tasks from a gap's failure gists alone, so a staged task carried an error string and no corrective heuristic.

## Decision

1. **`reflectSignals(limit, now)` authors the deterministic half.** It sweeps the store's own sessions newest-write first, grades them with the existing `signals()`, and writes one reflection for every signal graded `trigger_review` that has none. The stored record is the guard, so a second pass over unchanged evidence writes nothing, and `limit` bounds one pass without losing evidence — the next pass picks up the rest. No model is called: the authored half is a template over the failure's identity and its recurrence.
2. **What the author states, and what stays null.** It states `correctedStrategy` (retrying the call unchanged reproduced the same failure — that recurrence *is* the evidence), `reusableWhen` and `antiPattern` (§21's prohibition with its trigger condition), and `candidateTest` (§21's regression case). `rootCause` and `whatWorked` stay null, and stay null by construction: a template can state what happened, never why, and cannot see what already worked despite the failure. `recordReflection` still merges over the authored half without blanking it, so an analyst remains the only writer of a cause.
3. **`reflections(sessionIds, limit)` is the retrieval half.** It returns the stored reflections whose failure one of the given sessions reported, newest write first, assembled by the same code path `reflect` uses — so a reflection read back is the reflection that was written, and a caller only needs the session ids its own seams already name.
4. **One confidence derivation (§20).** The authored half's confidence has to move with recurrence, and a trigger-review signal saturates a session-share formula by definition (its distinct-session count is already at the threshold), so the previous sessions-only formula became three quarters the distinct-session share plus one quarter the per-session recurrence share, each against `triggerReviewSessions`. Independent support dominates, which is §20's rule that confidence rises from independent evidence rather than repeated recall; `reflect` and the stored reflection report the same number because both are assembled by the same helper.
5. **The production consumer is the curriculum.** `propose` matches each gap to the newest stored reflection of that gap's sessions whose symptom is one of its gists, and stages that reflection's `antiPattern` and `candidateTest` on the proposal, so a curriculum task carries the corrective heuristic and not only the error string. Both texts are the whitespace-normalized failing result clipped at their own budget — the trace's gist at `maxChars`, the reflection's symptom at `maxMessageChars` — so identity is prefix containment and needs no similarity threshold.

## Alternatives considered

- **Author only for caller-supplied sessions.** Rejected: no caller holds the store's full session list, and the seams that do name sessions (telemetry, trace) see the sessions a skill ran in, not the sessions that failed. The store owns its observations, so it sweeps them.
- **Let a model name the root cause while authoring.** Rejected: it would put a model call inside a heartbeat-cadence loop, and a model-authored cause in a durable record is unaccountable when a later pass reads it as measured fact. The field stays null instead.
- **Derive the anti-pattern and candidate test at read time.** Rejected: §21 asks for stored negative knowledge, and the stored record is what makes the second authoring pass a no-op. A derived field would also differ between the reflection that was written and the one read back.
- **Store the authored confidence on the record.** Rejected: that would put a stored confidence beside the computed one, two conventions for one field. The formula moved to cover both writers instead.
- **A new table or domain for authored reflections.** Rejected: the feedback domain already keys a `reflections` table by merge key, and the deterministic half has exactly the shape of the analyst half. Nothing about the domain's schema or version changed.
- **Match a curriculum gap to a reflection by capability or by similarity.** Rejected: a capability is a skill and a reflection is a failure, so capability says nothing about which failure a task should reproduce; and the gist and the symptom are two clips of one observed text, so prefix identity is exact.
- **Publish a session enumerator on the feedback store.** Rejected: a loop needs the reflections of the sessions its own seams name, which `reflections` answers; an enumerator would be a second way to read the same state and a second way to get the session set wrong.
- **Append the heuristic to the curriculum's task text.** Rejected: the task text is clipped to a bounded budget, so the regression case would fall off the end of most tasks. The heuristic rides in its own two proposal fields.

## Consequences

- Failure memory closes end to end: a failure decided in two sessions becomes a durable reflection with a strategy, a trigger condition, an anti-pattern, and a regression case, retrievable by session for as long as the domain holds it.
- The confidence a read reports changed. A failure seen twice in one session scores 0.625 where it scored 0.75, one seen once in each of two sessions scores 0.875 where it scored 1, and an unattributed failure still scores 0.25. Every value stays in `[0, 1]`, and the graded ordering a caller sees is unchanged.
- `evolution_curriculum`'s proposals gained two nullable fields, so the domain moved to version 2 with `compatibleVersions: [1]`; the fields default to null, so a proposal stored under version 1 opens unchanged.
- A curriculum proposal now states the heuristic that was current when it was staged rather than recomputing it, so a later change to the authoring templates does not rewrite a proposal that was already staged.
- Nothing here reaches a model prompt. `reflectSignals` calls no model, and the curriculum stores what it matched rather than rendering it.

## Testing

`packages/evolution/evolution-feedback/tests/reflection.spec.ts` pins the derivation and the new authoring path. The derivation test now fixes the confidence blend — the same failure twice in one session scores 0.625, once in each of two sessions 0.875, and an unattributed failure 0.25. Two new tests record the same failure in two real sessions and then: `reflectSignals` writes exactly one reflection carrying the exact anti-pattern and candidate test, with `rootCause` and `whatWorked` null; a second pass writes nothing; `reflections` returns stored reflections newest-written first and reports nothing for a session that never reported the failure; the limit bounds one pass without losing evidence; an analyst's `recordReflection` merges over the authored half without blanking it; and both new reads reject before the store starts.

`packages/evolution/evolution-curriculum/tests/curriculum.spec.ts` boots the real failure-memory store over real sessions and stages proposals from measured gaps: the gap whose gist is the reflected symptom, and the gap whose shorter gist is one of its clips, both carry the reflection's anti-pattern and candidate test; a gap with an unrelated gist and a gap whose sessions never reported the failure carry null; a host without the failure-memory seam stages null; and the heuristic is read back from the proposal store, not only from the staging result.

Coverage over both packages is 100% statements, branches, functions, and lines per `src` file, which is the repository's gate.

## Left alone

`recordReflection` keeps its shape and its role as the analyst's path; nothing calls it in production yet, and this change does not invent a caller for it — a deterministic author can state what to do instead but not why the failure happened. `summary` still serves the curator's survey prompt with counts alone. The feedback domain's schema and version are untouched. The curriculum's task text is unchanged. The dreaming REM phase and the reviewer extraction that the README once named as the intended authors are not wired here: `reflectSignals` is the deterministic author the curriculum consumes, and a model-authored cause remains deferred.

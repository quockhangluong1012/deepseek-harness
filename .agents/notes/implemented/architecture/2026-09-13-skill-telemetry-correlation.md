# Agent Note: Skill telemetry correlates loads with sessions so curation reflects on real failures

Status: implemented

English | [中文](2026-09-13-skill-telemetry-correlation.zh.md)

## Problem

Curation could see how often a skill was used but never what happened when it was used. Skill telemetry is keyed by skill name and counted loads, views, and patches; failure feedback is keyed by session and recorded what went wrong. Nothing joined them, so "the failures observed while this skill was in play" was underivable — and the consolidation fork, which is the only reflective pass in the harness, decided a skill's fate from its own text and its counters.

That left the reflect half of a reflective optimizer with nothing to reflect on. A patch verdict could only restate the skill's author intent, not answer what broke.

## Decision

`SkillUsageRecord` gains `sessionIds`: the sessions that loaded a skill, newest first, deduplicated, capped by the store's `maxSessionIds` (default `20`). `markUsed(name, source, sessionId)` writes it, and the passive `tools/post-execute` observer supplies `exec.agent?.session.id` — so the correlation arrives with the load and needs no extra wiring from a consumer. Views and mutations record no session.

`SurveyCandidate` gains `failures`: the tool, message, observation count, and reporting-session count for each failure recorded in the correlated sessions, most-observed first and capped by the curator's `maxCandidateFailures` (default `5`). `surveyCandidates` gathers them from `ctx.get('evolutionFeedback')` — the seam stays optional, and an unmounted store yields an empty list rather than a failure.

The failures ride in the survey JSON that the consolidation fork already receives, so the existing pass reflects on observed failures before it patches, and every write still lands through the curator's snapshot, ledger, and rollback machinery. No new package, no second skill-write path.

## Alternatives considered

**Join at read time from the session logs.** The correlation could have been derived per pass by searching each candidate's sessions for the `skill` tool call. That costs a history scan per candidate per pass and depends on the ranked search seam being mounted and returning the right rows; writing the session down at the load site is O(1) and needs nothing.

**Build a separate optimizer package.** A GEPA-shaped pass could have been its own package consuming feedback directly. But the reflect-and-mutate half already exists as the consolidation fork — bounded tool loop, whitelist, cost ledger, full-package rule — and a second package would have needed its own skill-write path plus its own snapshot, ledger, and rollback, duplicating the safety kit the curator already ships and had already been tested against.

**Key failure feedback by scope instead of by session.** Storing failures under the scope identity would have removed the join entirely, since both sides would share one key. It was rejected when the feedback store was built for a different reason — scope resolution per event needs workspace membership — and it stays rejected here for the same one: the join is worth one field on a record that is already written on every load.

**Correlate views and mutations too.** Human views and `skill_manage` patches could have recorded their sessions as well. A view is not evidence that a skill failed, and since the list is bounded, noise would displace the loads that carry the actual signal.

## Consequences

The reflective pass can now be told what actually broke, and the join key exists for any later optimizer that wants it.

The trade-offs are recorded in the package READMEs: correlation is bounded to the newest `maxSessionIds` sessions and to loads only; a session that loaded a skill before this shipped carries no correlation; and the survey frame grows by the evidence it carries, so candidates still drop from the end under `maxInputBytes` pressure. `maxCandidateFailures` defaults low for that reason — the evidence shares the survey's byte budget with the candidates themselves.

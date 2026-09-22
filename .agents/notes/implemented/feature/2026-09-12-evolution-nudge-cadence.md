# Agent Note: Evolution nudge cadence

Status: implemented

> The cadence fields, their validation, and the process-local turn counting remain current. The trigger half — `isNudgeTurn`'s modulo and the fixed advice text it gated — is superseded by [condition-based evolution nudges](../architecture/2026-09-22-condition-based-nudges.md), which keeps both intervals as the cadence ceiling over recorded conditions.

English | [中文](2026-09-12-evolution-nudge-cadence.zh.md)

## Problem

The injector registered three system-prompt sections that repeated on every assembly: the lessons-to-skills nudge, the scope-narrowing nudge, and the session-search hint. Two of them are behavioural advice, and advice repeated in every request of every turn spends prompt bytes for a message the model has already read, while making the prompt differ from the previous turn only in the capacity value.

`specs/evolutionary-harness.spec.md` names the missing knob as `memoryNudgeInterval` and `skillNudgeInterval`, defaulting to 1 and 10 turns.

## Decision

The injector counts observed `turn/start` events per session and renders each advice nudge only when the count is a positive multiple of its interval. `skillNudgeInterval` defaults to `10`, `memoryNudgeInterval` to `1`, so the shipped composition keeps the scope nudge on every turn and shows the skill nudge once per ten turns. The session-search hint stays unconditional: it answers a question the model asks itself when it needs recall, not a habit to form.

`isNudgeTurn(turn, interval)` lives in `sections.ts` as a pure predicate, and a session with no observed turn yet reads as its first, so an interval-1 nudge renders before the first turn rather than disappearing at session start.

Both intervals are validated config (`min(1)`, integer steps) and resolved in one explicit `resolveConfig` step beside the required `maxBytes` and `profile`, matching how the sibling evolution packages default their optional fields. The registration path therefore contains no inline fallback.

## Consequences

Prompt bytes and prefix stability both improve: within a cadence window the advice text repeats identically across requests, and the nudge set changes only on an interval turn, so the prefix is stable for longer stretches than before. The capacity value still changes with usage, as it must.

The counter is process-local and counts only turns this process observed: turns before plugin load, before a host restart, and `turn/start` events replayed from history do not advance it, so a resumed session begins its cadence from its first observed turn. That matches how the injector already treats membership and digests — every surface it owns is rebuilt from observation, never from a rescan of history.

## Verification

`tests/sections.spec.ts` adds three specs: with `memoryNudgeInterval: 6` and `skillNudgeInterval: 4` a single session shows each nudge only on its matching turns (0 and 1 hide both, 4 shows skills only, 6 shows scope only, 12 shows both, 13 hides both) while the session-search hint renders every time; two sessions count independently and a non-`turn/start` event leaves the count alone; and the default cadence (1/10) keeps the scope nudge on every turn while withholding the skill nudge before turn ten. `tests/inject.spec.ts` adds the load-time case: zero, negative, and fractional intervals fail plugin load with the field name in the message. Per-file 100% holds on statements, branches, functions, and lines.

## Alternatives considered

**Counting turns from the session log.** Rejected: it needs the asynchronous query seam on the injection path, which the injector deliberately keeps off the hot path; a per-session counter costs one map entry.

**Sending the nudge once per session.** Rejected: a habit worth stating once is worth restating rarely, and a session can run for hours; the interval keeps the reminder alive without repetition.

**Gating the session-search hint too.** Rejected: the hint is recall advice, and the model that never sees it searches less; the two intervals cover the advice nudges the specification names.

---
title: Reviewer scheduling flows (reviewer index)
id: reviewer-scheduling-flows-reviewer-index
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:43.085063Z'
updated: '2026-09-13T02:05:16.806673Z'
source: packages/evolution/evolution-reviewer/src/index.ts
status: review
type: note
deprecated: false
summary: Buffer-flush scheduling, output filter chain, rebuild, squeeze pressure order
---

# Reviewer scheduling flows (evolution-reviewer index.ts)

Primary source: `packages/evolution/evolution-reviewer/src/index.ts` (turn buffering, gating, ranked recall, rebuild).

Listener routes `session/event`: `turn/start` resets the per-session buffer, `turn/end` flushes via `observeTurn` in a warn-only try/catch, other events buffer. No synchronous history scan; in-flight turns contribute their observed suffix.

`observeTurn` order: resolve scope, always run `indexOutputs`, derive recall query, then gate extraction (`enabled`, `minTurnTextBytes`, `cooldownMs`, route). Output filter: tool in `outputTools`, non-error result, `file_path` else `path`, `str_replace_editor` skips `view`/`undo_edit`, resolved against session cwd, kept only inside the scope directory. `recordOutputs` is the only production caller path (reviewer `index.ts:849`); merge is newest-first capped by `maxOutputs`, idempotent.

Rebuild scans newest-first up to `rebuildSessionLimit` sessions (archived dropped), ranked recall first with exact-scan fallback, always writes directly with `origin: 'rebuild'` even under `writeApproval`. Squeeze reduces output to the four headings (pressure order References, Decisions, Preferences, Purpose) with UTF-8 clipping and a `truncated` flag.

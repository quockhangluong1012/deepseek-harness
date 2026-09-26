---
title: Reviewer contract (evolution-reviewer README)
id: reviewer-contract-evolution-reviewer-readme
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:08.631537Z'
updated: '2026-09-13T02:05:20.619510Z'
source: packages/evolution/evolution-reviewer/README.md
status: review
type: note
deprecated: false
summary: Always-on output indexing vs gated extraction with full default table
---

# Reviewer contract (evolution-reviewer README + config)

Primary source: `packages/evolution/evolution-reviewer/README.md` (background review with per-turn output indexing, gated lessons extraction, on-demand rebuild).

"Completed turns trigger extraction; output indexing always runs"

Defaults: `enabled true`, `minTurnTextBytes 200`, `cooldownMs 60000`, `defer auto`, `deferMaxAgeMs 1800000`, `maxInputBytes 131072`, `maxOutputTokens 1024`, `timeoutMs 60000`, `rebuildSessionLimit 20`, `recallLimit 20`, `recallQueryChars 160`, `outputTools write,edit,str_replace_editor`, `writeApproval false`.

Turn extraction writes the whole lessons document recording `background_review` as its writer; under `writeApproval` it stages a `setLessons` op instead; explicit rebuild keeps writing directly. Failed extraction warns and keeps the previous document. Ranked recall lands one `Recall:` context item, rendered last so it drops first under pressure.

---
title: Spec composition and limits
id: spec-composition-and-limits
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:02.964540Z'
updated: '2026-09-13T02:05:27.721900Z'
source: specs/evolutionary-harness.spec.md
status: review
type: note
deprecated: false
summary: Web-app-only composition, machine-local storage, disable-by-removing-rows
  plus limits
---

# Spec composition and limits (specs/evolutionary-harness.spec.md)

Primary source: `specs/evolutionary-harness.spec.md` (behaviour contract: composition, limits, product choices).

"Evolution rows go in `web-app` bundle first, not `base`, so `headless`/`sdk`/`acp` snapshots stay byte-identical until explicitly adopted."

"Both memory and skills stay machine-local under `$DSH_HOME`; neither writes inside the user's project directory."

"Disabling is removing rows: no records read, no brief, no extraction, sidebar falls back."

Limits: web-only first (scopes exist only in web composition); one brief at a time; file context re-read per refresh; outputs tool-derived; extraction needs a route; reviewer/curator cost billed.

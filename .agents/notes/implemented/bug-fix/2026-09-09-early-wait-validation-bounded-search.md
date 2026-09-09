# Agent Note: Early wait validation and bounded web search

Status: implemented

English | [中文](2026-09-09-early-wait-validation-bounded-search.zh.md)

## Problem

`job_output` clamped `timeout_ms` with `Math.min` before validating it, so a negative or non-integer value fell through to the registry's generic wait error instead of a clear tool-level message, and the schema accepted `number` while every other millisecond budget in the repo is `integer`. `web_search` capped source count but kept unbounded per-source snippets and provider answers, so one verbose provider could blow the parent context. `terminal_send` never told the model that only one send may be active per session.

## Decision

`timeout_ms` is `integer` in schema and validated up front as a positive safe integer with the offending value echoed; the clamp to the configured cap still applies after. Search bounds snippet characters per source (`searchSnippetMaxChars`, default 500) and provider-answer characters per result (`searchContentMaxChars`, default 4000) as validated plugin config, applied to both the canonical result and the replayable meta. `terminal_send` documents its backend-bounded wait and the one-active-send rule.

## Alternatives considered

**Render `whenToUse` in the skill catalog.** Rejected because the catalog test pins name-and-description lines only; the fixture skill literally named "Never render this routing hint" proves omission is the designed contract.

**Retitle workflow and `ralph` result cards.** Rejected because both presenter tests pin the empty generic card; the cosmetic gain is not worth the contract churn.

**Ship default telemetry rules.** Rejected because changing pass-through default is breaking; opt-in helpers from the prior batch preserve the explicit contract.

## Consequences

Bad waits fail fast at the tool boundary with the value echoed, search context stays bounded per deployment config with catalog and config-catalog entries, and the terminal send contract matches backend reality.

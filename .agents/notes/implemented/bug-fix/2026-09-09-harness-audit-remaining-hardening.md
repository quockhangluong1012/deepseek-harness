# Agent Note: Harness audit remaining hardening

Status: implemented

English | [中文](2026-09-09-harness-audit-remaining-hardening.zh.md)

## Problem

Four audit gaps from `specs/spec.md` were still open. A tool-calling loop that never overflowed context could run unbounded: `agent-loop` had per-request `maxTokens` but no per-turn step or token ceiling (#34). A prompt-variable typo crashed first-turn assembly, and there was no escape syntax for a literal `{{…}}` (#36). Each instruction file was capped by `maxSourceBytes` but nothing bounded the sum read across a baseline, and over-cap sources were silently ignored (#37). Beyond the four, Agent Notes stated repository paths, packages, and scripts no checker verified; `verify-md-links` had no incremental mode; the tool catalog said nothing about runtime-minted `mcp__*` and `structured_output` tools; and the live-scheduler unknown-outcome closers, attempt-id uniqueness across resume, and the full-loop approval audit pair were executed but unasserted.

## Decision

`maxSteps` is a validated `agent-loop` Config field (default 100, over 10x the longest recorded product turn of 7 steps) with the same live settings read-through as `maxParallelToolCalls`. A turn that would enter more steps than the ceiling ends with the new `max-steps` `TurnEndReason` instead of running on, even when a steer queued more work; a turn finishing exactly at the ceiling still ends normally, and the first ceiling hit owns the outcome like `max-tokens`. Consumers treat the ceilings symmetrically: ACP maps `max-steps` to `max_turn_requests`, session-query renders the kind, the goal driver disarms, and consumed-work accounting covers it through the merge-extensible default.

Prompt templates gain a `\{{` escape for a literal brace pair. Static section and context text with a malformed `{{…}}` group throws at registration, where the defect is self-contained; unknown variable names still throw at assembly, which is the earliest point the full registered set is known, since section and variable registration order is contributor-controlled.

`maxTotalSourceBytes` (default eight per-file caps) bounds one baseline load or reconciliation batch. Skipped sources are reported, not silent: loads return the drops, the plugin logs `workspace instruction source skipped (over-source-cap|over-total-budget)`, and a load that keeps nothing still reports its drops with empty rendering.

`verify-agent-note-refs` asserts every path, package export, and colon-namespaced script an `implemented/` note states in backticks, with intentional historical references recorded in `scripts/agent-note-refs.allowlist.json` (stale entries fail). `verify-md-links --since <ref>` checks only the Markdown sources changed since the ref through `change-scope`, while anchors still resolve against the full corpus. The tool catalog scope names the runtime-minted tools and links their owning READMEs.

Backfill tests pin the live-scheduler unknown-outcome closers (every started call cited by its own `tool/call` seq), attempt-id uniqueness across a reload resume, and the full-loop approval asked/decided pair under read-only + ask. Session v2 fixtures are untouched; only current-generation v3 outputs and owner-local expected files carry the new baseline identity. The SDKs need no change: turn-end reasons cross them as stringly-typed pass-through.

## Alternatives considered

**Monitor runaways instead of bounding them.** Rejected because compaction bounds context, not work; without a ceiling a conforming loop has no terminal event for a pathological turn.

**Escape by doubling braces (`{{{{`).** Rejected because prompt text already uses braces for shell and template examples, where a backslash escape reads locally; the scanner treats an even backslash run as interpolation so Windows paths keep working.

**Unknown-variable check at section registration.** Rejected because contributors register variables after sections in the same activation; the check would false-positive on legal orderings. Assembly is the earliest resolvable point.

**Soft ceiling that lets steered work continue.** Rejected because a safety bound that yields to any steer is advisory; the ceiling breaks the turn and the queued message drains in a fresh turn.

**Rewrite retained session v2 fixtures with the new identity.** Rejected under adjacent migration: replay selects the highest generation, so only v3 outputs move; v2 generations stay byte-identical.

## Consequences

Runaway tool loops end loudly with a durable `max-steps` reason; prompt typos fail at plugin load with section attribution while literal braces stay writable; instruction reads stay bounded with logged skips; renamed packages, scripts, and moved files break the note-integrity gate instead of rotting in prose; one-file doc changes check in seconds; dynamic tools are discoverable from the catalog; and scheduler-failure transcripts, resumed attempt ids, and approval audits are pinned by tests.

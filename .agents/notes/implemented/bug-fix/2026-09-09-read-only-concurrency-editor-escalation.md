# Agent Note: Read-only concurrency flags and editor escalation parity

Status: implemented

English | [中文](2026-09-09-read-only-concurrency-editor-escalation.zh.md)

## Problem

Read-only tools missed the scheduler's parallel-dispatch signal: `lsp`, `glob`, and `grep` never set `isConcurrencySafe`, so the PTC dispatcher could not tell them apart from mutating tools, and the LSP description never said queries to one workspace serialize. `str_replace_editor` mapped sandbox denials without advertising the `sandbox_permissions`/`justification` retry that `tool-fs` write/edit offer, so a denied editor mutation left the model with no escalate path.

## Decision

`lsp`, `glob`, and `grep` set `isConcurrencySafe: () => true`; the LSP description documents per-workspace serialization and prefers sequential or distinct-workspace fan-out, and its `line`/`character` schema narrows from `number` to `integer` to match runtime validation. `str_replace_editor` advertises `sandbox_permissions`/`justification` under a confining backend, resolves mutations through the approved-escalation policy with pairing validation and loud misconfiguration errors, and maps denials to the shared marker plus escalation hint. Workflow and `ralph` stay without the flag because script execution has side effects.

## Alternatives considered

**Mark workflow and `ralph` concurrency-safe.** Rejected because script and loop execution mutate state; the flag is only for side-effect-free reads.

**Share job limits by session id or fail the invariant on unresolved calls.** Rejected because existing tests pin both contracts: limits are per exact owner object and step end allows unresolved calls for repair closers.

**Fail compaction loud on tool-call output or ship default telemetry rules.** Rejected because the summarizer contract keeps tool calls in `rawOutput` while projecting text, and telemetry keeps no-rules default with opt-in helpers.

## Consequences

Parallel scheduler dispatch recognizes the read-only tools, LSP fan-out guidance matches provider reality, editor denials carry the same retry path as `tool-fs`, and the tool catalog carries the narrowed LSP coordinates.

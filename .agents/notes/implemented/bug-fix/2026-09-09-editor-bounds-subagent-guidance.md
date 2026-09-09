# Agent Note: Editor bounds and subagent text guidance

Status: implemented

English | [中文](2026-09-09-editor-bounds-subagent-guidance.zh.md)

## Problem

`str_replace_editor` buffered whole files before truncating, so a gigabyte file could exhaust memory before the 16k-char view cap applied, directory views had no visited set or entry cap, and `str_replace` accepted an unbounded `old_str` for its O(n*m) scan. Subagent delegation wording did not tell the model that only the child's text reaches the parent conversation, so image or file-handle output silently became empty text.

## Decision

View, `str_replace`, and `insert` reject files over 5,000,000 reported bytes with guidance to use `grep -n` plus `view_range`, `old_str` over 1,000,000 bytes is rejected, and directory views dedupe visited paths and stop at 500 entries. Both fork and fresh delegation prompt descriptions ask for a text answer and state that only the child's text reaches the parent conversation; the full block array stays available to programmatic PTC consumers.

## Alternatives considered

**Stream large files through the editor instead of refusing.** Rejected because the editor's contract is exact line-numbered views and literal replacement; bounded refusal with `grep` guidance keeps the contract while `tool-fs read` already covers streaming reads.

**Fail the session invariant on unresolved calls or share job limits by session id.** Rejected because existing tests pin both contracts: step end allows unresolved calls for repair closers, and job limits are per exact owner object so a replacement agent gets a fresh bucket while access stays id-fenced.

**Fail compaction loud on tool-call output or ship default telemetry redaction rules.** Rejected because the summarizer contract keeps tool calls in `rawOutput` while projecting text only, and telemetry documents no built-in rules as a known limitation; both need schema-by-schema audits first.

## Consequences

Large-file editor calls fail fast with actionable guidance instead of risking memory exhaustion, directory views stay bounded and duplicate-free, huge search strings are rejected before the scan, and delegation prompts set the correct text-only expectation without changing the programmatic output contract.

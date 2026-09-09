# Agent Note: Structured delegation and opt-in telemetry scrubbing

Status: implemented

English | [中文](2026-09-09-structured-delegation-telemetry-scrub.zh.md)

## Problem

`tool-subagent` never exposed the seam's `outputSchema`: the in-process driver already supported `structured_output` capture with two-phase commit, but the model could only ask for free text and parse JSON itself. Telemetry offered the `session-telemetry/record` waterfall with no reusable rule starter, so every deployment hand-rolled secret scrubbing from the e2e fixture.

## Decision

The delegation tool accepts an optional object-rooted `output_schema` (`json`) on foreground one-shot runs, asserts it with `assertObjectJsonSchema`, forwards it as `outputSchema` so the provider capability gate owns rejection, and returns the validated value as an optional `structured` field rendered after the text. Background and continuable runs reject `output_schema` loud because they have no foreground result to carry it. Telemetry adds opt-in `sensitive.ts` helpers (`scrubSensitiveValue`, `scrubSensitiveRecord`, `DEFAULT_SENSITIVE_PATTERNS` for API-like tokens, bearer credentials, AWS keys, PEM blocks) that never apply by default; pass-through without a mounted rule stays explicit and documented.

## Alternatives considered

**Share job limits by session id or fail the invariant on unresolved calls.** Rejected because existing tests pin both contracts: limits are per exact owner object with a fresh bucket for replacements, and step end allows unresolved calls for repair closers.

**Fail compaction loud on tool-call output.** Rejected because the summarizer contract keeps tool calls in `rawOutput` while projecting text only; the existing test pins silent projection.

**Ship default telemetry rules.** Rejected because changing pass-through default is breaking; opt-in helpers plus documentation preserve the explicit contract while giving deployments a narrow starter.

## Consequences

Models can request machine-checkable child results without text parsing, with provider capability rejection staying loud and background misuse rejected at the tool boundary. Deployments get a tested scrubbing starter without changing the no-rules default, and the tool catalog carries the new `output_schema` and `structured` fields.

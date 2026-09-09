# Agent Note: Decode pixel cap and single-spill search results

Status: implemented

English | [中文](2026-09-09-decode-cap-single-spill.zh.md)

## Problem

Image admission checked header dimensions before the full-raster decode but left the decoder itself uncapped: a lying header could pass the dimension check and then drive unbounded pixel amplification in `raw().toBuffer()`. Separately, `glob` and `grep` spilled their own capped results with paging guidance while the generic spill policy spilled the same call a second time, writing a duplicate artifact for one oversized result.

## Decision

`detectImage` carries the configured `maxPixels` into the decoder's own pixel cap so a lying header fails during decode, and a decoder pixel-limit rejection maps to `IMAGE_TOO_MANY_PIXELS` rather than generic `INVALID_IMAGE`. The spill policy's model-facing arm skips `glob` and `grep` alongside `read`, leaving their self-spilled paging result as the single artifact.

## Alternatives considered

**Lengthen the spill session-dir hash.** Rejected because tests and the startup sweep pin the `session-<12hex>` shape; the 48-bit dir plus 48-bit file randoms already make collision negligible, so renaming buys churn without a real threat model.

**Fail the session invariant on unresolved calls or share job limits by session id.** Rejected because existing tests pin both contracts: step end allows unresolved calls for repair closers, and limits are per exact owner object.

**Ship default telemetry rules or fail compaction loud on tool-call output.** Rejected because telemetry keeps its explicit no-rules default with opt-in helpers, and the summarizer contract keeps tool calls in `rawOutput` while projecting text.

**Implement SDK wire-cancel now.** Deferred to a proposed RFC: it needs a protocol method, capability negotiation, and a version-skew matrix across both SDKs, which does not fit a behavior-fix batch.

## Consequences

Lying image headers fail closed with the correct pixel-limit code instead of risking memory amplification, search tools produce exactly one spill artifact per capped call, and the SDK cancel design waits as a reviewable proposal.

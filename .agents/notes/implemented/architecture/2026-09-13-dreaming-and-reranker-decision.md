# Agent Note: Dreaming consolidates recorded failures, and the hybrid search ships without a reranker

Status: implemented

English | [中文](2026-09-13-dreaming-and-reranker-decision.zh.md)

## Problem

Two mechanisms from the specification were unimplemented, and they raised different questions.

**Dreaming consolidation** (§5) turns repeated observations into durable memory through a three-phase cycle with a six-signal weighted composite. The specification drives it from a cron schedule over daily notes, and neither exists here: this repository schedules idle-triggered work through a heartbeat, and it keeps no daily notes. It also names two documents — `DREAMS.md` for the narrative, `MEMORY.md` for what survives — where this repository has a model-owned lessons document that the reviewer already writes.

**The reranker** (§15.3) is a cross-encoder over `(query, document)` pairs. This repository has no cross-encoder runtime, no Python, and no ONNX: the honest options were to acquire one, to call a model per search, or to ship without it.

## Decision

**Dreaming ships as `dsh-evolution-dreaming`**, with the specification's three phases read against what this repository actually has.

Candidates are the scope's recorded failures, read from `dsh-evolution-feedback`. That choice carries every signal the composite needs: a failure already records how often it was observed (`frequency`), in how many sessions (`query diversity`), and between which two instants (`recency`, `integration`). Nothing had to be invented to feed the algorithm.

The three phases keep their meanings: light gathers and deduplicates, REM derives themes and writes the narrative, deep is the only phase that writes durable memory. Promotions go into the plugin's own `evolution_dreams` domain rather than the lessons document, so the model and the cycle are never two writers on one document.

Weights are constants in the code, because they are the algorithm; thresholds, cadence, and retention are validated configuration, because they vary by deployment. Every signal is normalized to `0..1` by a saturating map before weighting, so a failure seen ten thousand times cannot outrank one seen in every session. The automatic cycle registers with `dsh-evolution-heartbeat` and runs `dreamAll()` over the workspaces the registry knows.

**The reranker is not implemented.** Fusion already produces one ranking from two channels, and adding a model call per search would trade the latency the vector channel was built to protect for a second opinion the fused ranking already carries. The decision is recorded here rather than left as a silent absence: the specification's reranker assumes a cross-encoder runtime this repository does not have, and buying one is a larger decision than a missing stage in one search path.

## Alternatives considered

**Dreaming as a third phase inside `evolution-curator`.** The curator already runs idle passes over skill telemetry. It would have avoided a package. It would also have merged two different subjects — skill lifecycle and memory consolidation — into one plugin with one schedule, and the operator who wants to tune promotion thresholds is not the operator tuning skill archiving.

**Dreaming over a daily-notes directory.** The literal reading of the specification. This repository has no such directory, so the cycle would have had to create and maintain one whose only consumer is the cycle itself.

**Writing promotions into the model-owned lessons document.** It would make the promoted statements immediately visible to the model. It would also give the document two writers, and the reviewer's compression of it would silently discard whatever the cycle had just promoted.

**A cross-encoder reranker as a new capability seam.** It would be the faithful reading of §15.3. Without a provider in the repository it would be a Definition nothing implements, which the capability-seam rules forbid.

**LLM-as-reranker through `ctx.llm`.** It fits the plugin architecture. It also spends a model call on every search, including the searches the content-hash cache was added to make cheap, and it would score pairs the fused ranking has already ordered.

## Consequences

A scope that keeps failing the same way can now have that failure promoted into durable memory without a human approving each entry, and the decay rule keeps that memory from growing without bound.

The trade-offs are recorded in the package README: relevance is lexical until an embedding provider is wired in, promotions are not yet injected into model context, the heartbeat cadence is one value per deployment, and the `/dream` command runs the cycle or one phase for the invoking scope.

The service renders on the subsystem page and in the capability-seams graph, and `dsh-command-evolution` now imports it, which is what makes the projection reach it.

Search keeps its two-channel fusion and gains no rerank stage. A deployment that wants one can add a provider later without changing the fused ordering that callers already rely on.

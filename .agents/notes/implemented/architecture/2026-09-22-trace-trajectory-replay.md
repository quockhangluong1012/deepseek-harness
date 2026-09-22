# Agent Note: Complete trace trajectory and counterfactual replay

Status: implemented

English | [中文](2026-09-22-trace-trajectory-replay.zh.md)

## Problem

Two mechanism families in `specs/evolutionary-harness-v11-deep-research.md` were half-built.

**§3.1/§3.3 — the trajectory was incomplete.** `dsh-evolution-trace` projected the committed session log into turns, steps, tool calls, retries, usage and latency, with ranked failure causes and a compressed learning row. Everything else the spec's §3.1 trajectory list names was missing even where the log recorded it: the compiled-context identity each step ran under (`context/compiled`), the plan and subgoals (`todo/write`, `task/plan`), the knowledge surfaces consulted (retrieval calls), the answer a turn ended on (its last assistant text), evaluator results (`verification/result`), and user feedback (`feedback/record`). A reader asking "what context was this step decided under, and what did the session actually conclude?" had to re-read the raw log.

**§16/§17 — there was no replay over production traces.** The only replay engine in the repository was the `disabled: true` scorer's recorded-fixture runner, which boots fresh subprocesses against on-disk corpus fixtures. Nothing compared a baseline artifact against a candidate *on the same trace the session log already holds*, and the trace's recorded tool output — the one thing that makes a keyless, deterministic replay possible — was not retained at all: the projection kept a failed call's text and discarded every successful call's.

## Decision

Extend the existing read-only projection and add one pure replay module to the same package. No new package, no new storage domain, no model call, no write.

1. **Carry only what the log records, and say so where it does not.** Each new `TraceRecord`/`TraceTurn`/`TraceStep` field is sourced from a logged event: `context/compiled` for the step's context identity (its `digest`), `todo/write` (with per-subgoal status) and `task/plan` (without) for the plan in force, retrieval calls for the knowledge surfaces, the last assistant text for the final answer, `verification/result` and `feedback/record` for evaluations and human remarks. The README carries the §3.1 list as a table naming the source of each row and marking the two the log cannot supply — `intermediate decisions` and `artifact versions used` — as absent rather than emitted as placeholders.
2. **`TraceToolCall.snapshot` is the replay substrate.** Every call now keeps the clipped text of its recorded result, whatever its outcome, where before only a failing call kept text. This is §17's "snapshot the relevant tool outputs": a replay reads recorded output instead of re-invoking a tool, so it needs no key, no process and no live external state.
3. **Replay is a pure function over one already-projected record.** `replayTrace({ trace, baseline, candidate })` walks the trace's steps, reports each step's reconstructed context digest, resolves each call to `snapshot`, `artifact` or `missing`, and compares the baseline resolution against the candidate's. `EvolutionTrace.replay(sessionId, baseline, candidate)` is the read path that projects the stored log first and returns `undefined` for an absent session, exactly as `trace` does.
4. **The artifact's observable effect is the retrieval surface.** Where the trace recorded a retrieval naming an artifact both revisions claim, the replayed output is the restored body; elsewhere the recorded snapshot stands. This is what the trace can support: it records that a retrieval happened and what it returned, not what the model then did with it.
5. **The snapshot gates replayability, and an unreplayable step is never "unchanged".** A call whose result the log recorded no text for resolves to `missing` under *both* revisions — deliberately not to the artifact body, because that would be a guess about what the recorded run saw. Such a step is reported `unreplayable`, its tools are named, and `differs` is false only because there is nothing to compare. `snapshotSteps`, `changedSteps` and `unreplayableSteps` name three different sets so a caller cannot read silence as evidence.
6. **The projection binds records to the span open when they arrive, and drops that binding at the closers.** `step/end` and `turn/end` clear the open step and turn. Without this, a plan or compilation written *after* a span closed overwrote the span's own record — a bug this change introduced and caught with its own tests, not a pre-existing one.

## Alternatives considered

- **A separate `evolution-replay` package.** Rejected: the replay's entire input is a `TraceRecord` this package produces, and its output is a report over that record. A package boundary here would mean exporting the whole trace vocabulary across two manifests to reach one pure function, and would put the §17 mechanism somewhere other than the trace it replays.
- **Hosting the replay in `evolution-scorer`.** Rejected: the scorer's replay boots subprocesses against a corpus, needs a corpus directory, and its row ships `disabled: true` in the product profile. §17's replay must work from recorded traces in the shipped profile without that row, and the scorer is a measurement package — putting a read-only comparison there would also make a measurement package the owner of trace semantics.
- **Re-invoking tools to replay a step.** Rejected: that reintroduces exactly the nondeterminism §17 warns about and would need a live sandbox and key. The recorded snapshot is the simulator.
- **Letting an artifact body stand in for a call the log recorded no output for.** Rejected: the baseline resolution would then be a claim about a run whose output nobody recorded. Reporting the step unreplayable is the honest answer, and it is what the acceptance criterion asks for.
- **Declaring artifact versions from the trace itself.** Rejected: nothing in the session log records a retrieved artifact's revision — skills carry revisions in `evolution-skill-telemetry`'s own store, which the trace does not read and must not start reading. `ReplayArtifact` therefore takes `id`, `version` and `body` from the caller, and the README states that a caller naming the wrong revision gets a comparison of the wrong pair.
- **Adding a live turn-settled emission to close §51 item 1's "event bus".** Deferred, not rejected: the spec's own priority map places the bus's consumers (curriculum, shadow/canary) at P1, no consumer exists to receive the event, and the README already documents the absence. Building a bus with no subscriber would be a registration with no reader.
- **Projecting `action/proposed`/`action/committed` as §3.1 "intermediate decisions".** Rejected: those events exist only when `agent-kernel` is mounted, and no shipped profile mounts it, so the field would be permanently empty in the product — a placeholder, which is what item 1 of this change forbids. The README names the item as not sourceable instead.
- **Declaring the four foreign payload types locally instead of importing them.** Rejected: `ContextCompilationRecord`, `VerificationResult`, `FeedbackRecord` and `TodoItem` are the owning packages' published session-log vocabulary; re-declaring them here would be a second convention beside the first, and it would silently drift. The imports are type-only, so the runtime import closure is unchanged.

## Consequences

- `TraceRecord` gains `evaluations` and `feedback`; `TraceTurn` gains `subgoals`, `retrievals` and `finalAnswer`; `TraceStep` gains `context`; `TraceToolCall` gains `snapshot`. Eight new public types (`TraceSubgoal`, `TraceRetrieval`, `TraceFeedback`, `ReplayArtifact`, `ReplayCallOutcome`, `ReplayStepReport`, `ReplayReport`, `ReplayRequest`) join them.
- `evolution-trace` gains four type-only workspace dependencies (`dsh-agent-context`, `dsh-agent-kernel`, `dsh-command-feedback`, `dsh-tool-todo`) and four project references. Nothing new loads at runtime; the package still opens no domain, calls no model, and writes nothing.
- A deployment that does not mount `dsh-agent-context`, `dsh-agent-kernel`, `dsh-tool-todo` or `dsh-command-feedback` simply records none of those events, so the corresponding fields project empty. Nothing errors.
- The four catalogs that enumerate services, config fields, module edges and types each gained rows for this package's new exports; they are regenerated as part of the batch, not by hand.

## Deviations from the plan

The plan named seven of §3.1's items as the projection work. Two of the thirteen rows in the README's table are not sourceable from the session log and are reported as such rather than implemented: `intermediate decisions` (no logged decision event exists, and the only candidate events live in an unmounted plugin) and `artifact versions used` (no logged artifact-version event exists at all). §51 item 1's "event bus" half is likewise left where the spec's priority map puts it — P1, with its consumers.

## Fixes found on the way

- **A span's record could be overwritten by a later record.** `openTurn` was never cleared, so a `todo/write` written after a turn ended rewrote that turn's subgoals; `openStep` likewise let a later `context/compiled` rewrite an earlier step's context. Caught by the new tests, fixed by closing both at `step/end` and `turn/end`, and covered by two tests that pin the binding to the span open at that instant.
- **A dead fallback in the failure text.** `message ?? pending.name` in the failure record could never take its right operand, because the failure path only runs for an error result and the error text already falls back to the tool name one line earlier. Replaced by resolving the failure text once, which also removed an uncovered branch the per-file 100% gate would have rejected.

## Testing

`packages/evolution/evolution-trace/tests/` — 55 tests across four files: `project.spec.ts` (the projection, including the new trajectory fields), `summarize.spec.ts`, `replay.spec.ts` (the counterfactual comparison), and `trace.spec.ts` (the service read paths). The behaviour the change is judged on:

- a fixture-recorded trace projects the new fields: a context digest bound to the step in force and carried forward, subgoal statuses from a todo snapshot and status-less steps from a kernel plan, retrieval targets read out of the recorded arguments with a failed retrieval kept, the last assistant text as the final answer, evaluations and human remarks in log order, and a clipped snapshot per call;
- replaying the same trace under two artifact revisions restores each revision's body over the retrieval it names, compares per step, names the steps the candidate changes, and names the step replayed from its snapshot;
- a call whose result the log recorded no text for makes its step `unreplayable` with the tool named, under both revisions, and never a silent parity — including when that call is the retrieval the artifact would otherwise have replaced;
- a compilation or plan record binds to the span open at that instant and never to one already closed.

`pnpm exec vitest run packages/evolution/evolution-trace packages/evolution/evolution-scorer` passes (109 tests, 12 files); per-file coverage on `packages/evolution/evolution-trace/src` is 100% statements, branches, functions and lines.

## Left alone

The replay reconstructs one trace's steps and reports where two artifact revisions differ; it never runs a model, so it cannot say whether the candidate's answer would have been better — only that a retrieved artifact's output changed and where. `evolution-scorer` is untouched: its corpus runner answers a different question (how a scenario scores over fresh processes) and keeps that job. The trace store remains read-only over the session log, and the restored artifact body lives only in the report, so a caller that wants artifact state in a live workspace owns that write.

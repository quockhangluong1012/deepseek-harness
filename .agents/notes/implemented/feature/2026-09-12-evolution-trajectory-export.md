# Agent Note: ShareGPT trajectory export

Status: implemented

English | [中文](2026-09-12-evolution-trajectory-export.zh.md)

## Problem

The outer loop had no way out of the harness. `specs/improvement.spec.md` Phase 5 asks for a trajectory exporter for evals and RL training, and the only export that existed was `session-log-export`: a browser ZIP download over `GET /api/session.export` that writes canonical JSONL through the host, with no ShareGPT shaping and no Host-path writer. A training pipeline needs a path it can read, and it needs conversations, not a session log.

## Decision

`@deepseek-ai/dsh-evolution-trajectory` adds `ctx.evolutionTrajectory`, a Typert Remote service over the `evolutionTrajectory` namespace with two verbs and one pure function:

- `exportSession(sessionId, { out? })` writes one file and reports `{ path, conversations, bytes }`.
- `exportScope(scopeId, { out? })` writes one file per non-archived Session of the scope's Workspace and reports the directory with the summed count and size.
- `toShareGpt({ sessionId, events })` is the pure shaper both verbs call, and it is exported from the package root so an in-process consumer can shape events it already holds.

Events come from a session-persistence read handle, after the Session is flushed when it is still live, so an export sees the turns that reached the model. `serializeSessionLog` and its JSONL parsing are deliberately not reused: an export is ShareGPT JSON, not a canonical session log, so the two writers share no artifact. The ShareGPT writer shapes raw committed events, not `sessionQuery.filterEvents` search documents, because a search document carries text and an event type only — the role and the message source that admission turns on are gone.

### What one export contains

Each file is a JSON array of conversations, one per turn that produced an admitted message, identified as `<sessionId>#<turn>`. `system/message` becomes `system`, a human `user/message` becomes `human`, `assistant/message` becomes `gpt`, and `tool/result` becomes `tool`. An assistant message keeps its text and renders each tool call as a `<tool_call>` tag holding the call name and the model's raw arguments JSON, so arguments the model emitted as unparseable JSON still survive verbatim. Reasoning blocks, images, and files contribute nothing.

Admission is the reviewer's rule, not a second policy: only a `user/message` whose `source.kind` is `user` passes, so injected context — file-change notices, subdirectory AGENTS.md, skill content, goal continuations — never becomes training data, and an empty rendering contributes no message.

### Destinations

`options.out` names a file for a Session export and a directory for a scope export. Without it, the configured `outDir` applies; without that, `$DSH_HOME` is read at export time and files land in `$DSH_HOME/evolution-trajectories`. Nothing is ever written inside a project directory, and a Session id is reduced to one path-safe file name before it shapes a path, because ids arrive from callers.

## Consequences

A finished Session or a whole Workspace scope becomes training data by path, with the injected context already excluded and no model turn spent. An unreadable or unknown Session is not a guess: an unknown Session rejects with `session/not-found`, an unknown scope with `workspace/not-found`, and any other storage failure propagates unchanged. A scope export fails soft where bulk export must — a rostered Session whose stored log is gone is skipped with a warning — while a Session with no admitted message exports an empty array rather than throwing, so a caller can tell "nothing to learn here" from "this failed".

The costs are deliberate. Text only: attachments and reasoning never reach a conversation. One conversation per turn: a consumer that wants one long conversation must join the file itself, and the system prompt repeats in every conversation. The profile-wide scope is not exportable, because it holds no Session roster to iterate.

The package ships without a CLI verb; `@deepseek-ai/dsh-command-evolution` owns `/trajectory` in the follow-up change, together with the composition row that mounts this plugin in the web-app bundle.

## Verification

`packages/evolution/evolution-trajectory/tests/sharegpt.spec.ts` pins the shaping against scripted session-log shapes: per-turn conversation split and role mapping, injected-context and empty-rendering exclusion, tool-call tagging with raw arguments, failing tool results, and the honest empty result for a log with no turn or no admitted message.

`packages/evolution/evolution-trajectory/tests/trajectory.spec.ts` pins the service through a real Cordis context with a scripted persistence backend and Workspace roster: the published namespace and its two Remote verbs, `resolveConfig`, a written file read back from disk with its reported byte size, the `$DSH_HOME` default and the configured `outDir`, path-safe file naming, `session/not-found` and `workspace/not-found`, the empty export, the live flush that brings the last turn into the file, one file per non-archived Session with summed totals, the skipped missing log, the empty scope, a scope key without a profile separator, and a non-absence storage failure that stays loud.

The package's own spec run reports 21 passing tests and 100% statements, branches, functions, and lines per file on `src`. A scoped `oxlint` run over the package reports no findings, and a scoped `tsc --noEmit` typecheck over `src` and `tests` reports none either.

## Alternatives considered

**Extend `session-log-export` with a ShareGPT mode.** The two writers share a service dependency (`sessionPersistence`) and nothing else: one streams a ZIP to a browser through the connection seam and serializes canonical JSONL, the other writes ShareGPT JSON to a host path for a caller. Putting both in one package would give the ZIP/fflate closure a permanent place in the evolution family and one package two unrelated output contracts. The trajectory exporter is its sibling instead.

**Depend on `session-log-export` for `flushLiveSessionLog`.** The flush-before-read rule is real, but it is two statements against `ctx.get('sessions')`, and importing it would pull the archive package (and `fflate`) into every deployment that only wants trajectory files. The rule is stated where it is used.

**Shape from `sessionQuery.filterEvents`.** The search seam is built for retrieval, and its documents carry `{ sessionId, seq, type, time, surface, text }`. Roles and the user-message source are precisely what admission needs and exactly what the projection drops, so shaping from it would either admit injected context as human speech or re-read the log underneath the seam.

**One conversation per Session.** The frozen `toShareGpt` returns conversations for one Session's events, and a Session is a sequence of turns. A single conversation would always report `conversations: 1`, would have to invent a boundary between the model's turns, and would bake the consumer's join policy into the export.

**Mark `toShareGpt` as a Remote endpoint.** The signature takes raw `SessionEvent[]`, a merge-extensible union of every event payload in the product. `session-controller` projects events onto `SessionWireEvent` precisely to keep that union off the wire, and no planned caller shapes remotely: the CLI and the scorer run in-process on the host. The method stays public on the service and undecorated.

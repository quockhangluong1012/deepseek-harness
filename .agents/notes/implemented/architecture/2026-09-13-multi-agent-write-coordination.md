# Agent Note: Multi-agent write coordination is already owned by three existing mechanisms

Status: implemented

English | [中文](2026-09-13-multi-agent-write-coordination.zh.md)

## Problem

The specification's multi-agent mechanism asks the harness to coordinate with other agents and avoid conflicts. Two agents can reach the same learned state at once — two sessions in one process, or two harness processes sharing a `$DSH_HOME` — and each may learn into the same scope, patch the same skill, or advance the same skill's lifecycle at the same moment.

Before adding a coordination layer it had to be established what already prevents a conflict, and where the remaining boundary actually is.

## Decision

No coordination layer is added. Three existing mechanisms cover concurrent writers within one process, and the cross-process boundary belongs to the storage backend a deployment chooses.

**Domain writes serialize.** Every write primitive is enqueued on its domain's write chain (`dsh-storage-domain`'s facility), so two writers to one record never interleave, and an `update` decides a record's existence at its own job's chain slot rather than at call time. The JSON backend relies on exactly this: `storage-json/src/single-unit.ts` states that writes are not queued there because "write ordering belongs to the caller (the domain layer's write chain)".

**Same-scope tool calls serialize.** `defineTool.parallelScopeKey(args)` groups calls that must not overlap: calls sharing a key never overlap while distinct keys still pack into the same parallel pool (`packages/core/tools/src/index.ts:1333-1336`). Mutating tools declare it, so two concurrent edits to one file or one skill are ordered rather than raced.

**Cross-process atomicity is the backend's decision.** `storage-json` publishes every changed file through write-temp, fsync, rename — an atomic replace on POSIX and Windows — so a reader never observes a torn file. Its README states the posture and the guidance in one sentence: it orders calls through the domain layer and is for inspectable files, and a deployment wanting highly concurrent data should choose SQLite. `storage-sqlite` runs WAL by default, so SQLite's own cross-process locking covers that case.

**Every learned write is recoverable.** Evolution writes are byte-capped, staged when configured, logged, and covered by the curator's snapshots, ledger, and rollback. A write that loses a race is therefore a lost update on one record, not silent corruption of the learning loop.

## Alternatives considered

**Add a lock file over `$DSH_HOME`.** A process-wide lock would make cross-process writes safe for every domain at once. It also changes the write contract for all of them — sessions, settings, credentials — to solve a problem only the evolution family raised, and the storage backend that owns publication is the wrong layer to bypass from a feature package. The backend's own documented answer is to choose SQLite when concurrency matters.

**Add a durable lease per evolution scope.** A lease would let one agent hold a scope while it learns, which is closer to what the specification describes. It introduces a new durable surface with its own crash-recovery question — a lease holder that dies must be detectable and its lease breakable — and the harness has no second observer that could adjudicate that safely. The cost lands well above the value for a P2 mechanism.

**Route every learned write through one hub agent.** A single owning agent would remove concurrent writers entirely. It also makes learning depend on that agent being alive and reachable, which is the opposite of the session-local design the family is built on: every scope learns from its own turns, in the process that already holds them.

## Consequences

The multi-agent requirement is satisfied for the case that occurs in practice — concurrent writers inside one harness process — and the remaining case is a documented deployment choice rather than an unexamined gap. A maintainer who wants stronger cross-process guarantees now has a named answer (the SQLite backend) instead of a new subsystem to design.

The cost is that the guarantee is not uniform: a deployment running several harness processes against one home on the JSON backend can lose an update on a single record, last writer wins. That is recorded where a deployment chooses a backend, not inside the evolution packages, because that is the layer that owns publication.

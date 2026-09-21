# Agent Note: Context compiler

Status: implemented

English | [中文](2026-09-20-agent-context-compiler.zh.md)

## Problem

The session log records what the model was sent, but nothing stated what a request had been compiled from. `core/system-prompt` assembles sections and runtime contexts, context packages contribute more of them, `compaction-basic` replaces transcript ranges, and the kernel derives task facts from the same log — yet no record named which of those contributions a step placed, which of them were droppable, or whether a replay would reproduce the placement.

A token ceiling had the same gap from the other side. Nothing distinguished the task's own authority — the permission that applies to it, its acceptance criteria, its plan, its unresolved failures — from guidance that a ceiling may safely drop, so any limit had to risk removing the very facts a run is accountable for.

## Decision

A new opt-in package, `packages/runtime/agent-context`, observes the assembly rather than producing one. It attaches to `system-prompt/assemble`, reads the assembly the waterfall finalized, and appends one log-only `context/compiled` record per assembly that names an agent. It owns no prompt contribution and no model request.

The compiler reads two source families. Every non-empty assembled section and runtime context becomes a `ContextSource` envelope whose kind, trust, and attribution come from a prefix table over the registered name, with an unlisted prefix resolving to untrusted repository content. The kernel's `KernelView` contributes the task's own facts as envelopes: the objective, one per acceptance criterion, one per constraint, the latest plan revision, one per unsettled action, and one per unresolved failure, all `trusted` and all `required`.

Retention follows the kind: `policy`, `task`, `plan`, and `evidence` sources are placed even when they alone exceed the ceiling, and `memory`, `artifact`, `history`, and `tool` sources are cut. The ceiling cuts a prefix of the placement order — a compressible source past the first one that does not fit is omitted with `reason: 'budget'` — and a compressible source whose content an already-placed source carries is omitted with `reason: 'duplicate'`. A placed source's `subject` makes two placed required sources that disagree into one reported `ContextConflict`; the compiler reports a disagreement and never resolves one.

Ordering is total — trust, kind, lexical relevance to the objective, then source id by code unit — so the same inputs place the same sources in the same order. The placement's digest is a SHA-256 over the compiler version, the ceiling, every placed source's identity, price, relevance and content hash, every omission, and every conflict, and it covers no clock and no generated id. `mode: 'shadow'` (the default) records the placement and returns the assembly unchanged; `mode: 'apply'` returns the assembly with every source the placement left out removed.

The durable record keeps identities, not text: the prompt text already lives on the `system/message` surface, so `ContextCompilationRecord` holds the digest, the compiler version, the ceiling, the token price, the placed source entries, the omissions, and the conflicts.

Required facts are re-derived per assembly rather than copied into a compaction checkpoint. The kernel view is already the durable fold over the log, so the task's objective, criteria, plan, and unresolved failures reach every request without the compiler holding state between steps; a compaction that shadows transcript ranges cannot remove facts that were never in the transcript.

## Alternatives considered

**Copy required facts into a `CompactionCheckpoint`.** Rejected: the specification's sketch predates the kernel's fold. A second copy inside the compaction record would need its own retention and staleness rules, could disagree with the view it was copied from, and would be the copy that goes missing when a summarizer truncates its output. Reading the fold on each assembly has one authority.

**Emit `messages` in the compiled context.** Rejected: `deriveMessages()` is the model-history projection and the loop renders the request from the assembly. A second projection would be a competing model history, and the compiler's job is provenance over the assembly, not a request of its own.

**Rebuild prompt order inside the compiler.** Rejected: `core/system-prompt` owns contribution registration, layer shadowing, ordering, and rendering. A compiler that reordered sections would become a second assembler, and every prompt contributor would have to decide which one to register with.

**Key sources by generated ids.** Rejected: the registered contribution name is what `apply` mode must map a placement back to, and what a reader can resolve against the assembly. Names are therefore asserted unique within a compile, and a section and a runtime context sharing one name rejects that assembly instead of silently placing one of them.

**Rank by embedding similarity.** Rejected for now: the compiler is pure, deterministic, and free of I/O, and a mounted embedding call would make a placement depend on provider state. Lexical overlap with the objective is reproducible offline; a similarity stage belongs behind a caller that supplies vectors.

**Apply the ceiling by default.** Rejected: a ceiling that has never run against real traffic cuts the wrong sources. Shadow is the default, matching the kernel's own shadow-before-enforce rule.

## Consequences

A deployment that mounts the compiler can answer, from the log, what a step was compiled from, and can prove that a replay of the same sources produces the same digest. The ceiling it offers can never drop the task's authority, which is the property that makes a limit safe to configure at all. The record costs no prompt tokens: it is log-only and never enters model context.

The costs are the ones recorded in the package README, and the plan envelope the compiler projects has no producer yet: `task/plan` is declared and folded by the kernel, but nothing appends it. Nothing mounts it and nothing reads `context/compiled` yet, so a deployment must read the log itself. Relevance is lexical, so a source that answers the objective in different words scores zero. Contribution names must be unique across sections and runtime contexts, and a collision rejects the assembly rather than choosing a winner. Retention and trust are fixed by the prefix and kind tables, not configurable, so a contribution that reads like guidance is still compressible when its family says so.

## Testing

`packages/runtime/agent-context/tests` pins the behavior: the classification and retention tables, the total order including every tie-break, the required-first prefix cut and the duplicate rule, the digest's determinism and its exclusion of generated identity, the assembly and kernel-view source projections, the service's recording per assembly, its behavior with no kernel mounted and after unload, shadow and apply modes over sections and runtime contexts, a replay reproducing one digest, and a real-Loader composition booting `cordis.yml` that proves `mode` and the ceiling are configuration rather than constants.

The generated catalogs carry the rest: the [persistence catalog](../../../../docs/persistence-catalog.md) and `KNOWN_SESSION_EVENT_TYPES` register `context/compiled`, the [configuration catalog](../../../../docs/config-catalog.md#deepseek-aidsh-agent-context) records the schema, and the [capability seams page](../../../../docs/capability-seams.md) records that nothing consumes the service yet.

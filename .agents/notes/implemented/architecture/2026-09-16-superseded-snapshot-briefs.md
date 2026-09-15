# Agent Note: Superseded snapshot briefs leave the surface

Status: implemented

English | [中文](2026-09-16-superseded-snapshot-briefs.zh.md)

## Problem

The v6 review (`docs/superpowers/specs/2026-09-13-evolutionary-harness-review-v6.md`) batch 2 asked the evolution-memory brief to stop accumulating, and its own composition test recorded the defect in a comment: "The change appends a complete replacement; the superseded brief stays in the surface, so the request carries both frames." Every memory write that changed a scope's digest injected another brief, and the model kept reading the old instructions beside the new ones — stale `# Workspace memory` rules, an outdated profile, a superseded usage number — because the loop committed each pre-step message with `surfaceOp: 'append'` and nothing ever withdrew an earlier one.

## Decision

A pre-step message whose source declares `form: 'snapshot'` **and** `supersedes` replaces its producer's previous snapshot on the surface.

- **The producer is the slot** (`src/snapshot-injections.ts`): plugin sources key by `plugin`, other source kinds by `kind`, so a newer brief supersedes the older one even when its sections, digest, or scope changed — the older brief in a moved session is exactly the stale one.
- **The loop appends the replacement, not a rewrite**: `SnapshotInjectionProjection` hands `agent.ts` a `{ surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [previous] }` intent for the slots it restored, and an append intent for everything else. The log keeps every injection, so a transcript, a replay, and the durable record are unchanged; only `deriveMessages()` and the requests built from it fold this way.
- **The projection restores from the log** (`restoreSnapshotSlots`): the newest live snapshot per slot, skipping one a later replacement shadowed, so a resumed session supersedes the brief the previous process injected. A landed replacement that shadows a retained node clears its slot, and the producer's next snapshot appends into an empty slot.
- **It is opt-in.** A source that does not declare `supersedes` keeps appending. `time-context` and `tmux-context` rely on that: their later reading measures elapsed time against the earlier one, so both must stay in the model's history. The loop-owned runtime-context snapshot also keeps appending — `RuntimeContextProjection` already owns its replacement, and superseding it a second time opened a request series the loop did not ask for (observed while building this change, which is why the rule became a producer declaration rather than a property of the form).
- `ContextFormed`'s snapshot variant gains the optional `supersedes?: true` member (`packages/llm/llm/src/message.ts`) with the contract stated where the form is declared: a state message supersedes, a timeline entry accumulates.

## Alternatives considered

- **Treat every `form: 'snapshot'` message as superseding.** Rejected after it broke the time-context timeline: the later reading's "elapsed since the preceding step context" line refers to the earlier reading, and the test that pins accumulation failed for a real reason, not a stale expectation. The form names how a message presents itself, not whether its producer is stating a state.
- **Fold the rule into `packages/core/session`'s surface instead of the loop.** Attractive — a fold rule would not bump `replaceGeneration`, so a supersede would not open a request series — but the fold would then also supersede the loop-owned runtime-context snapshot, whose projection replaces it explicitly; that combination throws `surface replace: start seq not found in surface`. Making the loop the owner keeps one replacement path per snapshot.
- **Let the memory plugin rewrite the previous event.** Rejected: the log is append-only and model-visible content must stay reconstructable from it. Replacing the node on the surface keeps both properties.
- **Add a `supersedes`-style flag per plugin in the loop, keyed by plugin name.** Rejected as coupling: the declaration belongs to the producer's own source shape, where the plugin already states what its message is.

## Consequences

A scope's memory brief now reaches the model once, whichever digest it carries; the model no longer reads superseded instructions beside current ones. Time and tmux readings accumulate exactly as before. Three costs are stated in the package READMEs: a superseded brief stays a durable log record (a transcript still shows it), a session that accumulated duplicates before its brief declared `supersedes` keeps them until compaction shadows them, and a replacement moves the surface generation, so the attempt that carries it logs a fresh `request/header` (reason `series`) — the prompt text itself is unchanged, so no additional system message is committed.

Verification: 8 loop tests (supersede with the log intact and the surface carrying one frame, restore across an attach, a landed replacement clearing the slot, a second producer untouched, an accumulating snapshot that declares nothing, and the slot/restore unit cases) and the updated `evolution-memory-context` composition test asserting the request carries one brief — the superseded frame stays in the log and never reaches the model. `packages/core/agent-loop/src/snapshot-injections.ts` is at 100% statements, branches, functions, and lines; the `time-context`, `tmux-context`, and `agent-loop` suites pass, and no snapshot fixture or SDK expected output changes because no recorded fixture injects a superseding brief.

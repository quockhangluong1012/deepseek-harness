# Agent Note: Evolution Memory Store — Lessons / Profile / Staged Writes

Status: implemented

English | [中文](2026-09-11-evolution-memory-store.zh.md)

## Problem

The harness learned nothing between turns: user corrections evaporated at `turn/end`, background review had nowhere to park proposals, and the [Evolutionary Harness subsystem](../../../../docs/subsystems/evolutionary-harness.md) needed a durable foundation before the reviewer, injector, curator, and safety rails could land. Reusing the workspace-memory record was wrong: evolution scopes cut across profiles and workspaces with a two-tier lessons/profile document and approval-gated writes, while workspace memory stays one document per directory with direct writes.

## Decision

Ship `@deepseek-ai/dsh-evolution-memory` in a new `evolution/` group behind `ctx.evolutionMemory`, mirroring the [workspace-memory decision](2026-09-10-workspace-memory.md) where the mechanics match and diverging where the spec demands it. One record per `EvolutionScopeId` (`profile:workspaceId` or `profile:global`) on the `evolution_memory` domain (`per-record`, version 1, fail-loud on corrupt records): user-authored instructions, model-maintained `agentLessons` and `userProfile` with `memoryUpdatedAt`, newest-last context items, newest-first outputs capped by `maxOutputs`, `lastExtraction` provenance with a `foreground | background_review | user-edit | rebuild` origin, and an oldest-first `staged` queue. Reads are synchronous from validated memory; `capacityBytes` is required and every other cap is a validated `Config` field (`maxAgentBytes` 65536, `maxUserBytes` 32768, `maxContextItemBytes` 262144, `maxContextItems` 50, `maxOutputs` 200). Capacity charges instructions plus lessons plus profile plus item sizes; outputs and staged writes are excluded, and the digest covers only the four charged inputs. Incremental lesson edits take a substring expected exactly once: unknown rejects with `evolution/item-not-found`, ambiguous with `evolution/ambiguous-match` carrying up to five excerpts, exact-duplicate adds resolve without writing. `stageWrite` parks memory or skill proposals outside capacity; `approveStaged` applies a memory op first (a cap or substring rejection keeps the entry staged) and only drops a skill entry, while `rejectStaged` drops either; concurrent approvals settle exactly once through the domain write chain. `GenerateOptions.purpose` gains `'evolution-review'` beside `'workspace-memory'`, with thinking disabled in `dsh-llm-deepseek` because extraction is a deterministic derivation where reasoning tokens buy nothing. The `evolutionary-harness` subsystem page, the Cordis catalog row, the config and persistence catalog entries, and the `evolution/` group map ship in the same change; no composition row is added, so every profile behaves byte-identically until the reviewer slice mounts the store.

## Alternatives considered

- **Placing the store in the `workspace/` group.** Rejected: the spec names `evolution/` first, scopes are not workspaces, and the reviewer, curator, and budgets packages need a home that is not per-directory memory; the group map links the neighbouring workspace subsystem instead.
- **Reusing the `workspace_memory` domain.** Rejected: the record shapes differ (two tiers plus staged queue), digests cover different fields, and one corrupt evolution record must never block workspace memory opens; a second domain keeps the failure and capacity boundaries separate.
- **A per-field cap on instructions.** Rejected: the spec bounds instructions by scope capacity only, and instructions are user-authored rules rather than model-written growth; adding a second ceiling would reject deployments the spec accepts.
- **Per-entry lesson provenance and history.** Rejected for v1, as with workspace memory: one capped document per tier stays directly editable, and the substring edit ops are the only touch points for a future array form.
- **A separate domain for staged writes.** Rejected: staged entries belong to the scope they will mutate, approval needs the record and the entry in one write chain, and staged payloads are excluded from capacity by construction rather than by a second store.
- **Sharing implementation with `dsh-workspace-memory` by import.** Rejected: the clone gate pins the two stores token-distinct, and the semantics genuinely differ (two tiers, substring edits, staged approval); a shared base would couple the new family to per-directory memory for no runtime saving.

## Consequences

Reviewer, injector, and curator work now has a durable, capped, rollback-capable write target with approval staging built in, at the cost of one more storage domain and a second memory-like vocabulary maintainers must not confuse with workspace memory. Staged writes are unbounded by design, so an unreviewed backlog grows until approved or rejected. The store registers no prompt, tool, or session event, so model-visible behavior is unchanged.

## Testing

The 52-case store spec pins absent reads, scope-id validation, per-field and capacity caps rejecting without mutation, substring replace/remove ambiguity with bounded excerpts, duplicate-add idempotence, staged stage/approve/reject flows including malformed payloads and concurrent double approval, output idempotence and truncation, digest coverage excluding outputs and staged writes, and no-reference-leak reads over the real storage/domain stack, holding per-file 100% on statements, branches, functions, and lines. The `llm-deepseek` serialize spec pins thinking disabled for `purpose: 'evolution-review'`. Scoped lint, typecheck, Cordis/config/persistence catalog freshness, translation pairing, and the package constraint gates pass; the remaining tree-wide gate failures predate this change.

# Agent Note: Durable skill-body version registry

Status: implemented

English | [中文](2026-09-21-skill-body-version-registry.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "Versioned artifact registry" as P0 #8, and §34/§36 require artifact lineage for reproducible experiments. The harness had the tip of each skill's body chain — `revision`, `contentSha`, `parentRevisionSha` on the telemetry record — but no durable history: after an edit, the previous revision's identity existed only in the current record's `parentRevisionSha`, and nothing could answer "what versions of this skill existed, in order, and which replaced which" without re-reading files.

## Decision

Extend `dsh-evolution-skill-telemetry` — the existing owner of the revision chain — with a durable version registry in the same domain:

1. **A `versions` table** in `evolution_skill_usage`, keyed by `name\0revision`, holding `{ name, revision, contentSha, parentRevisionSha, at }`. The domain bumps to version 2 with `compatibleVersions: [1]`: the new table arrives empty, so v1 documents open unchanged (the same pattern `evolution-feedback` used when it added `reflections`).
2. **Every body change commits a row.** `markRevised` appends a version row after the record write succeeds, using the exact bytes it hashed. The same bytes again is a no-op for both the record and the registry; excluded sources (`bundled`/`hub*`) keep no rows, matching the existing exclusion.
3. **A query surface.** `versions(name)` lists a skill's committed revisions oldest first, as detached copies — lineage without re-reading files. `drop(name)` clears the registry with the record, so purging a skill forgets its whole history.
4. **An operator surface.** `/curator history <name>` renders the chain — `r2 <sha8> ← r1 <parent8> (at)` — next to the pin/unpin verbs that also read only telemetry.

## Alternatives considered

- A new `dsh-evolution-registry` package holding a generic artifact registry with its own domain — rejected: skills are the only artifacts any loop writes today, the chain's owning store already exists, and a generic registry with one kind and zero consumers would be speculative state with no current need.
- Store full body text in the version rows — rejected: bodies are already content-addressed (`contentSha`), and the curator keeps body preimages in its `blobs/<sha>.md` store; the registry records identity and lineage, not duplicates.
- Keep version rows inside the usage record (a per-record list) — rejected: the record is per-skill state that every pass clones; an unbounded in-record history would bloat the counters and complicate the schema. A separate table keeps the record shape stable.
- Reconstruct history from the curator ledger's `patch` rows — rejected: only consolidation patches reach that ledger; `skill_manage` writes and rollback restores never do, so the ledger is not a complete registry.

## Consequences

- The skill artifact registry is durable and queryable: every committed body has an ordered lineage row with its parent hash and recording instant, so an experiment can reconstruct which artifact versions were in effect.
- Every `markRevised` caller — `skill_manage` create/patch/edit, curator patch commits, and body rollback restores — records history automatically; there is one commit point for body changes.
- The domain opens old v1 stores unchanged (`compatibleVersions: [1]`); only new history writes touch the new table.
- `drop` keeps purge consistent: a purged skill leaves no orphaned history rows.

## Deviations from the plan

None beyond routine: the version-table accessor and path constants were adjusted while landing (field renamed to avoid colliding with the public `versions` method), and the `/curator` usage string gained `history <name>`.

## Fixes found on the way

None: the pre-existing `command-evolution` usage-string assertions were updated for the new verb in the same change.

## Testing

The registry ladder in `telemetry.spec.ts`: one version row per committed revision with correct parent hashes and instants, no row for unchanged content, detached reads, excluded sources keep no rows, `drop` clears history while a sibling skill's history survives the prefix sweep, and reads throw before the store starts. The `/curator history` command: rendering with lineage, the no-revisions message, usage errors, and the unmounted-store error. 37 telemetry tests and 135 command tests pass; telemetry is at 100% statements/branches/functions/lines.

## Left alone

The registry records identity and lineage; it does not store bodies (the curator preimage store remains the content archive) and it is not yet read by an experiment runner — the P1 evaluation/benchmark work owns that consumer.
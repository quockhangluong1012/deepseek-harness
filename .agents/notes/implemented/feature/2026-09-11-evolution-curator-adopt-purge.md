# Agent Note: Evolution Curator Adoption and Purge

Status: implemented

English | [中文](2026-09-11-evolution-curator-adopt-purge.zh.md)

## Problem

Two curator rows stayed manual in the worst sense — impossible rather than handy. Agent-created skills carried their provenance forever with no human claim path, so adoption lived outside the system; and archived skills accumulated without bound because nothing could remove them, making `archiveTtlDays` a documented field with no implementation. Both are clock- or hand-driven, need no model, and fit the safety slice's ledger discipline.

## Decision

Extend the curator service with `adopt` and `purge`, backed by two telemetry writes. `markAdopted` moves one agent-created record to user-directed provenance without resetting clocks, rejecting missing records and anything without background-review authorship; `drop` forgets one record, reporting whether one existed. Curator `adopt` records one operator ledger entry with before/after blobs and is one-way by construction. Curator `purge` removes archived skills past `archiveTtlDays` (default zero never purges): directory first, then record, then one operator ledger entry per skill, with pinned skills skipped, unstamped records kept by NaN-safe comparison, unresolvable directories purged record-only, and `dryRun` previews without writing. New `Config.archiveTtlDays` follows the specification table; the schema minimum is zero, not one, because zero is the specified off state.

## Alternatives considered

- **Full-record restore points for adoption.** Rejected: adoption changes one field, and the ledger's before/after blobs already capture both sides. No snapshot is warranted for a single-field claim.
- **Purging pinned archived skills.** Rejected: pins protect curated skills from destructive curation. Pinned archivals count as skipped and stay until unpinned; the report names the count.
- **Treating unstamped archivals as infinitely old.** Rejected as unsafe: purging on sight inverts the fail-safe direction. A missing stamp parses to NaN, which never exceeds the TTL, so corrupt records accumulate visibly instead of vanishing.
- **Refusing record-only purges for missing directories.** Rejected: the record already changed state and needs its end of life recorded. Missing directories resolve to `undefined` and join the report with a null dir.

## Consequences

The curator now owns the full non-LLM lifecycle: automatic transitions, previews, snapshots, rollback, adoption, and retention. Archived accumulation ends where a TTL is configured; elsewhere the zero default preserves the old behavior byte for byte. Adoption gives background umbrellas a human claim path without touching their clocks or counters. Rollback covers transitions only — adopted and purged skills stay as the operator left them.

## Testing

Telemetry gains adoption (missing, already-adopted, and user-directed rejections plus clock stability) and drop (true/false) specs. Curator gains adoption through the ledger with store-absent refusal, TTL purge with directory removal, pin skipping, record-only purges, and purge ledger entries, young-skill retention with dry-run previews, and zero-TTL plus store-absent emptiness. Per-file 100% holds on statements, branches, functions, and lines.

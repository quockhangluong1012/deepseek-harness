# Agent Note: Evolution Curator Safety — Snapshots, Ledger, and Fail-Closed Rollback

Status: implemented

English | [中文](2026-09-11-evolution-curator-safety.zh.md)

## Problem

Automatic passes mutated lifecycle states with no way back: a wrong threshold or a misfiring schedule could archive skills silently, and dry-run previews showed movements without any durable evidence of what landed. The specification answers with per-pass tarball backups, an append-only JSONL ledger with content-addressed blobs, and whole-run plus single-entry rollback — all without model involvement, so the safety slice is shippable ahead of consolidation.

## Decision

Extend `@deepseek-ai/dsh-evolution-curator` with `src/safety.ts` behind three service methods. A real pass with movements writes one tarball (`snapshots/pass-<timestamp>-<id>.tar.gz`, pruned to `backup.keep`) staging before/after record pairs, resolvable skill directories, and a manifest, then appends one `pass` entry plus one `transition` entry per movement to the append-only JSONL ledger, with record blobs stored content-addressed. `rollbackPass` and `rollbackEntry` restore lifecycle states only — never files — after verifying every record and blob up front, snapshotting current records first so each rollback stays reversible, and recording one `rollback` entry per skill. Unknown ids, missing blobs, untracked skills, and a missing store all fail before any write. Unresolvable directories land in pass evidence instead of failing. The `tar` npm package backs snapshots: a maintained dependency that deletes an owned archive format with its tests.

## Alternatives considered

- **Hand-rolled tar over `node:zlib`.** Rejected under the dependencies-over-hand-rolling rule: the maintained `tar` package (already in the install closure, ESM, no install scripts) deletes roughly a hundred lines of owned format code and its tests.
- **Rollback restoring skill directories from the tarball.** Rejected: transitions never touch files, so restoring directories would clobber later user edits. Tarballs stay audit evidence until the filesystem pass moves directories; rollback re-applies states through `setState`, which restamps `archivedAt` on re-entry by its own invariant.
- **Full-record restore through a new telemetry write.** Rejected: blobs may predate newer use/view counters, so a full restore would clobber newer observations. State-only restoration leaves counters and pins untouched.
- **Skipping snapshots for passes with unresolvable directories.** Rejected: records still changed and need evidence. Missing directories resolve to `undefined` and join the pass evidence; the tarball keeps records and manifest.
- **Clock and home overrides as config.** Rejected: the clock already arrives per call, and the harness home resolves through `$DSH_HOME`, which tests redirect per worker. No test hook, no machine-specific default baked into the schema.

## Consequences

Every real pass is now reversible and auditable: status surfaces list passes with snapshots and transition counts, operators roll back whole passes or single entries, and each rollback's own before/after blobs keep the chain walkable. `dryRun`, empty, and backup-disabled passes write nothing. Ledger corruption fails loudly on read instead of rolling back the wrong skill.

## Testing

Eleven safety specs pin directory resolution, hashing, snapshot contents with unresolved names, keep-N pruning, ledger round-trip with malformed-line failure, real-pass snapshots with tarball contents and pass listing, whole-pass and single-entry rollback with restamping, fail-closed unknown ids/missing blobs/untracked skills/corrupt evidence, store-absent refusal, and fresh-home reads — plus eleven carried-over transition specs. Per-file 100% holds on statements, branches, functions, and lines.

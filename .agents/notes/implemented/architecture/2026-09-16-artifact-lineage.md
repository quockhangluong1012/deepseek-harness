# Agent Note: Artifact lineage and causal attribution

Status: implemented

English | [中文](2026-09-16-artifact-lineage.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §36 asks that when performance improves, the record say which change caused it: candidate, parents, mutation operator, changed components, benchmark delta. The ledger already carried four of the five — the winner's digest (candidate), the starting body's digest (parent), the producing operator, and the baseline-vs-winner triple pair (delta) — but nothing said what the edit itself touched. A `+40/-2` rewrite and a `+1/-1` rule tweak staged side by side, and no future reader could tell which kind of change the promotion rewarded.

## Decision

**Two ledger numbers plus one rendered suffix, no stored bodies, no delta duplication.**

- **`diffLineCounts` is pure** (`evolution-optimizer/src/lineage.ts`): added and removed lines between the starting body and the winner, as both bodies minus their longest common subsequence. Order-sensitive by design — a pure reorder counts as change — because lineage asks what moved, while novelty asks what is new material; the two measures answer different questions on purpose. Memoized recursion keeps it quadratic, fine for SKILL.md bodies. Bodies stay out of the ledger by the standing decision; the counts say how big the edit was, the digests say which texts.
- **Recorded at write time from bodies already in memory** (`record()` spreads the counts onto the row): no draft change, no extra I/O, zero for non-promoting runs. New required schema fields fail old rows loudly at domain open, the same precedent as the scorer-version batch — a measurement from an unknown lineage is not reinterpretable.
- **Rendered as `+added/-removed` on promoting rows** of `/curator experiments`, hidden on rows with no change. The guard reads `> 0` rather than truthiness, so ledger rows predating the field (and test doubles omitting it) render as before instead of printing `undefined`.
- **Benchmark delta is deliberately not stored.** Winner triple minus baseline triple is subtraction the reader can do; duplicating it onto the row would add a third number that can disagree with the two it came from. Parents stay singular (`bodySha`): this optimizer has no merge operator, so every candidate has exactly one parent by construction.

## Alternatives considered

- **Storing the unified diff.** Rejected: a diff reconstructs body content, which would undo the deliberate "bodies themselves are not stored" decision through the back door. Counts plus digests preserve the privacy shape.
- **Multiset (order-insensitive) difference.** Rejected while writing the helper: a pure reorder would report `0/0`, which misdescribes the artifact. It also shares the novelty helper's normalization, blurring two measures that must stay distinct.
- **Isolated-ablation runs (A-only/B-only/A+B).** Not built: each candidate already is one operator's isolated variant, and the winner pick measures every survivor against the same re-scored baseline — the single-change discipline §36 wants, by construction rather than by extra runs.
- **Crediting the operator for the win.** Already exists (`winnerOperator` stages the promotion, the failure surface counts the win); the counts add the missing axis — how big the winning edit was — not a second credit ledger.

## Consequences

The §36 record is complete with no new state: candidate, parent, operator, changed-component counts, and the triple pair are all on the row, and `/curator experiments` surfaces the size of each promotion to the human deciding on it. What the counts cannot say — which rule changed, whether the change was the cause — stays honestly unsaid: attribution beyond size still belongs to the operator record and the benchmark delta, not to two integers.

## Verification

- 107 tests pass in `evolution-optimizer` (5 unit for the diff, 1 orchestration asserting recorded counts on a regressed row); per-file 100% statements, branches, functions, and lines. `command-evolution` renderer covered both ways (staged row with counts, field-less rows unchanged); its 12 uncovered statements predate this batch identically (verified by stash baseline).
- `tsc -b` on both packages clean; oxlint 0 errors on touched lines (24 pre-existing in `command-evolution`, none mine).

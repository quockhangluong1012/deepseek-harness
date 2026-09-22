# Agent Note: Novelty search archive

Status: implemented

English | [中文](2026-09-21-novelty-search-archive.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "novelty search" as P2 #22 and §31 defines it: reward candidates for being meaningfully different, not only high-scoring, because without diversity pressure the harness converges on the first "pretty good" skill and stops discovering alternatives. The optimizer already computes a per-baseline novelty (`noveltyOf`: the share of a candidate's instruction lines the starting body does not carry) and blends novelty into survivor selection, but nothing durable remembered what the skill had already seen, so "different" could only be measured against the single reference body of one run, never against the skill's whole history.

## Decision

One new package, `dsh-evolution-novelty-search`, holding a durable per-skill archive of behavior descriptors:

1. **One archive entry per staged write.** The optimizer records the winner's behavior descriptor through the optional store seam right after `stageWrite`: the entry id is the staged write id, and the descriptor is the winner's distinct normalized instruction lines (`descriptorOf`, exported from the optimizer's novelty module). A failing record logs a warning and never fails the optimization.
2. **Archive novelty is Jaccard-based and pure.** `similarity` is Jaccard similarity between feature sets (zero for two empty sets); `archiveNovelty` is one minus the maximum similarity of a descriptor to any archived entry — zero for a descriptor with no features, one for the seed entry of an empty archive. `record` measures against the skill's archive excluding the entry itself, so re-recording a candidate keeps its original novelty instead of decaying to zero.
3. **The archive is the history signal.** `mean(skill)` reports the skill's mean archive novelty; a falling mean is the frontier-stagnation signal §31 calls out. Selection-side blending of fitness and novelty stays where it already lives — the optimizer's survivor selection; this package owns the durable archive, not the blend.
4. **One durable domain, one command surface.** The `evolution_novelty` domain (v1) holds one `archive` table keyed by candidate id. `/novelty` summarizes the archive across skills with per-skill means, or lists one skill's entries with their novelty. The package is mounted in the web-app profile (it writes only its own domain and reaches no model prompt).

## Alternatives considered

- Store descriptors inside the optimizer's experiment ledger — rejected: the ledger records per-run outcomes; the archive is a per-candidate history across runs, and the optimizer package already owns its staged-write governance to other stores.
- Reuse the optimizer's per-baseline novelty as the recorded value — rejected: that metric is one-run relative; the archive needs a metric against everything the skill has seen, which is a different, durable signal.
- Embedding-based similarity — rejected: the harness has no embedding dependency in the evolution family, and Jaccard over normalized instruction lines is deterministic and testable without a model call.

## Consequences

- Novelty is now measurable across runs: `/novelty writer` shows how different each staged write was from everything the skill had seen, and the mean reports novelty pressure per skill.
- The archive is queryable: future novelty-guided selection (e.g. stagnation recovery) can read `entries(skill)` and rank candidates by archive novelty (documented as deferred in the package's Known Limitations).
- The optimizer stays decoupled: recording is optional and failure-isolated, and `descriptorOf` is the only new optimizer surface.

## Deviations from the plan

None beyond routine. The archive excludes the entry itself when measuring so identical re-records of the same staged write stay idempotent; the initial test draft asserted the raw Jaccard value instead of one minus it and was corrected as the measurement semantics were pinned.

## Fixes found on the way

None beyond the test-math correction above.

## Testing

Novelty helpers: Jaccard similarity across empty/disjoint/overlapping sets, archive novelty for seed/empty-feature/max-similarity cases, mean over empty and non-empty archives. Store: seed recording with full novelty, exclusion on re-record, overlapping and verbatim descriptors, skill isolation, listing order/filter/detached copies, mean queries, restart persistence through the zod spec, reads-before-start. Optimizer side: `descriptorOf` normalization, frontmatter dropping, blank bodies, missing-frontmatter bodies; the staged winner is recorded into a mounted archive, staging is unchanged when unmounted, and a failing store logs a warning. `/novelty`: unmounted, grammar usage, archive summary across skills, per-skill listing, empty-archive honesty. 14 novelty-search tests, 3 new optimizer tests, and 4 new command tests pass; the new package is at 100% statements/branches/functions/lines, and the optimizer stays at 100%.

## Left alone

Descriptors are supplied, not derived in the package: the optimizer extracts feature lines from the winner's body before recording (documented in the package's Known Limitations). The archive grows without a size cap; a bounded archive needs a retention policy on the domain. No blending lives here — combining fitness and novelty remains selection-side behavior in the optimizer's survivor selection.

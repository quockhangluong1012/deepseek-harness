# Agent Note: Evolution CLI Governance — /memory and /refine Commands

Status: implemented

English | [中文](2026-09-11-command-evolution.zh.md)

## Problem

The evolution store could stage writes but nothing could govern them: `stageWrite` parked memory and skill proposals with no surface able to list, approve, or reject them, and the reviewer's `rebuild` had no on-demand entry point. The improvement roadmap assigns governance to the CLI until the Web journey lands, with no new domain and no new session event.

## Decision

Ship `@deepseek-ai/dsh-command-evolution` in the `evolution/` group as a function plugin (`name` / `inject` / `Config` / `apply`, no default export) registering `/memory` and `/refine` on `ctx.commands`. `/memory pending` lists the invoking session's scope entries as stable single lines (honestly empty when none await); `/memory approve <id>` applies memory-kind entries through the store's own write chain so cap and substring rejections keep the entry staged; `/memory reject <id>` drops either kind; `/refine` forwards scope plus signal to `evolutionReviewer.rebuild`. Scope resolves the injector way — registry session ids, then canonical-`cwd` fallback — under a required `profile`, with the same empty/`:` rejection at load. The reviewer stays optional through `ctx.get`: `/refine` without it reports that it is not mounted. Expected Remote failures map to stable command text (`No staged write`, `Cannot <verb> (<code>)`, `Memory rebuild failed (<code>)`); plain errors propagate. Teardown unregisters both commands before draining in-flight handlers, copying the `/compact` LIFO pattern.

## Alternatives considered

- **Approving skill-kind entries by dropping them.** Rejected: the store drops skill entries on approve only because the approver performs the skill write first, and this command cannot perform skill writes yet. The command refuses with the `skill_manage` pointer and keeps the entry, so nothing is silently discarded; rejection stays available for dismissal.
- **Controller-first governance.** Rejected for this slice: the roadmap is CLI-first, and the controller needs the timeline read model that does not exist yet. Commands cover exactly the implemented store surface (staged writes plus rebuild) with no new domain or session event.
- **A shared membership helper with the injector.** Deferred until a third consumer needs it: the commands duplicate the injector's membership rule without its cache (one-shot invocations keep no state), recorded in the package Dev Note. Two copies with one noted owner beats a premature seam.
- **An early return for the unresolvable scope.** Rejected after the per-file coverage gate flagged it: a braceless (then braced) `if (canonical === undefined) return undefined` immediately after the awaited `realpath` reports its else path as never taken even though the fallback test provably executes it — a v8 branch-mapping quirk, not dead code. The ternary form maps correctly with identical behavior; do not refactor it back without re-running coverage.

## Consequences

Staged evolution writes are governable from any command adapter today: background proposals surface in `/memory pending`, memory entries land through `/memory approve`, and anything unwanted leaves through `/memory reject`. Skill proposals stay explicitly blocked on their skill write, which is honest about the missing approver half. `/refine` gives the rebuild path a human entry point without touching the reviewer's gating or provenance.

## Testing

Twenty-one specs pin registration with Loader-safe exports and dual disposal, profile rejection, the fixed `/memory` grammar including all usage rejections, scopeless sessions, direct and `cwd`-fallback resolution plus the unmatched-`cwd` miss, empty/single/multiple pending listings with lifecycle pairs, approve-apply with store state, unknown ids, reject-without-apply, skill refusal keeping the entry, cap rejection keeping the entry with its code, unexpected store failures propagating, the pure failure-text helper, `/refine` usage/scopeless/missing-reviewer/Remote-failure/cancelled/unexpected paths with exact signal forwarding, and in-flight drain before disposal settles. A Loader composition spec boots the real registry, store, and command plane through `cordis.yml` and drives pending → approve → refine end to end, including a stub reviewer write through the real store. Per-file 100% holds on statements, branches, functions, and lines.

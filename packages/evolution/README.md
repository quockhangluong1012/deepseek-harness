---
description: "The evolution group map: the self-learning harness family that learns from user behaviour, curates bounded memory, and improves skills during use."
kind: "package-group"
---

# packages/evolution

English | [中文](README.zh.md)

## Summary

The evolution family adds a closed learning loop on top of the harness without patching a privileged core: durable per-scope memory records with staged writes, background turn review, scheduled skill curation, and long-horizon safety rails. Every learned write is capped, logged, and rollback-capable; removing the rows restores byte-identical legacy behaviour. Choose this family when Sessions should get better the longer they are used. The behaviour contract lives in [the Evolutionary Harness specification](../../specs/evolutionary-harness.spec.md) until the dedicated subsystem reference lands.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`evolution-memory`](evolution-memory/README.md) | Provides the durable per-scope evolution memory record, lesson/profile writes, staged writes, and capacity accounting | `ctx.evolutionMemory` |
| [`evolution-reviewer`](evolution-reviewer/README.md) | Buffers turns, indexes produced files, extracts lessons on a gate, and rebuilds on demand | `ctx.evolutionReviewer` |
| [`evolution-curator`](evolution-curator/README.md) | Host-wide interval and idle maintenance: automatic skill lifecycle transitions, opt-in LLM consolidation under the full-package rule, backups, ledger, and rollback | `ctx.evolutionCurator` |
| [`evolution-controller`](evolution-controller/README.md) | Host Remote face over the memory record: scoped read and write verbs, staged-write decisions, the journey timeline, and a scope-filtered change stream | `ctx.evolutionController` |
| [`evolution-trajectory`](evolution-trajectory/README.md) | ShareGPT trajectory export for one Session or every Session of a scope, written on the Host path | `ctx.evolutionTrajectory` |
| [`evolution-scorer`](evolution-scorer/README.md) | Scores a recorded corpus run: workspace-diff pass, metered tokens, and median-of-N wall time | `ctx.evolutionScorer` |
| [`command-evolution`](command-evolution/README.md) | Human governance commands: staged memory and skill writes, the scope journey, curation status, on-demand rebuilds, trajectory export, learning turns, and blueprint suggestions | registers on `ctx.commands` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Evolutionary Harness specification](../../specs/evolutionary-harness.spec.md) — the behaviour contract this family implements.
- [Evolutionary Harness subsystem](../../docs/subsystems/evolutionary-harness.md) — the reference vocabulary and generated API for this family.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — the neighbouring per-directory memory design this family mirrors.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

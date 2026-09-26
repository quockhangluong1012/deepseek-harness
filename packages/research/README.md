---
description: "Package map for the research group: the package that runs the research quality-control loop over a session's kernel task and keeps each run's stage state durable, for deployments that need source-backed answers."
kind: "package-group"
---

# research/ — research quality-control family

English | [中文](README.zh.md)

## Summary

The `research/` group turns a session question into a source-backed answer instead of an unsupported one. `research-controller` runs an ordered quality-control loop: the model states the question, sub-questions, plan, claims, and answer through the `research_advance` tool, registered providers perform search, source triage, and contradiction search, and an epistemic review refuses any answer that does not state every recorded claim in one of six epistemic buckets. Each run's stage state stays durable per session, and observations and claims stay the agent kernel's records. A run starts only under a kernel task of class `research`; mounting the package alone changes nothing.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

`research-controller` runs the loop and registers its two model-facing tools; `case-store` persists the ICT case artifact and registers nothing model-facing. Both keep their records in storage the group does not own.

| Package | What it provides |
|---|---|
| [`research-controller/`](research-controller/README.md) | The ordered stage loop with durable per-stage state, the stage-provider seam for the stages a deployment performs, the six-bucket answer contract, and the `research_advance` and `research_state` tools |
| [`case-store/`](case-store/README.md) | The durable per-learner ICT case-study artifact of §21 — observations separated from interpretations, evidence referenced by kernel identity, and one read path for each of its four consumers |

-----

<a id="related-documentation"></a>
## Related documentation

- [Agent kernel subsystem reference](../../docs/subsystems/agent-kernel.md) — the task a run answers to, and the evidence and claim records the loop cites rather than copies.
- [Storage subsystem reference](../../docs/subsystems/storage.md) — the domain form that holds the `research` runs table.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

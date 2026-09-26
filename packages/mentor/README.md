---
description: "The mentor package group: the durable learner record, the catalogue-driven misconception engine, and the §20 mentor quality loop, for readers choosing or navigating the family."
kind: "package-group"
---

# mentor/ — the learner record, the misconception engine, and the mentor quality loop

English | [中文](README.zh.md)

## Summary

The mentor group turns a mentor session into a measured teaching cycle over one durable learner. `learner-model` keeps what that learner has shown, by talking about concepts and by applying them. `misconception` judges a stated thesis against the deployment's own pattern catalogue and drives each occurrence through explain, counterexample, exercise, new case, and reassess. `mentor-loop` derives the §20 stage from the session, the kernel, and those records, then injects the current stage's instruction into the mentor agent's next request. Detection is catalogue matching, never a model call.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The three packages are one cycle: the record is the learner state, the engine is the catalogue and the pipeline, and the loop is the §20 stage machine that keeps the mentor's next request aligned with that state.

| Package | Role | ctx key |
|---|---|---|
| [`learner-model`](learner-model/README.md) | One durable record per learner: concept knowledge, application ability, misconceptions, mistakes, confidence, case history, and objectives | `ctx.learnerModel` |
| [`misconception`](misconception/README.md) | Judges a stated thesis against the deployment's pattern catalogue and drives each occurrence through its five teaching stages over durable per-learner state | `ctx.misconception` |
| [`mentor-loop`](mentor-loop/README.md) | Derives the §20 mentor stage from the session, the kernel, and the two records above, and injects the current stage's directive into the mentor agent's next request | `ctx.mentorLoop` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Storage subsystem](../../docs/subsystems/storage.md) — the domain form the learner record and every misconception pipeline are stored through.
- [Agent kernel subsystem](../../docs/subsystems/agent-kernel.md) — the claims and evidence a finding cites, from the task contract the mentor's session answers to.
- [DeepSeek Harness 2.0 evolution spec](../../specs/deepseek-harness-2.0-evolution-spec.md) §20, §21, and §27 — the mentor quality-control loop, the case artifact that feeds the learner record, and the mentoring success criteria.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

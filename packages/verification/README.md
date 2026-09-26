---
description: "Package map for the verification family: the command-backed criterion verifiers that give the agent-kernel completion gate its pass, fail, and timeout evidence, for users and maintainers composing a verifiable task."
kind: "package-group"
---

# verification/ — acceptance-criterion verification family

English | [中文](README.zh.md)

## Summary

The `verification/` group answers the question the agent kernel refuses to answer by itself: did the task's acceptance criteria hold? The kernel owns the gate and the verifier registry but runs nothing, so a criterion no plugin claims stays unresolved. `command-verifiers` decides the families a command answers — one configured shell command per criterion id or family through `ctx.shell`, plus changed-scope checks for `diff`. `agent-verifiers` decides `security`, `browser`, and `review` with one independent reviewer subagent per criterion.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | What it provides |
|---|---|
| [`command-verifiers/`](command-verifiers/README.md) | Registers one criterion verifier that runs the shell command a deployment configured for a criterion id or verifier family, fails a criterion whose command overruns its declared timeout, and decides `diff` criteria from the scopes a task changed |
| [`agent-verifiers/`](agent-verifiers/README.md) | Registers one criterion verifier that decides the `security`, `browser`, and `review` families from one independent reviewer subagent per criterion, started through the reviewer helper the review commands share |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the gate these verifiers feed, then the executor that runs their commands and the configuration they accept.

- [Agent kernel subsystem reference](../../docs/subsystems/agent-kernel.md) — the task contract, the completion gate, and the `CriterionVerifier` registry that orders, times out, and disposes this group's contribution.
- [Shell subsystem reference](../../docs/subsystems/shell.md) — the executor seam every configured command runs through, including its deadline, output caps, and spill files.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-command-verifiers) — every accepted field of the verifier plugin.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "Package map for the guard family: the advisory repeat-tool reminder, the per-tool-call timeout policy, and the per-turn budget ceilings, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene and budget guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive and bounded. `repeat-tool-reminder` notices when the model repeats the exact same tool call and reminds it to change approach or finish. `timeout-policy` times out tool calls that declare a limit, so a hung call returns a clear error instead of stalling the session. `budgets` ends a runaway turn blocked once it reaches a configured ceiling. `prompt-injection` records what untrusted content tried to do and can replace credentials in the model-visible result. The first two ship in the `dsh` base bundle, `budgets` in the web-app bundle, and `prompt-injection` in none.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Four small plugins cover loop hygiene and long-horizon ceilings; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`budgets/`](budgets/README.md) | Bounds one turn with optional token-pressure, tool-call, and wall-clock ceilings, ending it blocked when one is reached |
| [`prompt-injection/`](prompt-injection/README.md) | Records what untrusted tool, repository, web, or MCP content tried to do, and replaces credentials in the model-visible result when configured to enforce |
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions both guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

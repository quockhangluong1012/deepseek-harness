---
description: "Package map for the runtime group: the agent kernel that owns one durable task contract per session, the action ledger over the tool pipeline, and the completion gate, for users and maintainers composing a governed runtime."
kind: "package-group"
---

# runtime/ — control-plane runtime family

English | [中文](README.zh.md)

## Summary

The `runtime/` group holds packages that govern what the existing execution substrate does without owning any of it. `agent-kernel` derives one durable task contract per session from the session log, records a proposal and decision for every tool call, composes the deployment's permission document with the technical sandbox and the human approval answerers, and decides completion only when the task's required acceptance criteria pass. It mounts nothing by default and ships in no profile yet, so a deployment opts in per composition.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package covers the control plane. Its README explains when to mount it, how to read the records it writes, and what it deliberately does not own.

| Package | What it provides |
|---|---|
| [`agent-kernel/`](agent-kernel/README.md) | One durable task contract per session, an action ledger over the tool pipeline, a capability permission engine composed with the sandbox and the approval answerers, and a completion gate |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the agent-kernel subsystem reference for the vocabulary and the generated Cordis API, then the seams the kernel observes rather than replaces.

- [Agent kernel subsystem reference](../../docs/subsystems/agent-kernel.md) — task contracts, the action ledger, the permission document, the completion gate, and the durable event families.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the waterfalls the ledger is built on, and the decisions the kernel returns to them.
- [Architecture map](../../docs/architecture.md) — the ownership table the kernel is forbidden to duplicate.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

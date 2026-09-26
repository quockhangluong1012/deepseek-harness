---
description: "Package map for the runtime group: the agent kernel that owns one durable task contract per session, the action ledger over the tool pipeline, and the completion gate, for users and maintainers composing a governed runtime."
kind: "package-group"
---

# runtime/ — control-plane runtime family

English | [中文](README.zh.md)

## Summary

The `runtime/` group holds packages that govern what the existing execution substrate does without owning any of it. `agent-kernel` derives one durable task contract per session, records a proposal and decision for every tool call, composes the permission document with the sandbox and the approval answerers, and gates completion on the required acceptance criteria. `agent-context` wraps every assembled prompt contribution and durable task fact in a source envelope, records each step's placement digest, drops compressible sources past a token ceiling, and withholds a configured tier until a caller admits it. None mounts by default.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three packages cover the control plane, the context it compiles, and the tools it governs. Their READMEs explain when to mount them, how to read the records they write, and what they deliberately do not own.

| Package | What it provides |
|---|---|
| [`agent-kernel/`](agent-kernel/README.md) | One durable task contract per session, an action ledger over the tool pipeline, a capability permission engine composed with the sandbox and the approval answerers, delegation receipts intersected into every child action, and a completion gate |
| [`agent-kernel-builtins/`](agent-kernel-builtins/README.md) | One capability declaration per shipped product tool, registered with the kernel in any mount order so enforce mode governs real traffic |
| [`agent-context/`](agent-context/README.md) | Source envelopes over the assembled prompt contributions and the durable task facts, a total placement order, conflict reports, token-budget fitting, and a replayable placement digest recorded per model step |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the agent-kernel subsystem reference for the vocabulary and the generated Cordis API, then the seams the kernel observes rather than replaces.

- [Agent kernel subsystem reference](../../docs/subsystems/agent-kernel.md) — task contracts, the action ledger, the permission document, the completion gate, and the durable event families.
- [Context compiler subsystem reference](../../docs/subsystems/agent-context.md) — the source envelope, the placement record, and the ranking, pricing, and digest contracts.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the waterfalls the ledger is built on, and the decisions the kernel returns to them.
- [Architecture map](../../docs/architecture.md) — the ownership table the kernel is forbidden to duplicate.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

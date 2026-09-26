---
description: "The control-plane bundle layer: an agent kernel with built-in tool capability declarations and a prompt-injection guard, for users composing or customizing a dsh --profile surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-governance

English | [中文](README.zh.md)

## Summary

Add this layer to a profile that must record what each session decided and, when the deployment is ready, act on it. It inserts the agent kernel in shadow mode, the built-in declarations that let the kernel evaluate every shipped tool, the criterion verifiers its completion gate delegates to, and a prompt-injection guard that records what untrusted content tried to do. No shipped profile includes it: a deployment opts in, measures a permission document against real traffic, then flips `mode` to enforce. Everything it writes is log-only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-agent-governance
dsh plugin --profile <name> remove @deepseek-ai/dsh-agent-governance
```

The profile resolves the layer from the installed package and reconciles the four rows below into its composition; removing it drops those rows. If a row's package is missing from the profile, that row fails to resolve and the profile reports the unresolved entry rather than starting without it.

### What you get

Four rows, each owned by the package it names. `agent-kernel` records one durable task contract per session, proposes and decides every tool action against its permission document, and runs the completion gate — logging `task/*`, `action/*`, `policy/decision`, `verification/*`, and `failure/recorded` events. `agent-kernel-builtins` declares what each shipped product tool needs, so a shadow kernel's record names the real capability instead of a blanket denial. `command-verifiers` answers the completion gate for a task that declares criteria: one shell command per criterion id (`typecheck`, `lint`, `test` by default), run through `ctx.shell`, with the criterion decided by its exit status. The gate runs in `shadow` mode as well, so declaring criteria for a task class is what makes it binding. `prompt-injection` wraps tool results and model proposals in a tainted envelope, records `security/scan` when a known rule matches, and, in `enforce`, replaces credentials in the model-visible copy.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one insert list over whatever the profile's other layers already assembled, so a user or mode bundle above it can rewrite any row by id. Row order carries no load semantics: the kernel attaches to the loop and tool waterfalls when its own fiber activates, and the builtins companion registers as soon as the injected `agentKernel` service exists, whichever order the two rows appear in.

Every row but the verifier carries `shadow`. A shadow kernel records the decision it would have made and lets execution proceed, and a shadow guard records findings without rewriting content, so adding this layer to a running profile changes logs — never behavior — until an operator edits the row. The verifier row runs a command only when a task declares the criterion that command claims, and it decides that criterion rather than the tool pipeline.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The four rows, their `shadow` defaults, and the reason each one is separate |
| [`src/index.ts`](src/index.ts) | Documentation-only entry; the bundle has no runtime API |
| — | No runtime invariant companion is published; the layer adds plugins whose own packages own their invariants. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [bundle group map](../README.md) — every shipped layer and how a profile stacks them.
- [Agent kernel](../../runtime/agent-kernel/README.md) — the task contract, permission document, and completion gate this layer makes live.
- [Built-in declarations](../../runtime/agent-kernel-builtins/README.md) — the per-tool capability table.
- [Prompt-injection guard](../../guard/prompt-injection/README.md) — the rule table and the envelope it records.
- [app-boot](../../boot/app-boot/README.md) — how a profile resolves and layers its bundles.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the kernel's and the guard's own packages, which own every model-visible effect this layer can have.

#### KV Cache effect

No direct invalidation; the inserted rows own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are what the layer deliberately does not decide.

- **It ships in no profile** — enabling the control plane is a deployment's choice, so a profile that wants it lists this bundle explicitly.
- **It inserts no permission document or acceptance criteria** — the policy rules, the criteria a task class starts from, and the scan ceiling belong to the deployment's own profile patch, not to this layer. The verifier row ships the workspace's `typecheck`, `lint`, and `test` scripts as its commands, so a deployment whose criteria or commands differ rewrites that row.
- **The guard is a pattern matcher** — its rules recognise known shapes only, and its `enforce` mode rewrites credential spans rather than proving a result is safe.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "Built-in tool capability declarations for the agent kernel: one declaration per shipped product tool so enforce mode governs real traffic, for users and maintainers composing a governed runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-kernel-builtins

English | [中文](README.zh.md)

## Summary

Mount this package beside the agent kernel so `mode: 'enforce'` governs real traffic. It declares every shipped product tool's capabilities and the resource projection each capability applies to, registering them with the kernel once the kernel service exists, in any mount order, and it registers the product's independent reviewer on the kernel's coding-lifecycle port (§10.6). It owns no policy and no execution: the kernel's permission document still decides every action, and unloading the plugin removes exactly what it registered.

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

Load this plugin alongside `@deepseek-ai/dsh-agent-kernel` when a deployment turns on `mode: 'enforce'` or wants the kernel's §10.5 REVIEW phase to have an implementer. It injects no service; it only registers. Mount order never matters: the registrations wait on the injected `agentKernel` service.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    mode: enforce
    policy:
      defaults:
        effect: ask
      rules:
        - action: read
          resource: 'workspace/**'
          effect: allow
- name: '@deepseek-ai/dsh-agent-kernel-builtins'
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `reviewer` | `true` | Whether this plugin registers the shipped independent reviewer on `ctx.agentKernel.lifecycle`. Switch it off when the deployment registers its own reviewer, because the kernel refuses a second registration. |

The registered reviewer stays dormant until the kernel's own `Config.codingLifecycle.review.enabled` is set: a deployment that never enables the REVIEW phase spawns nothing, and this plugin's registration changes no behavior.

### When to choose it

Choose it when enforce mode must govern the shipped tools: an unattended run where every tool call needs a recorded decision, or a deployment whose permission document names action families rather than tools. Avoid it when a deployment declares its own surface instead — a renamed tool, a private tool package, or dynamically minted `mcp__*` names each need their own declaration, and an undeclared tool stays denied.

### What you get

One declaration per shipped product tool, each naming the capabilities one invocation needs and projecting the call's parsed arguments to the resource each capability applies to, plus the §10.6 independent reviewer: the coding lifecycle's REVIEW phase spawns it as a fresh child of the task's agent through the shipped reviewer seam (`@deepseek-ai/dsh-command-review`), and it answers with the structured report the phase consumes. The reviewer prompt names the diff to inspect, the objective the change was supposed to accomplish, and the schema its final turn must satisfy. Filesystem tools project paths, shell tools project commands, network tools project queries and URLs, delegation tools project descriptions and agent ids, and the remaining tools project the identifier their family is governed by. Every projection is total and never empty: an absent or malformed argument falls back to a constant naming the tool's domain, so an unknown resource matches only broad rules and can never slip past a narrow one. The complete table lives in [`src/declarations.ts`](src/declarations.ts), and a spec asserts it names exactly the tools the generated [tool catalog](../../../docs/tool-catalog.md) lists — a new shipped tool fails that spec until it is declared.

### Where declarations belong

The declarations live here rather than in the tool packages because only the policy plane may extend the capability vocabulary, and because a tool package must stay mountable without the kernel. A tool's schema stays with its package; what one invocation *needs* is policy knowledge, and it is verified against the catalog the tool packages themselves generate.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the declarations and the reviewer reach the kernel; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The kernel's registry starts empty and fails closed. This plugin fills it for the shipped surface and nothing else: `apply()` registers the whole table through one Cordis effect, so unloading the plugin disposes every registration it made and leaves foreign declarations alone. The injected `agentKernel` service makes mount order irrelevant — a composition may list this plugin before or after the kernel.

### The reviewer adapter

`registerCodingReviewer(ctx, config)` adapts the shipped reviewer seam to the kernel's `IndependentReviewer` port: it calls `runReviewer(ctx, config, task, caller)` from `@deepseek-ai/dsh-command-review` with the code-review prompt and `REVIEW_OUTPUT_SCHEMA`, hands the reviewer child the task agent as parent and the turn's cancellation, and returns the settled structured report — or throws when the reviewer stopped for any other reason or answered without one, which the kernel records as a `workflow-failed` failure before it parks the task. One spawn path therefore serves `/review`, `/security-review`, and the lifecycle's REVIEW phase.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`, `Config`, the `agentKernel` injection, and the registering effects |
| [`src/declarations.ts`](src/declarations.ts) | The declaration table and the total resource projections |
| [`src/reviewer.ts`](src/reviewer.ts) | The §10.6 adapter from the shipped reviewer seam to the kernel's coding-lifecycle port |
| — | No runtime invariant companion is published; the table is a static registration whose coverage spec re-derives the tool inventory from the generated catalog, so a second observation could not diverge from it. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the declarations to the policy they feed and the tools they name.

- [Agent kernel subsystem reference](../../../docs/subsystems/agent-kernel.md) — the permission document, the capability registry, and the authorization the declarations feed.
- [Generated tool catalog](../../../docs/tool-catalog.md) — every shipped product tool and the schema each projection reads its arguments from.
- [runtime group map](../README.md) — the sibling runtime packages.

-----

<a id="model-experience"></a>
## Model Experience

### Declared tool call

#### What the model sees

Nothing added. Declarations never reach the prompt, the tool schemas, or the conversation: they only let the kernel's permission document evaluate a call instead of denying it as undeclared. In `enforce` mode a call the document allows runs exactly as it would without the kernel; a call it denies returns a tool error beginning `agent-kernel denied "<tool>": `.

#### Token effect

Zero tokens added. A declaration changes no request content; it only changes whether an already-priced call runs or is replaced by one short reason line.

#### KV Cache effect

Independent: the plugin registers no prompt section and no schema, so it never changes the request prefix and cannot invalidate a reused entry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the plugin is a poor fit. They are current package constraints, not a task backlog.

- **Renamed tools need their own declarations** — the table declares default names plus the shipped `subagent_fork` alias. A deployment that renames a tool through load-time config declares the extra name itself.
- **Dynamically minted names are out of scope** — `mcp__<server>__<tool>` names and per-run `structured_output` tools do not exist until runtime, so no static table can declare them; a deployment using them declares each name or accepts the fail-closed denial.
- **One tool, one declaration** — `bash` and `pwsh` each ship twice under one name (one-shot and persistent variants); the single declaration covers the name, so both variants share the `process.exec` capability.
- **Mixed commands share one declaration** — `str_replace_editor` declares `fs.read` and `fs.edit` for every command, so a `view` carries an edit request it never uses. A deny on the `edit` family therefore denies views as well as mutations of that path.
- **Some mappings are closest-fit, not exact** — the fixed vocabulary has no member for reading skill bodies, session records, or background-job output (`fs.read` and `memory.read` stand in), nor for schedules and team tasks (`workflow.start` and task memory stand in). The table comment on each family records the rationale.
- **The shipped reviewer inherits the session's route** — `apply()` registers the adapter with no provider or model override, so the reviewer child runs on the invoking agent's route; `registerCodingReviewer(ctx, { provider, model, subagentProvider })` is the seam for a deployment that wants an independent backend, and §10.6's separate-model topology is a composition choice this plugin does not make for the deployment.
- **One reviewer per kernel** — the kernel refuses a second registration, so a deployment that composes its own `IndependentReviewer` sets `reviewer: false` here rather than mounting both.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The alternative designs were a declaration in each tool package and a central table owned by the tool registry. Per-package declarations invert the layering — product tool packages would depend on the policy plane — and a registry-owned table puts policy knowledge in the execution plane that the kernel is forbidden to duplicate. The separate opt-in plugin keeps the vocabulary, the registry, and the shipped declarations in one plane while leaving every tool package mountable without the kernel.

</details>

---
description: "Context compiler: it wraps every prompt contribution and durable task fact in a source envelope, ranks and prices them, records the placement digest one model step was compiled from, and drops only compressible sources past a token ceiling."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-context

English | [中文](README.zh.md)

## Summary

Mount this package to answer, from the session log, what one model step was compiled from and whether a replay reproduces it. It wraps every assembled prompt section and runtime context, plus the durable task facts the kernel derives, in a source envelope; ranks them by trust, kind, and relevance; prices them with the token meter; and appends one log-only `context/compiled` record per distinct placement (a repeat digest records nothing). `mode: 'shadow'` (the default) records the placement and changes nothing; `mode: 'apply'` also drops the compressible sources the ceiling cut. Policy, task, plan, and evidence sources are never dropped.

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

Mount the plugin in a profile when a step's compiled context must be attributable and replayable. Mounted with no configuration it records every placement in shadow mode with no token ceiling, so nothing is dropped before a deployment has measured one.

### When to choose it

Choose it when context provenance or a context token ceiling must be a runtime contract: an unattended run whose prompt you must reconstruct afterwards, a deployment paying per input token, or a replay that must reproduce a placement exactly. Avoid it when the assembled prompt is small and fully trusted, because the compiler appends one log-only record per assembly and, in `apply` mode, removes contributions.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-agent-context'
  config:
    mode: shadow
    maxContextTokens: 64000
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `shadow` records the placement and returns the assembly unchanged; `apply` also returns the assembly with every source the placement left out removed |
| `maxContextTokens` | unset (unbounded) | Token ceiling the placement is fitted to, priced by the token meter's fixed heuristic |

Every accepted field is listed in the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-context).

### What you get

The service records one `context/compiled` event per `system-prompt/assemble` waterfall that names an agent and compiles to a digest the session has not already recorded, and the record holds the placement digest, the stated compiler version, the ceiling it was fitted to, the placement's token price, one entry per placed source (id, kind, trust, retention, price, relevance), every omission with its reason, and every retained conflict. The prompt text itself stays on the `system/message` surface, so the record is an identity a replay must reproduce rather than a second copy of the prompt.

Two decisions are separate on purpose. The compiler decides what a step was compiled from and, in `apply` mode, which compressible sources the ceiling cut; it never decides what a contribution says, never edits prompt text, and never calls a model.

### Source attribution

An assembled contribution is classified by the prefix of its registered name, and an unlisted prefix is treated as untrusted repository content — data, never an instruction authority.

| Name prefix | Kind | Trust | Attributed to |
|---|---|---|---|
| `harness:`, `deployment:`, `plan:`, `team:`, `sandbox:`, `approval:` | `policy` | `trusted` | `policy` |
| `subagent:` | `policy` | `trusted` | `subagent` |
| `tool:`, `tools:` | `tool` | `trusted` | `tool` |
| `context:`, `ui:`, `app:` | `artifact` | `trusted` | `repo` |
| anything else | `artifact` | `untrusted` | `repo` |

A durable task fact read from `ctx.agentKernel.state.view(session)` is always `trusted`, always `required`, and attributed to `kernel`: the objective, one source per acceptance criterion, one per constraint, the latest plan revision, one per unsettled action, and one per unresolved failure.


### Registering a dynamic source (S2)

`ctx.agentContext.register(descriptor, provide)` is the seam a pre-step producer uses instead of appending a prompt section directly: `provide(agent, signal)` returns items for one compile, and the compiler wraps each as a `ContextSource` (`id: '<producer>:<itemId>'`), ranks and prices it alongside the assembly and the kernel's task facts, and includes it in the same digest. The call returns a disposer; calling it stops the producer's items from appearing in any later compile.

```ts
const stop = ctx.agentContext.register(
  { producer: 'goal', kind: 'task', trust: 'trusted', placement: 'stable-core', maxBytes: 4000 },
  async (agent, signal) => [{ id: 'objective', text: currentGoalText(agent), relevance: 1 }],
)
```

`placement` governs both retention and repetition, per amendment S1 point 3 and S2:

| Placement | Retention | Repetition |
|---|---|---|
| `stable-core` | `required` | Every compile, unconditionally — the producer's own unchanging identity brief |
| `delta` | `compressible` | Once per session per item id; withheld on every later compile until a `compaction/end` event on that session clears it |
| `tail-reminder` | `compressible` | Every compile — turn-conditional text, the first class the ceiling cuts |

An item past its own `expiresAt` is dropped before placement, and an item's text is truncated to the descriptor's `maxBytes` before it becomes a source. This registry is additive: no shipped producer has migrated off `core/system-prompt` sections onto it yet, so mounting the plugin with nothing registered behaves exactly as before.

### Retention and ranking

Retention follows the kind: `policy`, `task`, `plan`, and `evidence` are `required`, so they are placed even when they alone exceed the ceiling; `memory`, `artifact`, `history`, and `tool` are `compressible`.

Placement order is total, so a replay reproduces it: trust tier first (`trusted`, `unknown`, `untrusted`), then kind (`policy`, `task`, `plan`, `evidence`, `memory`, `artifact`, `history`, `tool`), then lexical overlap with the task objective, then the source id by code unit. The ceiling cuts a prefix of that order: once one compressible source does not fit, every later compressible one is omitted with `reason: 'budget'`. A compressible source whose content an already-placed source carries is omitted with `reason: 'duplicate'`; a required source is never dropped either way.

Two placed `required` sources that declare the same `subject` and disagree produce one `ContextConflict` naming the subject and the sources. The compiler reports a conflict; it does not resolve one.

The digest covers the compiler version, the ceiling, every placed source's id, kind, trust, retention, price, relevance and content hash, every omission, and every conflict. It excludes the clock and every generated identity.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains where a placement comes from and what the compiler refuses to do; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The compiler is built on four commitments:

- **A facade, not an assembler.** Every contribution it reads was registered with `core/system-prompt`, and every task fact comes from the kernel's fold over the session log. The compiler assembles no prompt and holds no source of truth.
- **Required before optimal.** Authority about the task — the permission that applies, the contract, its acceptance criteria, its plan, its evidence, its unresolved failures — is placed before a budget is consulted.
- **Deterministic by construction.** Ordering is total and the digest uses content hashes rather than timestamps, so the same inputs yield the same digest on any machine.
- **Shadow before apply.** The default mode measures a ceiling against real traffic before any deployment lets it remove a contribution.

### Where each decision is made

| Concern | Owner |
|---|---|
| Which contributions exist and what they say | `core/system-prompt` sections and runtime contexts |
| What the task is, its plan, its open actions, its failures | `dsh-agent-kernel` fold over the session log |
| Kind, trust, and attribution of a contribution | `src/classify.ts` |
| Placement order | `src/rank.ts` |
| Token price and the ceiling cut | `src/budget.ts` over `dsh-token-meter`'s fixed estimator |
| Placement identity | `src/digest.ts` |
| The durable record and the `apply` filter | `src/index.ts` |

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the service, and the assembly listener |
| [`src/compile.ts`](src/compile.ts) | The pure pipeline, the source-set assertions, dedupe and conflicts, and `recordOf()` |
| [`src/sources.ts`](src/sources.ts) | The two source families: assembled contributions and kernel task facts |
| [`src/classify.ts`](src/classify.ts) | The prefix, trust, attribution, and retention tables |
| [`src/rank.ts`](src/rank.ts) | Objective term extraction, relevance scoring, and the total placement order |
| [`src/budget.ts`](src/budget.ts) | Fixed-heuristic pricing and the required-first prefix cut |
| [`src/digest.ts`](src/digest.ts) | Content hashing and the canonical placement digest |
| [`src/types.ts`](src/types.ts) | Every compiler contract and the `SessionEventMap` merge for `context/compiled` |
| — | No runtime invariant companion is published; the record is a pure function of the assembly and the kernel view it names, so a second observation of the same step could not diverge from it. |

### Pipeline

```text
collect the assembled contributions
  -> wrap each in a source envelope (kind, trust, provenance, retention)
  -> append the kernel view's required task facts
  -> reject an empty or duplicated source id
  -> price with the token meter's fixed estimator
  -> score lexical overlap with the task objective
  -> sort by the total placement order
  -> drop compressible duplicates
  -> cut a compressible prefix at the ceiling
  -> report conflicts among placed required sources
  -> digest the placement
  -> append context/compiled; apply mode removes the rest from the assembly
```

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the package contract is not enough.

- [Context compiler subsystem reference](../../../docs/subsystems/agent-context.md) — the source envelope, the placement record, and the generated Cordis API.
- [Agent kernel subsystem reference](../../../docs/subsystems/agent-kernel.md) — the task contract, plan, open actions, and unresolved failures the compiler reads.
- [System prompt package](../../core/system-prompt/README.md) — the assembly and the contribution names the compiler classifies.
- [Session subsystem reference](../../../docs/subsystems/session.md) — the event map `context/compiled` extends and the `system/message` surface that keeps the prompt text.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-context) — every accepted field and its source declaration.
- [runtime group map](../README.md) — the sibling runtime packages.

-----

<a id="model-experience"></a>
## Model Experience

### Apply-mode omission

#### What the model sees

Nothing in `shadow` mode: the compiler appends its record and returns the assembly `core/system-prompt` produced. In `mode: 'apply'` the model sees the same sections and runtime contexts minus every source the placement left out — a compressible contribution the ceiling cut (`reason: 'budget'`) or one whose content an already-placed source carried (`reason: 'duplicate'`). Required sources, including every durable task fact, are always present.

#### Token effect

Zero direct tokens. `shadow` mode removes no tokens; `apply` mode removes the token price the record reports in `omitted` and can leave a placement priced above its own ceiling when required sources alone exceed it.

#### KV Cache effect

Independent in `shadow` mode, which changes no request. Replacing in `apply` mode: the removed contribution is missing from the request, so reuse is invalidated from the first position that changed, while the request prefix before the first omitted contribution stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the compiler is a poor fit. They are current package constraints, not a task backlog.

- **No profile mounts it and no projection reads `context/compiled`** — the record is durable and replayable, but no shipped profile enables the plugin and nothing yet renders the placement, so a deployment mounts it to read the log itself.
- **A duplicate source id rejects that assembly** — a section and a runtime context registered under one name reach the compiler as one id twice, and `assertSources()` rejects the compile, which fails prompt assembly for that step. Contribution names must be unique across both registries.
- **Conflict detection needs a declared subject** — only the compiler's own kernel-view sources declare one (`objective` and `plan`, each present at most once), and no assembled contribution declares any, so `conflicts` is empty for every mounted assembly; a caller supplying its own envelopes to `ctx.agentContext.compiler.compile()` is what exercises the report.
- **No plan source arrives yet** — `task/plan` is declared and folded by the kernel, but nothing appends it, so the plan envelope this compiler projects from the view never appears until a producer records a revision.
- **Relevance is lexical** — overlap with the objective's terms of three or more characters, with no stemming, synonym, or embedding stage, so a source that answers the objective in different words scores 0.
- **The token price is an estimate** — the ceiling compares the token meter's fixed heuristic, the same estimator that prices request content blocks, against a provider's actual token count.
- **Retention is fixed by kind** — every assembled `tool:`, `context:`, `ui:`, and `app:` contribution is compressible however much it reads like guidance, and an unlisted prefix is untrusted data; neither can be changed from configuration.
- **Application is per step** — `apply` mode filters the assembly it is handed, so a dropped contribution returns on the next assembly that fits it; the compiler keeps no memory between steps.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The compiler is the Phase 2 slice of the [evolutionary agent runtime specification](../../../specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md). Two deviations from that specification's literal text are deliberate. First, `CompiledContext` carries no `messages`: the loop renders the assembly, so the compiler returns the placement and lets `core/system-prompt` keep ownership of the rendered prompt. Second, required facts are not copied into a compaction checkpoint; the compiler re-derives them from the kernel view on every assembly, so a compaction that removes transcript text cannot remove the task's objective, acceptance criteria, plan, or unresolved failures from the next request. Model routing, the evidence graph, workflow checkpointing, and evolution promotion gates are later phases and are not represented here at all.

</details>

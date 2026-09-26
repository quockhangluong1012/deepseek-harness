---
description: "Context compiler: it wraps every prompt contribution and durable task fact in a source envelope, ranks and prices them, records the placement digest one model step was compiled from, and drops only compressible sources past a token ceiling."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-context

English | [中文](README.zh.md)

## Summary

Answer, from the session log, what one model step was compiled from and whether a replay reproduces it. Each assembled prompt section and runtime context, plus the durable task facts the kernel derives, becomes a source envelope ranked and priced with the token meter, and each distinct placement appends one log-only `context/compiled` record. `mode: 'shadow'` (the default) records the placement and changes nothing; `mode: 'apply'` also drops the compressible sources the ceiling cut. A tier derived from each source's kind can be withheld until a caller admits it.

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

Choose it when context source references or a context token ceiling must be a runtime contract: an unattended run whose prompt you must reconstruct afterwards, a deployment paying per input token, or a replay that must reproduce a placement exactly. Avoid it when the assembled prompt is small and fully trusted, because changed placements and delta resurfaces append log-only records, and `apply` mode removes omitted contributions.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-agent-context'
  config:
    mode: shadow
    maxContextTokens: 64000
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `shadow` records the placement and returns the assembly unchanged; `apply` also returns the assembly with every source the placement left out removed |
| `maxContextTokens` | unset (unbounded) | Token ceiling the placement is fitted to, priced by the token meter's fixed heuristic |
| `onDemandTiers` | `[]` | Tiers whose sources a placement withholds until `admit()` names the tier or the source id |

Every accepted field is listed in the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-context).

### What you get

The service appends one `context/compiled` record per changed placement, plus a same-digest record when compaction lets an included delta source resurface. Records store source identities and prices, never prompt text. A host-only `contextSourcePlacement` projection folds included ids and the last digest, clears seen ids at `compaction/end`, and rebuilds them from the log after restart.

The ceiling cut itself has hysteresis: a compressible source the ceiling placed or cut keeps that outcome on every later compile in the same request series, even as other sources' prices change, so a stable set of sources stays stable rather than reshuffling with every step. Only a `compaction/end` boundary clears the frozen decision, after which the next compile recomputes the cut from scratch.

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

A durable task fact read from `ctx.agentKernel.state.view(session)` is always `trusted`, always `required`, and attributed to `kernel`: the objective, one source per acceptance criterion, the change contract the task declared, one per constraint, the latest plan revision, one per unsettled action, and one per unresolved failure.


### Registering a dynamic source (S2)

`ctx.agentContext.register(descriptor, provide)` is the seam a pre-step producer uses instead of appending a prompt section directly: `provide(agent, signal)` returns items for one compile, and the compiler wraps each as a `ContextSource` (`id: '<producer>:<itemId>'`), ranks and prices it alongside the assembly and the kernel's task facts, and includes it in the same digest. The call returns a disposer; calling it stops the producer's items from appearing in any later compile.

`ctx.agentContext.isIncluded(session, sourceId)` reports whether the live session's latest successful placement included that source; it returns false before a compile, after compaction clears the placement, or when the source was omitted. The `context/compiled` event remains the durable replay record.

`ctx.agentContext.tokenTotals(session)` sums the newest recorded placement's token prices by source kind (`byKind`) and reports `placementCount`, the number of placements that have superseded an earlier one for the session (S1). The totals cover every placed source uniformly — assembled sections and contexts, the kernel's durable task facts, and registered (S2) sources alike — so a registered producer's price is never missing from the accounting just because its content reaches the model through its own injection path rather than through `PromptAssembly`. Before any compile `byKind` reads `{}` and `placementCount` is `0`; a compaction boundary clears the delta/hysteresis tracking but leaves the last placement's totals in place until the next compile overwrites them.

```ts
const stop = ctx.agentContext.register(
  { producer: 'goal', kind: 'task', trust: 'trusted', placement: 'stable-core', maxBytes: 4000 },
  async (agent, signal) => [{ id: 'objective', text: currentGoalText(agent), relevance: 1 }],
)
```

`placement` governs both retention and repetition, per amendment S1 point 3 and S2:

| Placement | Retention | Repetition |
|---|---|---|
| `stable-core` | `required` | Every compile — use for material that must survive budget cuts, including identity and recovery sources |
| `delta` | `compressible` | Surfaced once per session per item id after inclusion; omitted items stay eligible, and compaction makes included items eligible again |
| `tail-reminder` | `compressible` | Every compile — turn-conditional material that may be cut to fit the ceiling |

An item past its own `expiresAt` is dropped before placement, and an item's text is truncated to the descriptor's `maxBytes` before it becomes a source. This registry is additive: no shipped producer has migrated off `core/system-prompt` sections onto it yet, so mounting the plugin with nothing registered behaves exactly as before.

### Context tiers and the on-demand gate

Every source sits in one tier, derived from its kind, so `ContextPlacement` remains the only classification a producer registers. The tier names how deep in the model's working set the source belongs:

| Tier | Contents | Kinds |
|---|---|---|
| `L0` | standing policies and system instructions | `policy` |
| `L1` | the task contract and its acceptance criteria | `task` |
| `L2` | working memory: the plan and the evidence it turns on | `plan`, `evidence` |
| `L3` | relevant memory | `memory` |
| `L4` | recent history and tool results | `history`, `tool` |
| `L5` | references to content stored outside the context | `artifact` |
| `L6` | cold storage: content a placement never carries, reached through an `L5` reference | none |

`onDemandTiers` names the tiers a placement withholds. A withheld source is not an omission: the compile never prices, ranks, or digests it, so `included`, `omitted`, and the digest are exactly what they would be had the withheld candidates never been offered, and `CompiledContext.deferred` reports what was held back with its id, kind, and tier.

`ctx.agentContext.admit(session, { tiers, sourceIds })` admits withheld sources for that session's later compiles; the returned disposer withdraws the demand, after which the tier is withheld again. The demand is the caller's own and is not recorded in the session log, so the placement stays durable while a replay reproduces it only when given the same demand. `ctx.agentContext.compiler.compile()` takes the same `onDemandTiers` and `demand` inputs direct.

### Retention and ranking

Retention for assembled contributions follows kind: `policy`, `task`, `plan`, and `evidence` are `required`; `memory`, `artifact`, `history`, and `tool` are `compressible`. Registered sources follow placement: `stable-core` is required; `delta` and `tail-reminder` are compressible. Trust is independent, so a required untrusted source remains data, not instruction authority.

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
| Tier of a source kind, and the on-demand gate | `src/tiers.ts` |
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
| [`src/tiers.ts`](src/tiers.ts) | The kind-to-tier table and the gate that withholds a configured tier |
| [`src/rank.ts`](src/rank.ts) | Objective term extraction, relevance scoring, and the total placement order |
| [`src/budget.ts`](src/budget.ts) | Fixed-heuristic pricing and the required-first prefix cut |
| [`src/digest.ts`](src/digest.ts) | Content hashing and the canonical placement digest |
| [`src/types.ts`](src/types.ts) | Every compiler contract and the `SessionEventMap` merge for `context/compiled` |
| — | No runtime invariant companion is published; the record is a pure function of the assembly and the kernel view it names, so a second observation of the same step could not diverge from it. |

### Pipeline

```text
collect the assembled contributions
  -> wrap each in a source envelope (kind, trust, sourceRef, retention)
  -> append the kernel view's required task facts
  -> reject an empty or duplicated source id
  -> withhold every source in an on-demand tier the compile did not ask for
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

Nothing in `shadow` mode: the compiler appends its record and returns the assembly `core/system-prompt` produced. In `mode: 'apply'` the model sees the same sections and runtime contexts minus every source the placement left out — a compressible contribution the ceiling cut (`reason: 'budget'`) or one whose content an already-placed source carried (`reason: 'duplicate'`). Required sources, including every durable task fact, are always present. With `onDemandTiers` configured, a source in a withheld tier is absent in both modes until a caller admits it with `admit()`, and the placement reports it in `CompiledContext.deferred` rather than in `omitted`.

#### Token effect

Zero direct tokens. `shadow` mode removes no tokens; `apply` mode removes the token price the record reports in `omitted` and can leave a placement priced above its own ceiling when required sources alone exceed it. A withheld tier removes the token price it would have contributed from every step until it is admitted.

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
- **The demand is not durable** — `admit()` holds the admitted tiers and ids in the service instance, and `deferred` stays on the compile result, so the durable record shows the placement a demand produced but not the demand itself; a replay reproduces a withheld placement only when given the same demand.
- **No kind occupies `L6`** — the tier names content the spill store holds outside the placement, so configuring `onDemandTiers: ['L6']` withholds nothing today; a deployment that wants lower tiers fetched on demand names `L3`, `L4`, or `L5`.
- **A withheld source is not an omission** — `deferred` is not part of `included`, `omitted`, the token estimate, or the digest, so nothing durable distinguishes a withheld source from one that never existed. The event that prompts the demand is what a reader reproduces it from.
- **Application is per step** — `apply` mode filters the assembly it is handed, so a dropped contribution returns on the next assembly that fits it; the compiler keeps no memory between steps.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The compiler is the Phase 2 slice of the [evolutionary agent runtime specification](../../../specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md). Two deviations from that specification's literal text are deliberate. First, `CompiledContext` carries no `messages`: the loop renders the assembly, so the compiler returns the placement and lets `core/system-prompt` keep ownership of the rendered prompt. Second, required facts are not copied into a compaction checkpoint; the compiler re-derives them from the kernel view on every assembly, so a compaction that removes transcript text cannot remove the task's objective, acceptance criteria, plan, or unresolved failures from the next request. Model routing, the evidence graph, workflow checkpointing, and evolution promotion gates are later phases and are not represented here at all.

</details>

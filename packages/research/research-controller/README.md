---
description: "The research quality-control loop (ctx.research): ten durable stages from question to epistemic review, the stage-provider seam for the stages a mechanism performs, and the six-bucket answer contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-research-controller

English | [中文](README.zh.md)

## Summary

Run a research task as a durable ten-stage loop: question, decompose, research-plan, search, source-triage, claim-extraction, evidence, contradiction-search, synthesis, epistemic review. Every stage's status and output is stored in the `research` domain, so a run survives a context break and a stage that cannot run is refused with the reference it is missing. The loop's own stages are the model's, through the `research_advance` tool; the search, source-triage, and contradiction-search stages are providers' work. Observations and claims stay the agent kernel's records.

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

Mount the plugin in a composition that already carries `agentKernel`, `tools`, and `storageDomain`; it registers `ctx.research` and two model-visible tools.

### The seam

- **Service Definition** — this package's `ResearchController` (`ctx.research`): the stage vocabulary, the run's durable state, its order rules, and the answer contract.
- **Service Providers** — packages that call `ctx.research.registerStageProvider(provider)` for one of the mechanism stages: `search`, `source-triage`, and `contradiction-search`. A stage has exactly one provider, and a run whose next stage is a provider's without one is refused. Source ranking and contradiction search are mechanisms owned by their own packages.
- **Consumers** — the `research_advance` and `research_state` tools, which carry the agent loop's stage work and read the run back.

A reader without a live agent — an evaluation pass over what the loop recorded — reads the stored runs through `runs(sessionId?)`, newest first and optionally scoped to one session. The run record is the whole durable state of a run; its evidence and claims are kernel identities, which a caller resolves through the session log rather than through this service.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-research-controller'
  config:
    maxTextBytes: 4096
    maxItems: 16
    maxRuns: 50
```

| Field | Meaning |
|---|---|
| `maxTextBytes` | Cap in UTF-8 bytes on any one stated text: the question, a stage line, a claim, an answer statement |
| `maxItems` | Cap on one list: sub-questions, plan steps, stage output lines, claims, answer statements |
| `maxRuns` | Settled runs retained per session; older settled runs are dropped as newer ones are stored |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-research-controller) lists every field. All three are required, so a composition that omits one fails at load rather than running unbounded.

A research run also requires the session's kernel task to be class `research`: the kernel takes that class from the caller's statement, an agent profile whose `taskClass` is `research`, or the deployment default. A run started under any other class is refused with the class it found, rather than recording research stages against a conversational task.

### Registering a stage provider

```ts
import type { ResearchStageProvider } from '@deepseek-ai/dsh-research-controller'

const provider: ResearchStageProvider = {
  id: 'web-search',
  stages: ['search'],
  async run(request, signal) {
    return {
      output: [`searched for "${request.question}"`],
      observations: [{ kind: 'web', contentRef: 'https://example.test/spec', sourceRef: { source: 'web', locator: 'spec' }, trust: 'untrusted' }],
    }
  },
}

ctx.effect(() => ctx.research.registerStageProvider(provider), 'web-search.stageProvider')
```

The returned disposer removes the provider; registration is refused when it claims a stage that already has one or a stage whose work is the agent loop's. Every observation a provider returns is recorded through `ctx.agentKernel.recordEvidence`, so the run cites the kernel's own record.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The controller holds one durable record per run in the `research` domain (`src/spec.ts`), and the pure transition rules in `src/pipeline.ts`: which stage may advance, what a stage records, how the six buckets group, and which violations the epistemic review refuses. `src/index.ts` performs the I/O those rules cannot: providers, kernel records, and the domain writes.

A stage settles in one of three states. `pending` is untried; `produced` carries output and the references the stage recorded; `failed` carries the reason, and the run stays at that stage so the next advance retries it. A refused answer is revised by advancing `synthesis` again, which re-opens the review that refused it.

The observations and claims are not copied: `claim-extraction` records each claim through `ctx.agentKernel.recordClaim`, provider observations go through `ctx.agentKernel.recordEvidence`, and the `evidence` stage requires at least one observation the run recorded through a stage that searched. The cross-session claims `evolution-graph` keeps are a separate, promotion-scoped record; this package never writes them.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `ctx.research` service, the two tools, kernel and domain I/O |
| [`src/types.ts`](src/types.ts) | Stage vocabulary, run and stage records, the answer contract, the provider seam |
| [`src/stages.ts`](src/stages.ts) | The ordered stage table and which stages a provider performs |
| [`src/pipeline.ts`](src/pipeline.ts) | Pure transitions: order gates, stage settlement, answer grouping, review |
| [`src/spec.ts`](src/spec.ts) | The `research` domain declaration and its zod record schema |
| [`src/caps.ts`](src/caps.ts) | The configured caps, enforced with the measured size in the refusal |

**No invariant companion.** The domain layer already emits `domain/changed` and validates every stored record at open; a second observer inside this package would read the same in-memory table it just wrote, so it cannot diverge independently.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent kernel](../../runtime/agent-kernel/README.md) — the task contract, the class of work it names, and the `evidence/recorded` and `claim/updated` records this loop writes through.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain form the run record is stored in.
- [Research subsystem](../../../docs/subsystems/research.md) — the loop reference: stage semantics, the durable record, and the answer contract.

-----

<a id="model-experience"></a>
## Model Experience

### The research loop's two tools

#### What the model sees

The model sees the generated `research_advance` and `research_state` schemas. `research_advance` takes a `stage` (closed to the ten stage names), optional `items`, `claims`, and `sections`; `research_state` takes an optional `runId`. Both return the run as lines, so the model reads each stage's status and output, the next stage to advance, and the accepted answer in one result. The description states the loop's order, that a stage cannot be skipped, that a failed stage is retried, that a refused answer is revised by advancing synthesis again, which stage each input belongs to, and the review's two conditions.

#### Token effect

Both schemas are present whenever the tools are visible. The stage table, the answer buckets, and the loop's order are fixed schema text; the run text returned by a call grows with the stages that have produced and their output lines, each capped by `maxTextBytes` and `maxItems`.

#### KV Cache effect

The tool schemas remain prefix-stable while their definitions and visibility stay unchanged. Run text arrives as a tool result, so it never rewrites the request prefix; plugin lifecycle, agent restrictions, or a changed stage table can change the schema set.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The mechanism stages need a deployment's provider.** The `search`, `source-triage`, and `contradiction-search` stages fail loud without one; the packages that own source ranking and contradiction search provide them, and this package ships none.
- **Buckets are asserted, not verified against a claim type.** The kernel's claim record carries no `type` enum yet, so the review checks that every recorded claim is stated in a bucket and that no statement outside `unresolved` rests on no claim; it cannot check that a statement is documented rather than inferred.
- **Run state is host-side.** The `research` domain is in-process state: a second process reads only what it opened, and the listed observations are capped while the recorded identities are not.
- **References are by value.** A run stores evidence and claim identities a session recorded; a deleted or migrated session log leaves those identities unresolvable, and nothing here revalidates them.
- **Retention never deletes an unsettled run.** `maxRuns` bounds settled runs per session; an unsettled run stays until it settles, so a session that abandons runs keeps them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "Named ICT analyst and devil's advocate answer contracts: one preset per profile, a fixed section list, and a validator that rejects an answer before a caller acts on it."
kind: "package-reference"
---

# @deepseek-ai/dsh-analyst-profiles

English | [中文](README.zh.md)

## Summary

Give a session one of two analysis roles and get back an answer a program can check. Each profile fixes an ordered section list, and every claim is labelled observed or inferred, so an interpretation cannot pass as an observation. A caller reads a profile's structured-output schema for a delegation, then validates what came back under the same profile id before acting on it. The ICT analyst answers as OBSERVATIONS through MISSING EVIDENCE; the devil's advocate answers as Thesis through Confidence — the shape the mentor loop's advocate stage and the research loop's contradiction step consume.

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

Mount the service row once, then one preset row per profile the deployment offers as a selectable Agent preset.

### When to choose it

Choose it when a caller has to act on an analysis programmatically: the profile states which sections the answer must carry, which of them are observations, and how the answer states its uncertainty, so a consumer can reject an incomplete or mixed answer instead of parsing prose. Use it for the mentor loop's advocate stage or the research loop's contradiction step, where the same critique is required every round. Do not use it for open-ended discussion: a session that only needs an analyst's tone gets that from a persona row, and a preset that plants a fixed section list would constrain a conversation that has no artifact to produce.

### Minimal configuration

```yaml
# The profile directory every consumer reads by name.
- name: '@deepseek-ai/dsh-analyst-profiles'

# One row per profile the deployment offers as a preset.
- name: '@deepseek-ai/dsh-analyst-profiles/preset'
  config:
    profile: devil-advocate
```

| Field | Default | Meaning |
|---|---|---|
| `profile` | required | Declared profile this row registers as a preset; an undeclared id rejects at load and registers no preset |

The declared ids are the values `ctx.analystProfiles.list()` returns, currently `ict-analyst` and `devil-advocate`. The preset appears in the roster under the profile's title, and a session that selects it composes the profile prompt as its persona prefix.

### What a caller does with the result

A caller delegates with the profile's schema as the run's `outputSchema` — `ctx.analystProfiles.outputSchema('devil-advocate')` — and validates `result.structured` through the same profile id. The validator is pure, so it runs on any artifact the caller already parsed:

```ts
import { getProfile, validateProfileArtifact } from '@deepseek-ai/dsh-analyst-profiles'

/** Report what a delegated advocate answer breaks, or nothing when it satisfies the contract. */
function advocateProblems(answerFromTheRun: unknown): string[] {
  const verdict = validateProfileArtifact(getProfile('devil-advocate'), answerFromTheRun)
  return verdict.ok ? [] : verdict.violations.map(violation => `${violation.at}: ${violation.message}`)
}
```

Sections worth routing on: the advocate's `Falsifiers` and `Counterarguments` are the counter-evidence a contradiction step files, and its `Confidence` justifies the numeric `confidence` the artifact carries.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A profile is data, not behavior: an id, a title, a method paragraph, and an ordered section list whose entries pair a heading with the basis its claims must carry. Everything else is derived from that record. The prompt is the method plus shared answer rules plus the numbered sections, and it becomes the persona prefix of the preset the profile's row registers over the agent-preset seam. The structured-output schema enumerates the same ids, headings, and bases for a delegation, and the validator walks the same list to report a missing, unexpected, duplicated, misplaced, empty, or mixed section. There is no second copy of the section list to keep in step.

| File | Responsibility |
|---|---|
| [index.ts](src/index.ts) | `ctx.analystProfiles`: `list`, `get`, `outputSchema`, `validate` |
| [profiles.ts](src/profiles.ts) | Both profile records, the prompt, the schema, and the preset declaration |
| [validate.ts](src/validate.ts) | The pure section validator and its violation vocabulary |
| [preset.ts](src/preset.ts) | The preset row: `ctx.agentPresets.register` and its unregister disposer |
| [types.ts](src/types.ts) | Contract types only |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Persona](../persona/README.md) — the row each profile preset composes its prompt through.
- [Agent presets](../agent-preset-registry/README.md) — the preset registry this package declares into, its roster, and revision retention.
- [Agent preset](../agent-preset/README.md) — the declarative row the profile's declaration mirrors.
- [Subagent](../../subagent/subagent/README.md) — the `outputSchema` delegation whose `structured` result this validator consumes.
- [System prompt subsystem](../../../docs/subsystems/system-prompt.md) — the persona slot the profile prompt occupies.
- [Tools](../../core/tools/README.md) — the JSON Schema subset the output schema is written in.

-----

<a id="model-experience"></a>
## Model Experience

### The profile prompt

#### What the model sees

A session whose preset is a profile receives that profile's prompt as the `deployment:persona-prefix` section, replacing the deployment persona. The prompt states the role, the observation/interpretation rule, the `confidence` requirement, and the numbered sections the answer must carry. The two profiles differ only in their method paragraph and section list; the ICT analyst prompt is shown verbatim.

##### ICT analyst prompt

```markdown
You are an ICT (Inner Circle Trader) market analyst. Work only from the market data the task supplies: price action, timeframes, levels, sessions, and any volume series. When the inputs do not support a statement, record the gap in MISSING EVIDENCE instead of inventing it.

Separate observation from interpretation. A claim carries basis "observed" when the supplied inputs state it, and "inferred" when you derived it from them. A section accepts only its own basis, so never present an inference as an observation.

State uncertainty explicitly. `confidence` is a number from 0 to 1 for the whole answer, and the section reporting it says what justifies that number.

Answer as one structured_output call with three members: profile set to "ict-analyst", confidence, and sections. Sections, in this order, each with at least one claim:
1. OBSERVATIONS (observed): Price, time, level, session, and volume facts read from the supplied data, each naming the timeframe it came from.
2. STRUCTURE (inferred): The structural read those facts support: swing sequence, breaks of structure, trend direction, and where the structure is still unclear.
3. LIQUIDITY (observed): Liquidity visible in the data: prior session highs and lows, equal highs and lows, and the wicks that traded through them.
4. PD ARRAY (inferred): The premium, equilibrium, and discount levels over the dealing range you chose, and why you chose that range.
5. BIAS (inferred): The directional bias, the timeframes carrying it, and the timeframe that would have to turn for the bias to change.
6. SCENARIOS (inferred): The scenarios the bias implies, each with its trigger and its target, in the order you expect them.
7. CONFIRMATION (inferred): What would confirm each scenario: the level, time window, and candle behaviour you will look for.
8. INVALIDATION (inferred): What would prove each scenario wrong, as a level or an event rather than as a feeling.
9. CONFIDENCE (inferred): Why the overall confidence value is what it is, and which read would change it.
10. MISSING EVIDENCE (observed): Inputs the analysis needed that the task did not supply, each naming what it would have settled.

Add no other section, rename none, reorder none, and leave none empty. When your task supplies no structured_output tool, answer in prose with these same headings and label every claim observed or inferred.
```

#### Token effect

Fixed per profile: the prompt's tokens on every request the preset's sessions make, and none for a session running another preset. The schema this package derives contributes no tokens; a caller that passes it to a delegation pays only the structured-output tool's own schema and instruction.

#### KV Cache effect

Prefix-stable while the profile's prompt text is unchanged. A preset is fixed for a session's life, so the section keeps its position; editing the profile changes the prefix for Agents created afterwards and leaves running sessions on the retained composition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Current package constraints, not a task backlog.

- **The preset drops the deployment persona suffix.** A profile preset composes a persona row with a `prefix` only, so the deployment's suffix — for example a working-directory line — is shadowed away for that session. A deployment that needs its suffix adds one to the profile row it inserts, or patches the preset it uses.
- **Validation checks the contract, not the analysis.** The validator proves that the sections are present, ordered, and correctly based; it cannot tell whether an observed claim is true or an inference is sound, so a schema-conforming answer can still be wrong.
- **A prose answer has no artifact to validate.** Enforcement requires the caller to pass `outputSchema` on the delegation; without it the profile is guidance the model may answer around.
- **The section contract is fixed in code.** A deployment cannot add, rename, or reorder sections; changing a contract is a package change, because the prompt, the schema, and the validator all derive from one record.
- **One profile per session.** A session runs the profile its preset declares; profiles do not compose with each other.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No runtime invariant companion is published because this package owns no mutable runtime state: the profiles are fixed records, the validator is pure, and the preset row's only live effect is the registry disposer it returns.

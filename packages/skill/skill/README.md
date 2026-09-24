---
description: "The skill provider registry for users and maintainers choosing, configuring, or debugging how skills from any source are merged, resolved, and loaded."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill

English | [中文](README.zh.md)

## Summary

Use this package to give agents and users one catalog of reusable, task-specific instructions collected from local directories, embedded plugin data, or remote services. It resolves duplicate names predictably, validates entries, tolerates unavailable sources without discarding usable results, and loads the selected skill's full instructions on demand. Mount it when a composition needs skills from multiple or non-filesystem sources; pair it with `dsh-skill-filesystem` for local discovery and `dsh-tool-skill` for model access, because it includes no skill content itself.

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

Mount the plugin to give a composition one skill registry. Skill sources (providers) and consumers (the model-facing catalog and loader, or your own code) all talk to `ctx.skills`; the registry merges everything any provider reports, so one lookup sees skills from every source.

### When to choose it

Use `dsh-skill` when agents should load skills from more than one source through one interface, or when the source of skills is not the local filesystem. Avoid it when a composition needs no skill loading at all — the plugin adds a service and a per-lookup discovery cost. The shipped local provider (`dsh-skill-filesystem`) and the model-facing consumer (`dsh-tool-skill`) are separate packages; mount them alongside when the deployment wants local skills and model access.

### Mount and configure

Load the plugin like any Cordis plugin. The only configuration limits how many completed provider catalogs are kept in memory; everything else is provider behavior.

```yaml
- name: '@deepseek-ai/dsh-skill'
```

| Field | Default | Meaning |
|---|---|---|
| `collectCacheMaxEntries` | `128` | Completed cwd/provider catalogs kept in memory |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skill) is the exhaustive source for every accepted field.

### What the registry gives you

- **One merged catalog.** A consumer asks for the current catalog of a workspace and receives every winning skill summary from every provider, sorted by name — no provider-specific ordering or deduplication to do.
- **On-demand loading.** Asking for one skill by name returns the full instruction body from whichever provider owns the winning candidate; the registry re-validates the loaded definition and rejects a stale selection whose name changed between discovery and load.
- **Embedded skills.** Plugins register an in-memory skill with `ctx.skills.register(...)`; the registry fills in a default invocation policy and the `runtime` provider label. Same-name runtime registrations in one layer are first-wins with a warning.
- **Provider registration.** A provider contributes its catalog with `ctx.skills.registerProvider(...)`; registration is synchronous, and the returned disposer removes the provider. `runtime` is a reserved provider name.
- **Load-time declarations pass through.** A loaded definition may carry the `requiredEnv` names it needs, a `config` map of its own defaults, and an install `blueprint` (`{ schedule, deliver, prompt }`). The registry validates all three and hands them to the loading consumer (the model-facing loader resolves the first two); a blueprint in the wrong shape is dropped rather than failing the load. Summaries stay invocation-neutral, so none of them reaches a catalog, and a blueprint is only ever a suggestion — nothing schedules itself. The exceptions are the routing relations: validated `requires`, `conflicts_with`, and `capabilities` lists ride the summary for selectors, and so do the compositionality declarations — `compatible_with` and `composable_with` (allowlists a loader and a synthesis enforce), `inputs` and `outputs` (data names, carried but never gating), and `derived_from` (the skills a body was synthesized from) — while every other declaration stays load-time-only.

An invocation policy on every skill decides which surfaces may advertise and load it: `modelInvocable` for model-facing tools and catalogs, `userInvocable` for human-facing commands. The registry keeps all four combinations, so one discovery result can serve both surfaces without conflating their catalogs.

| Policy | Model | User |
|---|---|---|
| `{ modelInvocable: true, userInvocable: true }` | included | included |
| `{ modelInvocable: true, userInvocable: false }` | included | excluded |
| `{ modelInvocable: false, userInvocable: true }` | excluded | included |
| `{ modelInvocable: false, userInvocable: false }` | excluded | excluded |

### Observable success and failures

A skill that any provider reports appears in the merged catalog, and loading it by its exact kebab-case name returns the body; an invalid name returns no skill rather than throwing. A provider that fails discovery is logged and skipped, and the observation is reported incomplete so consumers keep their last-good catalog; an explicit incomplete observation still contributes its candidates. A malformed candidate fails fast — the registry validates names, descriptions, invocation booleans, and provider ownership before caching or returning anything.

Skill summaries retain the winning provider’s optional instruction-file `path` for discovery consumers that offer file previews. Listing still reads no skill body, and model-facing catalogs continue to select only their owned routing fields.

A provider observation may report a `quarantinedCount` for skills it skipped, such as project skills that failed a security scan. The registry sums the counts seen by its most recent completed discovery and reports that total on the `skills/change` event; the count is host-log evidence and never enters the model-facing catalog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the registry merges, caches, and invalidates provider catalogs; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is built on one separation: the registry owns merging, winning resolution, and validation, while providers own where skills come from. A provider is a borrowed same-process object with a `list()` that returns candidates and a `get()` that loads a body; the registry never inspects skill content beyond validating its semantic fields.

The registry is host+per-scope layered, the shape the tools registry established: a registration is filed into the layer of its calling context's scope — host rows and repository plugins land in the global layer, a plugin mounted by an agent preset's standing composition lands in that preset's layer. A read merges the global layer with the viewing scope's chain; the nearest layer wins a duplicate name outright, and within one layer duplicates resolve by rank, provider registration order, then provider-local order.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, `SkillRegistry` service, candidate and definition validation, shared model-facing rendering |
| [`src/rank.ts`](src/rank.ts) | Query-time ranking: BM25 rough rank over routing text, re-ranked by embedding similarity and downstream utility |
| [`src/composition.ts`](src/composition.ts) | The declared-pair rules: whether a load set is consistent and whether a synthesis source set composes, reading one `CompositionMember` shape |
| — | No runtime invariant companion is published; provider/runtime maps and revisioned caches mutate atomically inside the registry, which exposes no independent change event or snapshot for cross-checking them. |

### Catalog collection

A read (`list`/`snapshot`) collects each layer's candidates: runtime skills first, then each provider's `list()` result, awaiting providers sequentially and containing failures. Candidates are validated, deduplicated within the layer, and merged across layers; summaries sort by name. A candidate whose provider marks it `quarantined` is dropped here and added to the quarantined count, so it is neither advertised nor loadable — a provider that reports the quarantine instead of withholding the candidate reaches the same outcome. Completed collections are cached per cwd, scope chain, and revision up to `collectCacheMaxEntries`; an in-flight collection retries once when a provider or runtime mutation bumps the revision mid-read, and a second change returns the latest candidates as an incomplete, uncached observation.

### Admission

A summary may carry `admission` (`bundled`, `project-reviewed`, `user-approved`, or `quarantined`), `trust`, `sourceDigest`, and `rollbackArtifact`. The registry enforces only the quarantine; `admitSkill()` is the gate a consumer applies when it holds a grant: it refuses a quarantined skill, refuses an untrusted skill whose provider names no review, and refuses a declared capability outside the caller's grant, because a skill may narrow the caller's authority but never widen it. `capabilitiesWithin()` exposes that containment check alone.

### Loading and staleness

`get()` selects the winning candidate, races the provider's load against the lookup's abort signal, and rechecks cancellation after selection or a cache hit. The returned definition must match the selected candidate's name; a mismatch invalidates the cached catalogs so the next snapshot rediscovers the provider's skills. Definitions are never cached — every load asks the provider for the current body.

### Invalidation

The registry has no TTL: only a provider calling its registration-scoped `invalidate()`, or a runtime registration or disposal, clears completed catalogs. Each invalidation bumps a revision, clears the cache, and emits the `skills/change` event, whose payload carries the quarantined skill count observed by the most recent completed discovery (zero before one completes); consumers refetch with their own lookup options. `invalidate()` takes effect only while the exact registration that received it is still active, so a late callback cannot disturb a replacement provider with the same name.

### Query-time ranking

`rankSkills(query, skills, nameOf, textOf, options?)` ranks candidates for one query without touching the registry: a BM25 rough rank over name, description, and `whenToUse`, re-ranked by embedding cosine similarity when the caller supplies vectors and by downstream utility when it supplies signals (`SkillRankSignal`: trust standing plus recorded failure rate, mapped from telemetry without a package dependency). A caller may also supply each skill's declared relations, all from frontmatter: prerequisites (`requires`), the capabilities a skill provides (`capabilities`), and the rivals it must not be selected alongside (`conflicts`). A prerequisite is satisfied by a candidate with that name or by a candidate that provides it as a capability; a skill with a prerequisite the candidate set does not satisfy scores zero, since routing to a skill that cannot work without an absent sibling is never the right call. Of two conflicting candidates the better ranked keeps its score and the other scores zero, and an unroutable candidate never excludes a sibling. Ranking is pure and synchronous — no I/O and no model calls — so the per-turn catalog path stays untouched; today its one consumer is the behavior-evaluation routing gate, which is exactly the offline selector the ranking was built for. There is no rank cache to go stale: ranks compute per call over caller-supplied revision keys, and the registry's revision-keyed collection cache already invalidates on skill evolution.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared skill vocabulary to the shipped provider, the model-facing consumer, and the design rationale.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry, provider contract, and local discovery priority.
- [skill-filesystem package](../skill-filesystem/README.md) — the shipped local provider that discovers skills from disk.
- [tool-skill package](../tool-skill/README.md) — the consumer that renders the session catalog and the `skill` tool.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skill) — every config field and its source declaration.
- [Skill invocation policy Agent Note](../../../.agents/notes/implemented/feature/2026-07-28-skill-invocation-policy.md) — the rationale for the model and user invocation controls.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders provider summaries into durable initial or replacement catalog messages and loaded instruction bodies into retained tool results.

#### KV Cache effect

No direct prompt effect. The named consumer owns the durable initial catalog and append-only replacements after invalidation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the registry is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Invalidation is provider-driven** — the registry has no TTL and cannot infer that an arbitrary remote source changed; each mutable provider must retain and call its registration-scoped `invalidate()` capability from its own observation mechanism.
- **Providers are queried sequentially** — one slow provider delays every provider registered after it; cancellation stops the caller's wait but cannot terminate work an uncooperative provider keeps running.
- **Incomplete observations are not retained** — rejected providers are omitted and explicitly supplied candidates remain available only to the current lookup; the registry owns neither a last-good catalog nor per-provider diagnostics.
- **Duplicate resolution is first-wins** — later lower-priority candidates within a layer are logged and hidden, and a nearer layer shadows a farther one silently; there is no API to inspect all shadowed definitions.
- **Ranking does not reorder the catalog** — `rankSkills` is a pure offline selector; the per-turn catalog keeps its static precedence order until a measured retrieval miss justifies wiring ranking into the model-visible path.
- **Composition binds only where a set is selected** — `requires` and `conflicts_with` are enforced by the offline ranker, the behavior routing gate, and the loader's declared composition, while `compatible_with` binds only the load, because the ranker judges candidates one at a time; two conflicting skills loaded in separate calls are not refused, because neither call sees the other. `composable_with` likewise binds only the synthesis that names its sources.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. An open question is whether the registry should retain a last-good catalog or per-provider diagnostics for failed providers, or whether consumers should own that state; the incomplete-observations limitation records the current answer.

</details>

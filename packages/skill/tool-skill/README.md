---
description: "The model-facing skill catalog and loader tool for users and maintainers understanding what agents see, or configuring the session skill catalog."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

English | [中文](README.zh.md)

## Summary

Agents can discover and load skills during a session: when model-invocable skills exist and the `skill` tool is visible, the agent receives a durable catalog of names and capped descriptions before its first request, and loads full instructions with the tool. Users can invoke a user-invocable skill with `/name`, which injects the same instructions into that step. Catalog changes append a complete replacement, including an empty catalog that retires old names; `catalogDescriptionMaxLength` caps each description. A load resolves `required_env`, `skills.config` overrides, and opt-in `metadata.shell` expansion first, and fails rather than loading with a declaration unresolved.

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

Mount the plugin alongside the skill registry to give agents a session skill catalog and the `skill` loader tool. It requires `ctx.agents`, `ctx.tools`, and `ctx.skills`.

### When to choose it

Use it when agents should discover and load skills during a session. Skip it when skill loading is handled by another consumer or not needed at all — without it, providers and the registry still work, but nothing renders a catalog or a tool for the model.

### Mount and configure

Load the plugin together with the skill registry and at least one provider, and mount a shell executor when any skill opts into inline shell expansion. Configuration caps the normalized description length rendered in the catalog and supplies deployment-side per-skill configuration values.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
  config:
    skills:
      config:
        deploy-skill: { region: eu-west-1 }
```

| Field | Default | Meaning |
|---|---|---|
| `catalogDescriptionMaxLength` | `500` | Maximum normalized description length rendered in the session catalog; minimum 3 |
| `skills.config` | `{}` | Per-skill configuration values injected at load, keyed by skill name then config key; a deployed value overrides the skill's own declared default |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-skill) is the exhaustive source for every accepted field.

### What the model gets

- **A session catalog.** When model-invocable skills exist and the `skill` tool is visible, the agent receives a durable user-role message before its first request, listing each skill's name and a capped description; the message tells the model to load a skill with the tool before acting on it, and never to infer instructions from the summary alone.
- **A loader tool.** The model calls `skill` with the exact skill name and receives the full instruction body plus resource guidance in a canonical `<skill_content>` block; the result is retained as ordinary tool history. Before rendering, the loader resolves the skill's load-time environment — see [Load-time environment](#load-time-environment) — and expands `${DSH_SKILL_DIR}` (the skill's own directory) and `${DSH_SESSION_ID}` (the loading agent's session id) in the body; any other `${...}` sequence a skill did not declare as configuration stays verbatim unless the skill opted into inline shell, and a variable without a value — `${DSH_SKILL_DIR}` for virtual skills without a path, or `${DSH_SESSION_ID}` when no agent loads the skill — stays verbatim.
- **Explicit user invocation.** A `/name` token in direct user input that names a user-invocable skill injects that skill's instructions into the step, without the model having to load it. The same load-time resolution and template expansion apply before the injection is rendered, and a declared composition rides the gesture as one injection per member; a composition that cannot resolve warns on the host log and skips that skill for the step.
- **Declared composition.** A load returns the requested skill plus every prerequisite it declares, each rendered as its own `<skill_content>` block after the requested skill's and in declaration order; the result carries them in `composed`. A prerequisite that resolves to no catalog skill name and no provided capability refuses the whole load with `Error: skill "<name>" requires "<prerequisite>", which is not available in this session`, and a set whose members declare a conflict refuses it with `Error: skill "<name>" cannot load: "<a>" and "<b>" declare a conflict` — half a declared composition never loads.
- **Live catalog updates.** Later membership, description, or visibility changes append a complete replacement catalog; removing every skill appends an empty catalog that retires older names.

### Load-time environment

A load resolves the environment the skill runs in before its body reaches the model. Three declarations take effect:

- **`required_env`.** Every declared name must be set in the host environment; the values are forwarded to the skill's execution commands. A declared name that is unset fails the load with an error naming it — the tool reports `Error: skill "<name>" requires environment variable "<NAME>", which the host environment does not set`, and a user-explicit invocation warns and skips that skill for the step instead.
- **`config`.** Declared keys are the union of the deployment's `skills.config.<skill>` map and the skill's own frontmatter `config` map. A deployed value wins over the skill's own default, a blank value counts as absent, and a declared key with no value in either source fails the load the same way, naming every missing key.
- **Inline shell.** Any remaining `${...}` sequence runs as a shell command through the mounted `ctx.shell` executor only when the skill sets `metadata.shell: true`; commands run from the skill's own directory with the resolved environment, output is capped at 4000 characters, and `metadata.shellTimeoutMs` (default `10000`, positive) bounds each command. A command that fails, times out, is aborted, or has no executor contributes nothing to the body and warns on the host log. A declared `config` key wins over a shell command of the same name.

### Observable success and failures

Loading a listed skill returns its full instructions; the model sees one canonical shape whether the load came from the tool or from a user's explicit invocation. An invalid name reports `Error: invalid skill name "<name>"`, an unknown name reports the skill is unknown or no longer available, and a skill disabled for model invocation reports it is not available for model invocation. A skill whose declared `required_env` or `config` cannot resolve reports the explanatory load error above instead of loading with a partially resolved environment. The catalog is omitted entirely when no catalog was ever published and either no model-invocable skills exist or the `skill` tool is hidden or shadowed; after a catalog has been published, either visibility loss — the `skill` tool hidden or shadowed by a same-name scoped tool — or removal of every skill instead appends an empty catalog that retires older names.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the catalog and the invocation boundary are built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

The package is built on two ideas. First, the catalog is a durable projection, diffed by a digest over the published entries rather than the rendered prose, so the `<system-reminder>` framing can never force a republish and consumers never re-parse the `<available_skills>` block. Second, one canonical rendering serves both load paths — the tool result and the user-explicit injection — through `renderSkillContent` shared from `dsh-skill`, so the model sees the same `<skill_content>` shape regardless of who initiated the load.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, catalog and gesture pre-step listeners, rendering and digest |
| [`src/load.ts`](src/load.ts) | Load-time environment: `required_env` passthrough, `config` resolution, and opt-in inline shell expansion |
| [`src/template.ts`](src/template.ts) | Pure `${DSH_SKILL_DIR}` / `${DSH_SESSION_ID}` expansion shared by both load paths |
| — | No runtime invariant companion is published; this model-facing adapter has no independent lifecycle stream; execution relations are owned by the capability seam it calls. |

### Catalog lifecycle

At each eligible `agent/pre-step`, the plugin snapshots the calling session's skill catalog, applies exact `skill` tool visibility, filters to model-invocable skills, and compares a digest of the entries against the newest visible `skill-catalog` message in the session log. When the digest changed, it hands the `enter` decision a durable user-role message containing the complete replacement catalog; an empty replacement explicitly retires earlier names. An incomplete provider snapshot emits nothing and preserves the last-good view for the next pre-step. The visibility check compares against the exact tool definition this plugin registered, so a scoped same-name shadow removes both the schema and its guidance; the plugin works mounted globally or inside one agent's composition.

### Invocation boundary

The `/name` gesture listener scans only claimed user messages: a whitespace-bounded token naming a user-invocable skill in the workspace catalog injects the same `<skill_content>` rendering as a `user`-role instructions context appended after every other injection. Unknown names and user-disabled skills stay ordinary prose. This is the only entry point for `disable-model-invocation` skills, which the catalog and the `skill` tool never expose.

### Load-time expansion

Both load paths share one resolution and rendering step (`src/load.ts`) before `renderSkillContent` frames the body. Resolution forwards every `required_env` name from the host environment, computes the config values from the deployment's `skills.config.<skill>` map over the skill's own declared defaults, and reads `metadata.shell`/`metadata.shellTimeoutMs`; any missing name, missing value, or malformed `metadata` value becomes the explanatory load error instead of a partially resolved load. The tool throws that error and the user-explicit injection warns and skips the skill for that step, so a misconfigured skill never silently loads without what it declared.

Rendering then expands `${DSH_SKILL_DIR}` to the skill's own directory (the dirname of the skill's absolute `SKILL.md` `path`) and `${DSH_SESSION_ID}` to the loading agent's session id (`exec.agent?.session.id` in the tool, `agent.session.id` in the pre-step injection). Each remaining `${...}` sequence resolves to a declared config value first; only when the skill set `metadata.shell: true` does an undeclared sequence run as a shell command, once per distinct command, from the skill's directory with the resolved environment through the mounted `ctx.shell` executor. Any other sequence stays verbatim, as does a variable without a value: virtual skills carry no `path`, so they leave `${DSH_SKILL_DIR}` unexpanded, and a tool call without a loading agent leaves `${DSH_SESSION_ID}` unexpanded. Inline shell output is capped at 4000 characters; a failing, timed-out, aborted, or unmounted-shell command renders empty and warns on the host log, so a broken command never leaks its partial output into the model's instructions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry vocabulary behind the catalog to the exact tool schema and the design rationale.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider vocabulary behind the catalog.
- [skill package](../skill/README.md) — the registry and the shared `renderSkillContent` rendering.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill) — the exact `skill` schema the model receives.
- [User-explicit skill invocation Agent Note](../../../.agents/notes/archived/feature/2026-08-08-user-explicit-skill-invocation.md) — the `/name` gesture design.

-----

<a id="model-experience"></a>
## Model Experience

### Session catalog

#### What the model sees

If model-invocable skills exist and this exact `skill` tool is visible, the agent receives the catalog template below as a durable user-role message before the first request, with one data-dependent entry per sorted skill. Later membership, description, or visibility changes append a complete replacement using the same `<available_skills>` envelope; deleting every skill appends an empty envelope with an explicit instruction not to use older names. The template's closing sentence is the rule against double-loading: the user-explicit gesture boundary (the pre-step listener below) injects the same `renderSkillContent` output (shared from `@deepseek-ai/dsh-skill`) inline, and the catalog tells the model to follow that block instead of re-loading the skill through the tool; the replacement-catalog template carries the same anti-double-loading rule in both arms, including the emptied catalog.

##### Skill catalog template

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

#### Token effect

Repeated input cost scales with skill count and `catalogDescriptionMaxLength`; no initial catalog tokens are sent when the list is empty or the tool is hidden or shadowed. Each actual catalog change adds one retained complete replacement message.

#### KV Cache effect

The initial durable catalog is appended after the existing reusable prefix. Dynamic changes are append-only history after that catalog, so earlier reusable tokens stay intact while each newly appended catalog and later turns form a new suffix. A new or resumed instance with a changed digest may affect cache reuse from the newly appended catalog position.

### Tool schema

#### What the model sees

The model sees the generated [`skill` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill).

#### Token effect

Fixed schema cost per request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged. Shadowing, restrictions, or plugin lifecycle changes may invalidate reuse from this schema.

### Tool result

#### What the model sees

A successful call uses the result template and the provider-managed, directory, URL, or opaque resource guidance below. The `<provider-owned-instruction-body>` is the skill body after load-time resolution and expansion: declared config values and `${DSH_SKILL_DIR}`/`${DSH_SESSION_ID}` are replaced where values exist, an opted-in skill's inline shell commands are replaced by their capped output, and any other `${...}` sequence — including `${DSH_SKILL_DIR}` for virtual skills without a path — stays verbatim.

##### Skill result template

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### Provider-managed resource guidance

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### Directory resource guidance

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL resource guidance

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### Opaque resource guidance

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token effect

Loaded instructions are data-dependent tool-result tokens, resent on later steps until compaction; no duplicate `agent.inject()` copy is made.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Invalid or stale selections return exactly `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. A skill whose declared `required_env` name is unset, whose declared config key has no value, or whose `metadata.shell`/`metadata.shellTimeoutMs` is malformed returns one explanatory `Error: skill "<name>" requires …` naming what is missing. Provider-thrown lookup text is data-dependent and receives the same `Error: <message>` wrapper.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### User-explicit invocation injection

#### What the model sees

A whitespace-bounded `/name` token anywhere in a claimed user message, naming a user-invocable skill in the workspace catalog, injects that skill's full `<skill_content>` rendering (the exact result-template shape above) as a `user`-role instructions context appended after every other injection of that step — background first, the material to act on last. Only direct user input is scanned, the check runs on the loaded definition, and unknown or user-disabled names stay ordinary prose. This is the sole entry point for `disable-model-invocation` skills, which the catalog and the `skill` tool never expose; the catalog's closing sentence tells the model to follow the injected block instead of re-loading it. The injected body carries the same load-time template expansion as a tool load.

#### Token effect

Each gesture adds one rendered skill body to that turn as injected context — the same size as the tool result for the same skill, paid deterministically at the user's request instead of at the model's discretion. Repeated gestures for one skill within one step inject once.

#### KV Cache effect

Append-only; the injection lands after the reusable request prefix inside the step's message batch and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the catalog or the loader is a poor fit. They are current package constraints, not a task backlog.

- **The catalog omits `whenToUse`, source, and provider metadata** — routing is based only on name and a capped description; `whenToUse` remains provider metadata and is not rendered by the loaded wrapper either.
- **Loaded instruction bodies have no size cap** — a provider can return a skill large enough to consume substantial next-step context; only catalog descriptions are truncated.
- **Resources are guidance, not attachments** — the tool reports a base directory/URL/opaque hint but neither enumerates nor fetches referenced files for the model.
- **Loading is one-shot text** — there is no partial, streaming, or cached-content handle when a remote provider is slow or a skill body is large.
- **Catalog replacement is whole-list** — one changed name or description appends every visible summary; this keeps stale-name retirement explicit but costs tokens proportional to the catalog.
- **Bodies are not versioned** — body-only edits do not change the catalog digest or notify the model; a later tool call reads the current provider content while earlier tool results remain historical facts.
- **An unloadable skill stays cataloged** — a skill whose declared `required_env` or `config` cannot resolve is still advertised; the failure appears only when the model or user tries to load it.
- **Inline shell trusts the skill author** — opting in runs `${...}` sequences as commands in the mounted executor's environment, bounded by the character cap and timeout but not by any allowlist; only skills the deployment trusts belong in its discovery roots.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

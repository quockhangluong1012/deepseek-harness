---
description: "Model-facing subagent delegation tool for users and maintainers configuring, composing, or debugging delegation over a subagent provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent

English | [中文](README.zh.md)

## Summary

Use this package to give an agent a named tool that delegates work to a configured child-agent backend. In `one-shot` mode, calls wait for the child by default; in `continuable` mode, they start a persistent child in the background and return an id for later messages. Supported backends can also expose approved child LLM providers, models, and reasoning effort for selection. Each instance can set child persona, tool access, and depth limits, while failed runs return errors instead of partial success.

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

Mount one instance per delegation target, each with a distinct `toolName`. The tool exists exactly while its provider does, so sibling load order and provider reloads never strand it.

### Minimal configuration

Load the subagent service, an in-process or remote backend, and this tool; then name the provider. This composition exposes a `subagent` tool that delegates to the `spawn` backend:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Provider name on `ctx.subagents` (e.g. `spawn`, `fork`, `acp`) |
| `toolName` | `subagent` | Model-facing tool name; distinct for every loaded instance |
| `modelSelectionSettings` | `false` | Sample the Host's exact-route authorization preference for each top-level Session; a standing preset observes matching Sessions, while direct Agent setup passes its Session explicitly; requires provider `agentOptions` support |
| `enableRunInBackground` | `true` | Expose `run_in_background`; disabling also rejects forced background calls |
| `backgroundMode` | `one-shot` | Background policy: `one-shot` defaults calls to foreground; `continuable` defaults them to background and requires the provider's `prepareContinuable` capability |
| `agentOptions` | — | Configured child `provider`, `model`, adapter-owned `reasoningEffort`, and positive `maxTokens` defaults; requires provider `agentOptions` support and overlays any provider-owned route defaults |
| `persona` | — | Per-child persona; requires the provider's `persona` capability |
| `toolFilter` | — | Per-child global-tool restriction; requires the `toolFilter` capability |
| `agentDirs` | the well-known project and user agent directories | Directories searched for file-defined agents (`*.md`), each layer in the listed order; an empty list disables that layer |
| `maxDepth` | Host setting (`1`) | Absolute delegation-depth cap (`0` forbids delegation); `'provider-managed'` sends no cap to an out-of-process provider |
| `maxPartialTextChars` | `8000` | Maximum chars of child partial output included in a parent-facing failure |
| `delegation` | no bound, every role, no duplicate detection | Delegation policy for every child this instance spawns: `maxDepth`, `maxChildren`, `maxConcurrent`, `maxCost`, `maxTokens`, `allowedRoles`, `duplicateTaskDetection`, `resultSchemaRequired` |
| `usdPerMillionTokens` | — | USD per million billed tokens; required by any ceiling priced in dollars (`delegation.maxCost` or a role's `budget.maxCostUsd`), because the harness owns no per-route price data |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent) is the exhaustive source for every accepted field and its JSDoc.

### Foreground and background modes

Under `one-shot` policy, an omitted `run_in_background` waits in the foreground and returns the child's final text; `run_in_background: true` starts a plain parent-owned background job and returns `started background subagent job <id>`, collected with `job_output` and stopped with `job_kill`.

Under `continuable` policy, an omitted or `true` `run_in_background` starts a durable child and returns `started subagent <childId>` without waiting for a result; the runtime delivers one settlement notice when the child's Activation ends, and the optional `send_message` tool sends it more work. Set `run_in_background: false` to wait for the result in the foreground.

`maxDepth` caps recursion (`0` forbids delegation); omission reads the current Host `subagent.maxDepth` setting, initially `1`, at each delegation. A numeric depth requires a provider with the `depthLimit` capability; `'provider-managed'` leaves the budget to an out-of-process provider. `persona` and `toolFilter` configure every child when the provider supports them, and the tool stays visible at the cap — each attempted start checks the calling agent's current depth and rejects with an errored result.

### File-defined agents

The tool also reads agent definitions from the deployment's project root (`agentDirs.project`, default `.dsh/agents`, `.claude/agents`, `.opencode/agents`) and from the home directory (`agentDirs.user`, the same three names). Each root holds flat `*.md` files; a project root wins over a user root, and inside one layer the earlier root wins. A definition is optional frontmatter plus a body the child never reads:

```yaml
---
name: code-reviewer
role: reviewer
description: Reviews a diff for defects
tools: read, grep, bash
model: alpha/reviewer-model
permission:
  edit: deny
budget:
  maxTokens: 50000
  maxCostUsd: 1.5
maxTurns: 8
outputSchema: code-reviewer.schema.json
---
```

`name` defaults to the file name, `description` is one plain value, `model` is `provider/model`, a bare model id that keeps the configured provider, or `inherit`, `tools` is a comma-separated list, an inline list, or an indented `tool: true|false` mapping, and `permission` is an indented `tool: allow|ask|deny` mapping. Tool names are the harness's global tool names; Claude Code's capitalized spellings map mechanically (`WebFetch` → `web_fetch`).

The remaining fields declare the worker role: `role` names the policy role this definition is admitted by (`allowedRoles`) and defaults to `name`; `budget` is an indented map of the child's `maxTokens` and `maxCostUsd` ceilings; `maxTurns` caps the turns the child may open; and `outputSchema` names a file, relative to the definition, holding the object-rooted JSON Schema the child must satisfy. The role's ceilings and `maxTurns` become the child's worker limits, and the dollar ceiling is handed over with the instance's `usdPerMillionTokens` as the price it is measured at; a role that declares a dollar ceiling where the instance declares no price fails the call rather than dropping the ceiling. A call's own `output_schema` answers for that child, and the role's schema is the fallback; the schema requires a foreground run. A role's memory scope is deliberately not declarable: the harness exposes no per-child memory-scope control, and a field that changes nothing would read as a control the deployment does not have.

A call that names one with the optional `agent` parameter applies that definition to that child alone: `tools` and every `permission: deny` entry become the child's tool restriction, intersected with the instance `toolFilter`, and `model` overlays the configured child route. A call naming no agent delegates exactly as before. An unknown name fails the call and reports the available agents and the searched directories; a definition the loader cannot read is skipped with a diagnostic, so it never fails another agent's delegation. `permission` entries other than `deny` are recorded on the definition but not enforced yet — see [Known Limitations](#known-limitations-and-deferred-work).

### Delegation policy and task overlap

<a id="delegation-policy-and-task-overlap"></a>

`delegation` bounds every child this instance spawns. The policy is resolved once per delegation from this configuration (`DELEGATION_POLICY_DEFAULTS` supplies the rest), and it is enforced before the provider is asked for a child:

| Axis | Effect |
|---|---|
| `maxChildren` | Children one parent may spawn over its session; the next one is refused. |
| `maxConcurrent` | Children of one parent in flight at once; the next one is refused while that many run. |
| `allowedRoles` | Roles a spawn is admitted by, matched against a definition's `role` or its `name`. Empty admits every role; a non-empty list refuses a spawn that names no role. |
| `resultSchemaRequired` | Whether every admitted spawn must carry an output schema, from the call's `output_schema` or the role's `outputSchema`. |
| `maxDepth` | Child-depth cap passed to the provider. Omitted, the instance's `maxDepth` (Host setting at each delegation) answers; declaring both with different values fails the mount. |
| `maxCost` / `maxTokens` | Per-child ceilings handed over as the child's worker limits; a role's own `budget` narrows them. |
| `duplicateTaskDetection` | Whether a spawn is compared against this parent's children before it is admitted. |

A refusal is an errored result carrying the reason ("the role … is not one of the roles this delegation policy allows", "this delegation policy allows 1 children in flight, …") rather than a silent skip.

With `duplicateTaskDetection` set, the objective a delegation carries (`description`) is compared against the parent's in-flight and recently completed children by the Dice coefficient of their content words — deterministic, no model call, no filesystem read. Above 0.9 similarity a completed child's retained result answers the call instead (`Reused the result of the subagent that already ran "…"`), an in-flight child makes the call an error naming that child (send it the added work, or wait for it), and a lesser overlap at or above 0.55 spawns a child whose prompt is scoped to what the earlier child did not cover. An identical completed task whose result this process no longer holds is refused instead of silently repeated. Below 0.55, and whenever the switch is off, the spawn proceeds unchanged.

### Selecting a child LLM

Set `modelSelectionSettings: true` to sample the Host's `subagent-model-selection` preference when each fresh top-level Session is composed. A restored Session without a recorded policy remains disabled, including an explicitly empty restore. When enabled, the non-empty exact provider/model route list is recorded in the Session, inherited by child Sessions, and unchanged by later settings edits. The tool then exposes optional `provider`, `model`, and `reasoning_effort` fields and registers the shared `list_subagent_models` tool. This mode requires a backend that advertises `agentOptions`; both in-process backends and DSH SDK support it, while ACP, Codex, and Claude Code reject it rather than ignore it.

A call supplies `provider` and `model` together, or supplies only an effort when configured, parent, or provider-owned defaults provide the route. Static `provider.agentRouteDefaults`, when present, form the provider/model baseline; tool configuration and model fields overlay it before route-aware effort merging and exact-route preflight. Providers without these defaults use compatible values from the parent's latest logged request, then the parent's creation options before its first request, while retaining the configured `maxTokens`. Changing the route without an explicit effort clears the inherited route-owned effort, so the selected model resolves its default. The live LLM adapter validates the effective route before child creation. Catalog membership remains advisory, so a model can use an unlisted id when its adapter accepts it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool mirrors provider lifecycle and settles runs; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

One instance is one provider plus one tool name. The plugin mirrors provider lifecycle: it registers the tool when the named provider appears and disposes it when the provider leaves, so sibling load order and HMR replacement cannot strand a dangling tool. Direct Agent setup passes its unpublished Session explicitly and awaits installation before publication. A settings-backed standing preset receives each matching Agent through `agent/created`, selects policy from its Session, and awaits installation through its Context; installation failure rejects creation. A numeric `maxDepth` or configured LLM selection the provider cannot enforce fails the mount instead of the first delegation. At most one instance in a tool scope may own model selection because `list_subagent_models` has a global name.

### Foreground settlement

A foreground call awaits `run.result`, maps every non-completed stop reason to an error headline, appends the provider diagnostic and any preserved partial assistant text, and always awaits `run.dispose()` before returning; when result collection and disposal both reject, the errored result preserves both failures.

### Background routes

One-shot background registers a plain parent-owned Task whose done channel settles the start and keeps the stop reason and optional provider diagnostic in its detail. Continuable background calls `ctx.subagents.startContinuable()`, which resolves at inbox acceptance: the child owns its own turns from there, so the call neither waits for nor collects a result.

### Context-sensitive wording

The tool's description derives from `provider.inheritsParentContext`: a fresh child gets "it does not see this conversation" wording, a forked child gets "it does not see the current in-flight turn" wording, so the model never restates or omits context that does not exist.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool registration, lifecycle mirroring, mode resolution, policy admission, result settlement |
| [`src/agent-files.ts`](src/agent-files.ts) | File-defined agent discovery, frontmatter compilation, and tool-filter merge |
| [`src/delegation-children.ts`](src/delegation-children.ts) | What one parent session has spawned: caps, overlap candidates, retained results |
| [`src/model-selection.ts`](src/model-selection.ts) | Request/config merge and live LLM route preflight |
| [`src/model-selection-settings.ts`](src/model-selection-settings.ts) | Host-owned opt-in setting sampled for new Sessions |
| [`src/model-selection-state.ts`](src/model-selection-state.ts) | Session event that records and inherits the sampled decision |
| [`src/list-models.ts`](src/list-models.ts) | `list_subagent_models` runtime discovery tool |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool's runtime behavior to the seam it delegates over and the adjacent child tools.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — providers, one-shot start requests, continuable children and activations.
- [dsh-tool-subagent-control](../tool-subagent-control/README.md) — messaging, interrupt, and listing tools for continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) — the default schema and per-mode wording.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent) — every accepted config field.
- [Background-first continuable delegation](../../../.agents/notes/archived/feature/2026-08-11-background-first-continuable-delegation.md) — why continuable work defaults to background.
- [Model-selected subagent routes](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md) — selection policy, inheritance, discovery, and the fork restriction.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The delegation description uses `running` and `inactive` for follow-up availability; `inactive` does not imply a task result. While its provider exists, the tool exposes the generated default [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent) under this instance's configured name, including the optional `agent` parameter that names a file-defined agent; an unknown name returns the available agents and the searched directories. An enabled Session policy adds `provider`, `model`, and `reasoning_effort` plus inheritance and selection guidance; the provider must support `agentOptions`. Provider context inheritance changes the tool and prompt descriptions. Enabled background mode adds `run_in_background`: continuable mode documents its `true` default, runtime settlement notice, and explicit foreground override, while one-shot mode documents its `false` default and the job id collected with `job_output` or stopped with `job_kill`. An optional `output_schema` accepts an object-rooted JSON Schema for a structured final answer on foreground one-shot runs; the child must then call `structured_output` with a matching value, which returns as `structured` alongside the text. While the tool is visible in an assembly's scope, a `tool:<toolName>` system-prompt section tells the model to start independent continuable delegations together, keep working while they run, and choose foreground only when its next action depends on the result; a tool restriction removes both its schema and this guidance.

#### Token effect

Fixed schema cost per parent request: one always-present `agent` parameter, plus three more when model selection is enabled. Each provider instance adds one schema, and each continuable instance adds one short system-prompt section.

#### KV Cache effect

Prefix-stable while provider instances and their configuration are unchanged. Adapter catalog changes do not alter the definition; a child route override may prevent a fork child from reusing the inherited parent prefix.

### Model selection and discovery

#### What the model sees

A settings-controlled instance whose Session carries a policy exposes the child LLM selection fields and `list_subagent_models`. Calls reject while the optional `ctx.llm` service is unavailable. Discovery returns only registered providers and advertised models in the exact route policy; an unauthorized provider is rejected before its adapter catalog is called, and an exact lookup must be allowed before it resolves the model's reasoning efforts and default. Execution independently enforces the same policy.

#### Token effect

One fixed discovery schema is present in enabled compositions. Directory contents enter the transcript only when the model calls the tool.

#### KV Cache effect

The schema is prefix-stable across adapter registration and catalog changes. Each discovery result is appended after the reusable prefix.

### System prompt

#### What the model sees

When `enableRunInBackground` and `backgroundMode: continuable` are both set, the model additionally reads a `tool:<toolName>` system-prompt section telling it to start independent continuable delegations together and keep working while they run. With the default tool name `subagent`, the section text is:

##### Tool-guidance section

```markdown
Use subagent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.
```

#### Token effect

One short fixed section per continuable instance, paid on every parent request while the tool is in scope.

#### KV Cache effect

Prefix-stable while the section text and tool presence are unchanged; removing the tool or changing the section establishes a different parent prefix.

### Foreground result

#### What the model sees

The call retains the description and prompt. Success contains only the child's final text; when `output_schema` was supplied, the validated structured value follows as `Structured result: <json>`. A spawn the delegation policy refuses, and a duplicate served by an in-flight child, return `Error: <reason>` before any child starts, and a re-run of a completed task returns that child's result — see the Delegation policy and task overlap section above. Other outcomes become `Error: <stop reason>`, followed by a safe provider diagnostic when present and then any partial assistant text (capped at `maxPartialTextChars`, default 8000 chars). Intermediate child steps stay out of the parent.

#### Token effect

The prompt and result remain in parent history until compaction; child working context remains in the child.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background result

#### What the model sees

Start returns exactly `started subagent <childId>` in configured continuable mode, or `started background subagent job <id>` in configured one-shot mode. In one-shot mode the generic task surface provides later status, final output, cancellation responses, and notices; failed status detail includes the provider diagnostic when the result supplied one. In continuable mode this tool returns no result of its own: the child's settlement reaches the parent as a service-owned notice, an independently loaded `send_message` tool delivers follow-ups, and the child's transcript by its id is the source of its detailed output.

#### Token effect

The acknowledgement is retained; a one-shot final output enters parent history only when collected or injected, while a continuable child's output never returns through this tool — its settlement notice arrives independently of any tool result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what this tool does not return or enforce; they are current package constraints.

- **Background runs expose no result through this tool** — a one-shot task's final output is collected through the generic task surface, and a continuable child's output stays in its own session, read by its subagent id. The settlement notice states how that child ended and carries nonempty text from its final assistant output, but it is not this call's return value and cannot be awaited here.
- **Duplicate names across waiting one-shot instances are detected late** (`TODO(subagent-dup-toolname)`) — continuable instances reserve their prompt-section name during plugin application, but preventing provider-registration rollback for waiting one-shot instances requires a registry of intended names.
- **Shipped fork tools cannot select a child LLM route** — they inherit the parent's provider and model to keep the copied conversation prefix eligible for KV Cache reuse. Re-enable selection only when route changes preserve reuse or expose a bounded recomputation cost.
- **Non-routing child policy is fixed per instance** — another persona, tool filter, or depth cap requires another distinctly named tool. LLM selection requires an enabled per-Session preference and a provider that advertises `agentOptions`; both in-process providers and DSH SDK advertise it, while ACP, Codex, and Claude Code reject it rather than ignore it.
- **`permission` decisions above tool access are not enforced** — a definition's `deny` entries restrict tools, and its `allow` and `ask` entries are recorded on the parsed definition with one diagnostic per file. Enforcing them needs a per-child permission document the child's own authorization reads, which neither the start request nor the delegation receipt carries.
- **Child ceilings require a provider that declares `workerLimits`** — a policy ceiling fails the mount and a role ceiling fails the call when the selected provider cannot enforce child worker limits, so a bound the harness cannot apply is refused rather than accepted and ignored. Shipped out-of-process providers declare no such capability.
- **Child caps and overlap detection are process state** — the boundary remembers what it spawned for each live parent Session, so a restarted process starts with no child history: the first delegation of a session is admitted as if it were the first, and a child that completed before the restart is not a reuse candidate. Durable reconstruction would need a session projection over child creation, which this tool does not register.
- **File-defined agents reach the model only through a failed call** — the roster is not rendered into the prompt or the tool description, so a parent learns the available names from the unknown-name error. Rendering a per-Session catalog needs the Session working directory at registration, which this tool does not have.
- **A definition is read on every delegation that names an agent** — discovery has no watcher, so an edited file applies to the next delegation and a large `agentDirs` list pays its directory reads per call.
- **Only `.dsh/agents`, `.claude/agents`, and `.opencode/agents` spellings are recognized** — frontmatter is a documented scalar/list/mapping subset rather than full YAML, so a definition using anchors, nested mappings, or block sequences is skipped with a diagnostic.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "Human-facing /memory, /skills, /journey, /curator, /refine, /trajectory, /learn, and /suggestions commands governing staged evolution writes, scope activity, session export, and skill curation (ctx.commands), for hosts governing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-evolution

English | [中文](README.zh.md)

## Summary

`dsh-command-evolution` adds the human governance surface for the evolution harness to chat UIs: `/memory` and `/skills` govern staged writes, `/journey [today|7d|30d|all]` shows the scope's recorded activity, `/curator status|run [--dry-run]` shows curation bookkeeping and runs one maintenance pass, `/refine` rebuilds the scope's lessons, `/trajectory` exports the session or scope, `/learn` starts a research-and-save turn, and `/suggestions` lists blueprint-backed skills without scheduling them. Every command but `/learn` answers directly; `/learn` queues one ordinary turn. Choose them when a human must see and govern what background review proposed before it lands.

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

Type `/memory` or `/refine` in a chat UI when background review staged proposals for the current workspace scope. Scopes resolve the injector way — registry session ids first, falling back to a canonical-path `cwd` match — under the required `profile`; sessions outside any workspace get `This session is outside any workspace scope.` instead of a guess.

### Configuration

`profile` is required: the deployment must name which scope namespace the commands govern. Scopes never share a default namespace.

```yaml
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

| Field | Default | Meaning |
|---|---|---|
| `profile` | required | Scope-identity namespace placed before the workspace key |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-evolution) is the exhaustive source for every accepted field.

### Using the commands

| Input | Result |
|---|---|
| `/memory`, `/memory pending` | List the scope's staged entries as `- <id> [<kind>:<op>] <gist> (session '<origin>', <instant>)`, or `No pending writes.` when nothing awaits approval. Bare `/memory` reports the same list. |
| `/memory approve <id>` | Apply one memory-kind entry and report `Approved staged <op> (<gist>).`; an unknown id reports `No staged write '<id>'.`; a skill-kind id is redirected to `/skills approve`. |
| `/memory reject <id>` | Drop one entry without applying it and report `Rejected staged write '<id>'.`. |
| `/memory <anything-else>` | `Usage: /memory pending \| approve <id> \| reject <id>` — the grammar is fixed. |
| `/skills`, `/skills pending` | List the scope's staged skill entries, or the empty state naming where proposals come from. Bare `/skills` reports the same list. |
| `/skills approve <id>` | Drop a staged skill entry whose skill write already landed and report the approval with that reminder; an id that is not a staged skill reports `No staged skill '<id>'.`. |
| `/skills <anything-else>` | `Usage: /skills pending \| approve <id>`. |
| `/journey [today\|7d\|30d\|all]` | Render the scope timeline: the window header, one line per active day, capacity and digest, and the staged count. Bare `/journey` reports `7d`. |
| `/journey <anything-else>` | `Usage: /journey [today \| 7d \| 30d \| all]`. |
| `/curator status` | Render the last pass instant, tracked-skill counts by lifecycle state with pins, and the newest recorded pass. |
| `/curator run` | Run one maintenance pass now: report the movements, skip counts, and snapshot id. |
| `/curator run --dry-run` | The same pass previewed without writing; the snapshot line reads `Snapshot: none`. |
| `/curator <anything-else>` | `Usage: /curator status \| /curator run [--dry-run]`. |
| `/refine` | Rebuild the scope's lessons through the reviewer and report `Memory rebuild complete.`. |
| `/refine <anything>` | `Usage: /refine (no arguments)` — the command takes no arguments. |
| `/trajectory` | Export the invoking session through the trajectory service and report `Trajectory written to <path> (<n> conversations, <n> bytes).`. |
| `/trajectory --out <path>` | The same export written to the given path. |
| `/trajectory --all` | Export every session of the invoking workspace's scope instead of the current session. |
| `/trajectory <anything-else>` | `Usage: /trajectory [--out <path>] [--all]`. |
| `/learn <anything>` | Build a research-and-save prompt and queue it as one ordinary turn: `Started a learning turn for '<topic>'. The skill lands only through the gated skill_manage write.` |
| `/learn` | `Usage: /learn <anything>` — the command needs a topic. |
| `/suggestions` | List the skills whose frontmatter declares a blueprint, as `- <name>: <description> (schedule <schedule>, deliver <session\|file>)`, plus the reminder that nothing is scheduled. |
| `/suggestions <anything>` | `Usage: /suggestions (no arguments)`. |

### What you see

The commands turn each expected failure into a stable message you can show directly; the situation on the left is what produced the message on the right.

| Situation | Message you see |
|---|---|
| Session outside any workspace (scoped commands) | `This session is outside any workspace scope.` |
| Approving a skill-kind entry through `/memory` | `Staged skill '<id>' (<op>) is decided by '/skills approve <id>': write the skill with skill_manage first, then approve there to drop the entry.` — the entry stays staged. |
| A cap or substring rejection on approve | `Cannot approve '<id>' (<code>): <detail>. The entry stays staged.` |
| Approving or rejecting an unknown id | `No staged write '<id>'.` |
| `/skills approve` for an id that is not a staged skill | `No staged skill '<id>'.` |
| `/refine` without the reviewer mounted | `The evolution reviewer is not mounted.` |
| `/curator status` without the curator mounted | `The evolution curator is not mounted.` |
| A rebuild rejection | `Memory rebuild failed (<code>): <detail>.` |
| `/trajectory` without the exporter mounted | `The evolution trajectory exporter is not mounted.` |
| `--all` outside every workspace scope | `This session is outside any workspace scope.` |
| A rejected export | `Trajectory export failed (<code>): <detail>.` |
| `/suggestions` without the skill registry mounted | `The skill registry is not mounted.` |
| `/suggestions` with no blueprint-backed skill | `No blueprint-backed skills. A skill appears here when its frontmatter declares a blueprint; this command never installs the schedule it names.` |

Cancelling `/refine` stops the wait: the registry settles the invocation with the abort reason, matching the `/compact` cancellation contract. Failures other than these expected cases surface as errors rather than being silently converted.

### Composing the commands

Mount the command registry, a workspace registry, and the evolution memory store; `/refine` needs the reviewer, and `/curator` reads the curator plus skill telemetry when they are mounted:

```yaml
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-workspace'
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-evolution-reviewer'
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

Surfaces without `ctx.commands` cannot invoke them; staged writes then wait for a mounted command adapter or the controller. `/curator status` is host-wide and works from any session, including one outside every workspace scope; the curator, telemetry, trajectory exporter, reviewer, and skill registry are optional services read through `ctx.get`, so a deployment without them still gets the command with an honest short answer.

### What happens to the conversation

Approving applies the staged memory op through the store's own write chain, so cap and substring rejections keep the entry staged exactly as a direct store call would; rejecting drops either kind. The command lifecycle is recorded in the session log but never enters model history. `/learn` is the one command that starts a turn: it queues a prompt-authored message as the sole ordinary message of its own turn, and the model then gathers material with the tools it already has and proposes one skill through the gated `skill_manage` writer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the commands; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The commands are built on five commitments:

- **Governance without new durable state.** The plugin owns no domain: pending lists and the journey read the scope record (and the curator reads its own ledger through the curator service), mutations delegate to `approveStaged` / `rejectStaged`, rebuilds forward scope plus signal to `evolutionReviewer.rebuild`, exports forward the session or scope to `evolutionTrajectory`, and suggestions read the skill catalog. The store stays the single authority.
- **The approver performs skill writes first.** Approving a skill-kind entry only drops it in the store, so `/skills approve` says so: the human writes the skill (via `skill_manage`), then approves to drop the entry, and `/memory approve` redirects skill-kind ids there. Nothing is silently discarded or silently applied.
- **Reads report only what the record proves.** `/journey` emits a delta per fact the record carries — each document family from its own write stamp, every context item, every indexed output, every staged entry — and counts each decided entry on the day its decision landed, on the dashboard's UTC+7 calendar; it never guesses which field an unexplained `updatedAt` moved.
- **Queueing is not writing.** `/learn` builds a prompt and queues one ordinary turn; the command itself writes nothing, so the only save path is the proposal-gated `skill_manage`. `/suggestions` reads blueprints and schedules nothing.
- **Quiescent teardown.** The lifecycle effect unregisters the commands before draining already-started handlers, so root teardown cannot pass an in-flight rebuild the way `/compact` cannot pass an aborted compaction.

### Membership and scope

Scope resolution copies the injector's membership rule without its cache — commands are one-shot, so registry session ids plus the canonical-`cwd` fallback run per invocation with no retained state; `/curator status` is host-wide and resolves no scope at all. The `profile` gate matches the injector's: empty or `:`-carrying namespaces fail plugin load loudly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command registration, scope resolution, staged failure mapping, export failure mapping, the `/learn` prompt builder, blueprint parsing, lifecycle drain |
| [`src/journey.ts`](src/journey.ts) | Pure `/journey` read model: per-family and context/output/staged deltas, decided-entry counts, day buckets, cumulative accounting, rendering |
| — | No invariant companion is published; this command adapter owns no state or event stream; the evolution memory store owns the single durable domain table and the command registry owns registration and dispatch lifecycle. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the commands to the store, the reviewer, and the design decisions.

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract these commands govern.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Commands package](../../interaction/commands/README.md) — the registry and dispatch contract behind chat commands.
- [Usage ledger](../../session/usage-ledger/README.md) — the UTC+7 calendar and window helpers the journey buckets with.
- [Improvement roadmap](../../../specs/improvement.spec.md) — the Phase 6 CLI slice these commands land (`/suggestions` remains planned).

-----

<a id="model-experience"></a>
## Model Experience

### Human governance commands

#### What the model sees

The slash inputs and the direct results (such as `No pending writes.`) never enter a model request. An approved memory write separately reaches the model later as part of the injected evolution brief; a rebuild rewrites the stored lessons the next brief renders. `/learn` is the exception by design: its prompt-builder output is queued as an ordinary user-role turn, so the model sees exactly the research-and-save instruction the command built — including the reminder that the `skill_manage` write is proposal-gated.

#### Token effect

The command lifecycle adds no model tokens; results are human-only command text. `/learn` starts a turn, so it spends the same tokens any other turn on that prompt would.

#### KV Cache effect

Discovery and command bookkeeping do not affect the cache. An approved lessons change invalidates reuse from the next injected brief, exactly as a direct store write would.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the commands are a poor fit; they are the current package constraints.

- **No skill-write application** — `/skills approve` drops a staged skill entry; the skill file is written by `skill_manage`, and the command never writes skill files itself.
- **`/learn` depends on the gated writer** — the command only queues a turn; if the composed agent has no `skill_manage` (or no gathering tools), the turn cannot save anything, and the prompt says so instead of pretending a skill landed.
- **`/suggestions` only suggests** — it reads blueprints and schedules nothing; installing the cron entry a blueprint names stays a separate, deliberate act by the human.
- **Blueprint reader tolerates two surfaces** — a skill's blueprint is read from the parsed frontmatter field, or from the frontmatter bag it was parsed from, because discovery publishes one of the two; an unaccepted shape is simply not suggested.
- **Exports need the exporter** — `/trajectory` reports `The evolution trajectory exporter is not mounted.` when the composition omits it, and the export itself owns the file layout.
- **One scope per invocation** — the scoped commands govern the invoking session's scope only; there is no cross-scope view (only `/curator status` and `/suggestions` are host-wide).
- **Command adapters only** — surfaces without `ctx.commands` cannot invoke them; staged writes then wait for a mounted adapter or the `evolutionController` Remote namespace.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Injector membership convergence, undecided** — scope resolution duplicates the injector's membership rule without its cache. Extracting one shared helper (owned by the memory package or the workspace registry) waits until a third consumer needs it; two copies with one noted owner is cheaper than a premature seam.

</details>

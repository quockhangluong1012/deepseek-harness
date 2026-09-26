---
description: "Scheduled routines that start a new Workspace-backed Session on a fixed cadence while the harness runs, managed by the human /routine command."
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule-routines

English | [中文](README.zh.md)

## Summary

`dsh-schedule-routines` stores routines — a saved prompt, a workspace, and a fixed cadence — and starts a brand-new Session each time one comes due, so an unattended request runs under its own title and history instead of interrupting whatever the user was doing. Routines live in one durable document, keep their own preset and permission scope, and are managed with the `/routine` command. They run only while this process is up: a due instant that passes during downtime is skipped rather than replayed.

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

Mount `dsh-schedule-routines` on the Host that runs unattended work — the shipped Web bundle and therefore the Desktop app already do — and let users create routines with `/routine`. It needs the Workspace registry, the storage domain, the agent, preset, permission, and title services, and the command registry.

### Command reference

| Input | Result |
|---|---|
| `/routine` or `/routine list` | List every stored routine as `- <id> every <minutes>m: <title> (<next instant>\|paused)`, or `No routines.` |
| `/routine add <minutes> <prompt>` | Create a routine in the invoking session's working directory, titled from the prompt, due one cadence from now |
| `/routine pause <id>` | Stop a routine from starting Sessions; its cursor stays where it was |
| `/routine resume <id>` | Let a routine start Sessions again |
| `/routine remove <id>` | Delete a routine; Sessions it already started are untouched |
| anything else | `Usage: /routine \| /routine add <minutes> <prompt> \| /routine pause <id> \| /routine resume <id> \| /routine remove <id>` |

An unknown id reports `No routine '<id>'.`; an unsupported cadence, a relative workspace, or a blank prompt reports the specific rejection, never a silent success.

### Configuration

Routines inherit their composition from this plugin, so one deployment decides once how unattended work is composed. Every field is optional.

```yaml
- id: schedule-routines
  name: '@deepseek-ai/dsh-schedule-routines'
  config:
    tickSeconds: 30
    agentPreset: standard
    permissionPreset: workspace-write
    maxRoutines: 25
```

| Field | Default | Meaning |
|---|---|---|
| `tickSeconds` | `30` | Seconds between due-routine checks |
| `agentPreset` | `'standard'` | Agent composition every routine Session mounts |
| `permissionPreset` | `'workspace-write'` | Sandbox and approval preset routine Sessions run under |
| `maxRoutines` | `25` | Ceiling on stored routines |

Both presets are resolved at load, so a typo fails the mount instead of producing routines that never start a usable Session. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-schedule-routines) is the exhaustive source.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **One durable document, not session events.** A routine outlives any Session, so the whole list is one atomic record on the `workspace_routines` storage domain. Corruption backs the document aside and starts empty, because the alternative — failing the boot — would take the interactive product down with an unattended feature.
- **Starting a Session reuses the shared creation path.** `startWorkspaceSession` resolves the presets, creates the Workspace, creates the Agent, attaches the Session, applies the permission preset, titles it, and admits the routine's prompt as one ordinary user message carrying a `routine` source.
- **Downtime is skipped, not replayed.** Every enabled cursor that already passed moves to its next future instant before the timer starts, and a due routine advances past every occurrence between its last cursor and the current instant. A restarted app never opens a backlog of Sessions.
- **A failed start advances the cadence.** A routine is a schedule, not a retry queue: the failure is logged and the cursor moves on, so a broken routine cannot make the tick spin.
- **One start per routine at a time.** A routine already starting a Session is skipped by the next tick instead of queued behind itself.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `RoutineScheduler` service: durable list, tick, due evaluation, Session start, and the `/routine` command |
| [`src/spec.ts`](src/spec.ts) | The `workspace_routines` domain declaration and its state schema |
| [`src/types.ts`](src/types.ts) | Routine records, the create spec, and the stable rejection types |
| — | No runtime invariant companion is published; the store is a single document whose own schema validates at the durable boundary, and there is no second observation to compare it against. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session-local reminders](../schedule/README.md) — the in-session reminder feature this package deliberately is not: those messages stay in one conversation.
- [Workspace](../../workspace/workspace/README.md) — the project registry each routine Session is attached to.
- [Shared Session creation](../../workspace/workspace-session/README.md) — the creation path a routine and a webhook rule both use.
- [Storage domain](../../storage/storage-domain/README.md) — the durable document contract behind the routine list.
- [Commands service](../../interaction/commands/README.md) — the command registry the `/routine` command plugs into.

-----

<a id="model-experience"></a>
## Model Experience

### Routine prompt admission

#### What the model sees

The routine's prompt as the only content of the new Session's first `user/message`, in a Session that starts with empty history. The message carries a `routine` source with its identifier and a `notice` summary naming the routine, so a reader of the log can tell an unattended start from a typed request. The command's own output never enters any request.

#### Token effect

One user message per start, holding exactly the routine's prompt plus ordinary message framing. No routine prompt is added to the creating session, and the routine's Session then pays its own normal turn costs.

#### KV Cache effect

No effect on the creating session. The new Session's first request has an empty reusable prefix, so nothing cached is invalidated.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when a routine is the wrong tool. They are current package constraints, not a task backlog.

- **The process must be running** — routines fire from an in-process timer; a Desktop app kept alive by its tray keeps them firing, but a closed app skips every due instant that passes.
- **Fixed-rate cadence only** — `everyMinutes` repeats from the creation anchor; calendar expressions such as "weekdays at 09:00" are not interpreted, and the local-time rules the session-local reminder package implements are not reused here.
- **One workspace per routine, fixed at creation** — a routine's workspace path cannot be edited; removing and re-adding the routine is the supported change.
- **Starting is fire-and-forget** — the scheduler does not watch the Session it starts, so a routine whose prompt fails is not retried, summarized, or surfaced beyond the log warning for the failed start.
- **No client surface yet** — the shipped surfaces are `/routine` in a command-capable client and the service API; there is no dedicated settings page, list view, or badge.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

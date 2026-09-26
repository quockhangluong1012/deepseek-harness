---
description: "The human /init slash command that turns a request to document the workspace into one agent turn writing AGENTS.md."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-init

English | [中文](README.zh.md)

## Summary

`dsh-command-init` gives users the `/init` command, which asks the current agent to write this workspace's `AGENTS.md` from what is actually in the repository. The command submits one ordinary user message naming the facts to cover — what the project is, how to build, test, and lint it, the layout that matters, and the conventions that are easy to get wrong — and the agent does the reading and writing with its normal tools. Nothing is written by the command itself, so the workspace is only changed by the reviewable turn that follows.

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

Mount `dsh-command-init` in any deployment with a command adapter whose users want a guided first pass over an undocumented repository. The shipped base bundle already includes it, so base-backed profiles have `/init` without further configuration.

### Command reference

`/init` takes no arguments. Any non-empty input returns the usage error `Usage: /init`.

| Input | Result |
|---|---|
| `/init` | Queues one user message asking the agent to create or update the root `AGENTS.md` |
| `/init <anything>` | Returns `Usage: /init` and queues nothing |

### What the agent is asked to do

The submitted message tells the agent to cover the project's purpose, the commands that build, test, lint, and run it, the layout of the important directories, and the conventions that are easy to get wrong; to read the manifests, CI configuration, and existing documentation rather than guessing; to follow the repository's own documentation standard when it has one; and to report what it changed. The result is therefore a normal, reviewable turn — the workspace changes only through the agent's own tool calls.

### Minimal configuration

The command has no configuration fields. It needs only the command registry:

```yaml
- {name: '@deepseek-ai/dsh-commands'}
- id: command-init
  name: '@deepseek-ai/dsh-command-init'
```

Headless, ACP automation, and JSON-RPC apps register no command adapter and therefore cannot reach `/init`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **A prompt, not a writer.** The command owns one fixed instruction text and no file access. Everything the workspace sees afterwards comes from the agent's own tools and its normal approval path, so `/init` cannot half-write a file the user never reviewed.
- **Agent-scoped by the invocation.** The message is queued on the invoking agent's inbox, so the turn that answers it belongs to the session the user was working in, with that session's model, cwd, and permissions.
- **Grammar stays trivial.** A bare `/init` is the only accepted form; anything else is a usage error, which keeps the command's contract stable across adapters.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the fixed prompt, the argument grammar, and the command registration |
| — | No runtime invariant companion is published; the command owns no event stream or projection, and the queued user message is ordinary session history. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace instruction loader](../agent-instructions/README.md) — the package that turns the written `AGENTS.md` into model context, including `@path` imports and path-scoped rules.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.
- [Documentation standard](../../../docs/AGENTS.md) — what this repository expects an `AGENTS.md` to contain.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/init` request

#### What the model sees

One ordinary user-role message carrying the fixed instruction text. It arrives on the invoking agent's inbox like any other user prompt and is logged as a `user/message` event with the ordinary `user` source, so it replays, compacts, and renders exactly as a typed request would. The command contributes no prompt section, tool, or schema, and the adapter's direct reply to the user never enters a request.

#### Token effect

Exactly one user message per invocation: the multi-sentence instruction text plus the normal user-message framing. The agent's own exploration and file writes that follow are its ordinary tool calls and their results.

#### KV Cache effect

Append-only. The message follows the existing reusable request prefix and invalidates no cached entry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what `/init` does and does not do. They are current package constraints, not a task backlog.

- **No file of its own** — the command writes nothing and reports nothing about the repository; every change comes from the agent turn it starts, so an agent without write access produces advice rather than a file.
- **Root `AGENTS.md` only** — the prompt names the root file; nested per-directory instruction files stay the agent's or the user's decision.
- **No overwrite confirmation** — updating an existing `AGENTS.md` is left to the agent's normal edit approval path, which is where the user reviews the diff.
- **One turn, no follow-up loop** — the command queues a single message and does not check whether the agent finished the file or re-ask.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "Model-facing git tools for committing the current change set, switching or creating branches, opening a pull request through gh, and creating or removing worktrees, for users and maintainers composing a git-capable agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

English | [中文](README.zh.md)

## Summary

`dsh-tool-git` gives the agent first-class git operations instead of a raw shell command: stage and commit the current change set with a message the model wrote, create or switch branches, open a GitHub pull request through `gh`, and create or remove worktrees. Every command runs as an argv vector through the subprocess capability, so no shell quoting rule and no Bash-versus-PowerShell dialect stands between the model and git, and long output stays bounded with the complete stream recoverable from a spill file. Pull request creation needs the GitHub CLI installed and authenticated; commits need a git identity in the repository.

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

Mount it in any composition that already carries a subprocess provider and where the agent should commit, branch, open pull requests, or manage worktrees without composing a shell command string.

### When to choose it

Choose it when the agent must change repository state through git itself: the tools own the argument vocabulary, refuse a malformed branch name or an empty message before spawning, and report git's own exit status. Prefer the `bash` tool when the task needs a git subcommand this package does not expose — push, fetch, merge, rebase, log, or status — because the family is deliberately four mutating operations, not a general git façade. The tools act on the directory the session runs in, so a composition without a session working directory uses the process working directory.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-tool-git'
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `60000` | Cooperative per-command deadline declared to `dsh-tool-call-timeout-policy`; enforced only where that wrapper is mounted |
| `outputMaxBytes` | `64000` | In-memory stdout tail in bytes; overflow keeps the tail and spills the complete stream |
| `spillMaxBytes` | `8388608` | Whole-stream spill-file cap for a truncated stdout or stderr stream |
| `stderrMaxBytes` | `16384` | In-memory stderr tail in bytes |
| `graceMs` | `2000` | Milliseconds between starting termination and force-killing a command that will not exit |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-git) is the exhaustive source for every accepted field.

### The four tools

| Tool | Effect |
|---|---|
| `git_commit` | `git add --all` then `git commit --message <message>`: commits the complete current change set — modifications, additions, and deletions — under the model-written message |
| `git_branch` | `git switch <name>`, or `git switch --create <name>` with `create: true` |
| `git_pr` | `gh pr create --title <title> --body-file -` with the description on stdin, plus `--base` and `--draft` when asked; returns the pull request URL |
| `git_worktree` | `git worktree add <path> [-b <branch>] [<commitish>]`, or `git worktree remove [--force] <path>` |

Each tool takes an optional `repo` directory, resolved against the session working directory when relative and defaulting to it when absent.

### Destructive operations stay explicit

Removing a worktree deletes its directory and its entry in the repository metadata; it refuses a worktree holding modifications unless `force: true` is passed, and `force: true` discards those uncommitted modifications. Nothing else removes state: `git_commit` never rewrites history, never amends, and never force-pushes, and no tool deletes a branch. A commit or branch name the model supplies reaches git as one argv element, so a leading dash is rejected before anything runs.

### What can go wrong

A nonzero git exit is a result, not a tool error: the model reads the output and the `[exit code: N]` marker. Infrastructure failures are errors — an aborted call, a git argument the process cannot accept, or a missing program. A composition without a subprocess provider never activates these tools. `gh` is resolved on every pull-request call, so an unauthenticated or absent GitHub CLI is reported with what is missing rather than as a git failure.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Argv, never a command string.** The tools consume only `ctx.subprocess`: each call resolves the program, spawns an explicit `argv`, and reads collected output. Because the seam never shell-interprets, one tool serves POSIX and Windows compositions, a commit message may contain quotes or newlines verbatim, and a model-supplied branch name cannot become a second command. This is why the family consumes the subprocess seam directly rather than the `ctx.shell` seam: a shell executor is dialect-specific (`bash -c` or `pwsh -Command`), and its request carries one command string.
- **The seam owns process facts.** Executable lookup, the credential scrub, bounded collection, spill files, managed-range termination, and exit facts stay in `ctx.subprocess`; these tools own schemas, argument preconditions, working-directory resolution, and rendering.
- **One canonical value for every tool.** All four register the same output shape, so a caller treats any git result the same way and the UI presenter is one function.
- **Nonzero exits are values.** Only cancellation, an unusable argument, or a missing program throws; the model interprets exit status and markers the way it does for the shell tools.
- **The capability plane stays elsewhere.** The tools declare no policy. A deployment that runs the agent kernel in enforce mode declares these tools' capabilities beside the kernel, because only the policy plane may extend that vocabulary.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, budget resolution, argument preconditions, and the four registrations |
| [`src/argv.ts`](src/argv.ts) | Pure argument builders per tool and the single display line a card title shows |
| [`src/git.ts`](src/git.ts) | Executable resolution and the one spawn/collect path over `ctx.subprocess` |
| [`src/output.ts`](src/output.ts) | The shared canonical output schema and its model-facing rendering |
| [`src/presentation.ts`](src/presentation.ts) | Pure terminal call/result card presenters |
| [`src/types.ts`](src/types.ts) | Types only: configuration, tool arguments, canonical value |
| — | No runtime invariant companion is published; the subprocess seam validates spawn specs and collected values, and these tools hold no durable state a companion could cross-check |

### Command environment

Every command receives the subprocess seam's scrubbed parent environment plus `GIT_CONFIG_COUNT=0` (neutralizing ambient `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs), `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1` (failing instead of hanging on an interactive prompt), `GIT_OPTIONAL_LOCKS=0`, and `LC_ALL=C`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [git group map](../README.md) — the sibling group page and its package table.
- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — the spawn spec, collected readers, the credential scrub, and managed-range termination every git command uses.
- [Subprocess Service Definition](../../subprocess/subprocess/README.md) — the request/spec vocabulary and spill caps this package configures.
- [tool-bash](../../shell/tool-bash/README.md) — the shell consumer for the git subcommands this family does not expose.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git) — the exact schemas the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-git) — every accepted config field and its source declaration.
- [Agent kernel](../../runtime/agent-kernel/README.md) — why a tool's capabilities are declared by the policy plane rather than the tool package.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the four generated schemas in the [git tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git): `git_commit` (`message`, optional `repo`), `git_branch` (`name`, optional `create` and `repo`), `git_pr` (required `title` and `body`, optional `base`, `draft`, and `repo`), and `git_worktree` (required `action` of `add` or `remove` and required `path`, optional `branch`, `commitish`, `force`, and `repo`). Each description states the consequence of the destructive form.

#### Token effect

Fixed schema cost on every request where the tools are visible, unchanged by configuration or repository state.

#### KV Cache effect

Prefix-stable while visibility and the definitions are unchanged. Plugin lifecycle or an agent-scoped tool restriction may invalidate reuse from the first changed definition.

### Command results

#### What the model sees

The renderer emits the bounded stdout tail, then a `[stderr]` section when stderr is non-empty, then self-describing markers: `[output truncated; full output: <path-or-(unavailable)>]`, `[killed by signal: <signal>]`, and `[exit code: <exitCode>]`. A clean exit carries no marker; a command with no output renders `(no output)`.

#### Token effect

Zero result tokens before a call. Output is bounded per stream by the configured caps, while each emitted line remains in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Validation and infrastructure failures are normalized as `Error: <message>`. This package's stable messages are `invalid message: expected a non-empty string`, `invalid title: expected a non-empty string`, `invalid body: expected a non-empty string`, `invalid path: expected a non-empty string`, ``invalid branch name: "<value>"``, `git is not available in this execution world; install git, or run the command through a shell tool`, `gh is not available in this execution world; install the GitHub CLI (`gh`) and authenticate it, or open the pull request another way`, and the canonical `tool call aborted`.

#### Token effect

Only the failing call adds these retained tokens; a rejected argument adds no command output because nothing spawns.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the family is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Four mutating operations only** — no push, fetch, merge, rebase, tag, log, diff, or status tool; the model uses the `bash` tool for every other git subcommand.
- **Commits stage the whole working tree** — `git_commit` runs `git add --all` with no pathspec, so a partial commit is impossible; commit what the turn changed, or stage and commit through `bash`.
- **The model supplies the commit message** — no message is generated from the diff; the tool commits exactly the message it is given.
- **Pull requests need an authenticated `gh`** — ambient `GITHUB_TOKEN`/`GH_TOKEN` values do not reach the child, because the subprocess seam scrubs credential-shaped environment names; authenticate the GitHub CLI itself. Only creation is exposed: review, merge, comment, and close are absent.
- **Commits need a configured git identity** — the tools pass no `-c user.name`/`user.email`, so a repository or global identity must already exist.
- **A locked worktree still needs manual removal** — `force: true` discards modifications by passing `--force` once; git requires the option twice to remove a locked worktree, which this parameter does not do.
- **Enforce-mode deployments must declare these tools** — the kernel's capability registry fails closed, so a composition running the agent kernel in enforce mode declares `git.read`/`git.write` (and `network.write` for `git_pr`) beside the kernel before these tools can run.
- **Ambient git configuration is neutralized** — `GIT_CONFIG_COUNT=0` drops ambient `GIT_CONFIG_KEY_n` pairs, so a deployment that configures git through those variables must pass the settings another way.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "The git package group: the model-facing git tools under packages/git/, for readers choosing or navigating the family."
kind: "package-group"
---

# git/ — model-facing git operations

English | [中文](README.zh.md)

## Summary

The git group turns repository operations into first-class agent tools: commit the current change set under a message the model wrote, create or switch branches, open a GitHub pull request through `gh`, and create or remove worktrees. Each tool runs git as an argv vector through the subprocess capability, so one schema works on POSIX and Windows compositions and no shell quoting rule stands between the model and git. The group owns the argument vocabulary, the working directory, and the rendered result; the subprocess seam owns executable lookup, the credential scrub, output bounds, and process termination.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-git`](tool-git/README.md) | Registers `git_commit`, `git_branch`, `git_pr`, and `git_worktree` over the subprocess capability | registers on `ctx.tools` |

The group is a container for one product package. A composition needs a `ctx.subprocess` provider (`dsh-subprocess-local`); the tools stay pending without one.

-----

<a id="related-documentation"></a>
## Related documentation

- [Subprocess subsystem](../../docs/subsystems/subprocess.md) — the spawn spec, collected readers, credential scrub, and managed-range termination every git command uses.
- [tool-bash](../shell/tool-bash/README.md) — the shell consumer for git subcommands this family does not expose.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-git) — the exact schemas the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-tool-git) — every accepted config field.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

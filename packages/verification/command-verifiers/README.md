---
description: "Command-backed acceptance-criterion verifiers for the agent-kernel completion gate: each configured criterion runs one shell command through ctx.shell and records pass, fail, or timeout, for users and maintainers who need a task's 'done' to rest on evidence."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-verifiers

English | [中文](README.zh.md)

## Summary

Use this package when a task must complete on evidence, not on a model statement. The agent kernel ships no criterion verifier, so a required criterion nothing claims stays `unknown` and never completes. This plugin answers a criterion from what the deployment declares for its id or verifier family: one shell command through `ctx.shell`, whose exit status decides the criterion. A `diff` criterion, or one bound to a change contract, needs no command — the scopes a task changed decide it. An unconfigured criterion stays unresolved.

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

Mount this plugin beside `@deepseek-ai/dsh-agent-kernel` and a shell executor when a task declares acceptance criteria. The kernel injects its registry, so mount order never matters; the shell executor is looked up at verification time, because a composition that configures only `diff` criteria needs none.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    acceptance:
      - id: unit-tests
        description: the package's tests pass
        verifier: test
        required: true
      - id: scope
        description: only the package's own sources changed
        verifier: diff
        required: true
- name: '@deepseek-ai/dsh-command-verifiers'
  config:
    verifiers:
      unit-tests:
        command: pnpm vitest run
        args: ['--config vitest.config.ts']
        cwd: packages/x
        timeoutMs: 600000
        expectedExitCodes: [0]
      diff:
        expectedPaths: ['packages/x/**']
```

### Configuration

| Field | Required | Meaning |
|---|---|---|
| `verifiers` | yes | Targets keyed by acceptance criterion id or verifier family. An empty map fails the load: the plugin would answer no criterion. |
| `verifiers.<claim>.command` | with a command target | Shell command line, run through `ctx.shell`. |
| `verifiers.<claim>.args` | no | Shell text appended to `command`, one space apart, in order. Quote an argument here when the shell must treat it literally. |
| `verifiers.<claim>.cwd` | no | Working directory for the command. Absent uses the executor's configured directory. Recorded as the verdict's evidence reference. |
| `verifiers.<claim>.timeoutMs` | with a command target | Wall-clock ceiling in milliseconds; a run that overruns it fails the criterion. The shell executor may clamp it to its own maximum. |
| `verifiers.<claim>.expectedExitCodes` | with a command target | Exit codes that count as a pass, as a non-empty list of integers. |
| `verifiers.<claim>.expectedPaths` | with a scope target | Working-directory-relative globs every changed scope of a `diff` criterion must match. |
| `verifiers.<claim>.contract` | with a contract target | `true` decides this criterion by comparing the scopes the task changed against the change contract the task declared. The bounds come from the task, never from this document, so one entry covers every task that declares a contract. |

An entry declaring both a command and expected paths, neither a command, a non-empty `expectedPaths`, nor `contract: true`, or a field its kind cannot use (`timeoutMs` beside `expectedPaths`, a command or scope field beside `contract`, a blank command or claim) fails the plugin load instead of loading inert. Every accepted field is listed in the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-verifiers).

### Which criterion a target claims

A criterion is claimed by its own id first, else by its `verifier` family. `unit-tests` above therefore covers only that criterion, while `diff` covers every criterion whose family is `diff`. A criterion no target claims stays unresolved, and the kernel reports it `unknown` rather than passing it.

### Which families this group answers

This table maps each §8.1 verifier family to the plugin that ships a verifier for it. A criterion of a family below can still be decided by a command: the kernel asks the first registered verifier that claims the criterion, so a deployment may declare a command target for any family, and mount order decides when two verifiers answer the same one.

| §8.1 family | Answered by | How |
|---|---|---|
| `build`, `test`, `lint`, `typecheck`, `assertion` | this plugin | the command the deployment declares for the criterion's id or family |
| `diff` | this plugin | the added scopes against `expectedPaths`, or against the change contract the task declared |
| `security`, `browser`, `review` | [`agent-verifiers`](../agent-verifiers/README.md) | one independent reviewer subagent per criterion |
| `human`, `research` | no verifier ships here | the plugins that own human evidence and recorded research claims |

### What you get

| Criterion outcome | Verdict |
|---|---|
| Command exits with an accepted code | `pass` |
| Command exits with any other code | `fail`, with the outcome line and the retained output tail |
| Command overruns `timeoutMs` | `fail`, naming the ceiling it exceeded |
| Command cannot start, its working directory is unusable, or no shell executor is mounted | `fail`, naming why it did not run |
| Every changed scope matches `expectedPaths` | `pass`, carrying the scopes it checked |
| A changed scope falls outside `expectedPaths` | `fail`, carrying exactly the scopes outside |
| Every changed scope stayed inside the task's declared contract | `pass`, carrying the scopes it checked |
| The change broke a declared bound | `fail`, naming every broken bound and the scopes that broke it |
| A contract target claims the criterion and the task declared no contract | `fail`, naming the target: a claimed criterion is never left silently unresolved |

Every command verdict records the command line, the retained output, and the accepted exit-code set, so a reader of the session log can reconstruct what was run and why it decided as it did.

---

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how a criterion becomes a verdict; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

Configuration is resolved once, at load, into a claim table of fully-specified targets: `resolveTargets` rejects every entry that could never decide a criterion, and the verifier looks a criterion up in that table instead of re-reading the deployment document per call. There are no hidden defaults — `timeoutMs` and `expectedExitCodes` are declared, never assumed — so a configured target cannot silently run something other than what the deployment wrote. A command runs as one `ShellExecRequest` with `onExpiry: 'kill'`, so the executor's own deadline, output caps, spill files, and abort handling apply unchanged; a cut-short run reports `timedOut`, `aborted`, and its exit status as independent facts, and an accepted exit code alone never turns one into a pass.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`, the `agentKernel` injection, `Config`, and the registering effect |
| [`src/targets.ts`](src/targets.ts) | Configuration resolution and the expected-path glob test |
| [`src/contract.ts`](src/contract.ts) | The change-contract comparison: which changed scopes broke which declared bound |
| [`src/verifier.ts`](src/verifier.ts) | The `CriterionVerifier`: claim lookup, the command run, and the verdicts |
| [`src/types.ts`](src/types.ts) | The configuration and resolved-target vocabulary |
| — | No runtime invariant companion is published; the verifier owns no state beyond its configuration and derives every verdict from its arguments, so a second observation could not diverge from it. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the targets to the gate that consumes their verdicts and the executor that runs their commands.

- [Agent kernel subsystem reference](../../../docs/subsystems/agent-kernel.md) — the completion gate, `CriterionVerifier`, and the ordering and timeout the registry applies to registered verifiers.
- [Shell subsystem reference](../../../docs/subsystems/shell.md) — the request/spec split, `ShellRunResult`, and the output caps and spill files a verdict's detail is drawn from.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-command-verifiers) — every accepted field of this plugin.
- [runtime group map](../../runtime/README.md) — the kernel and context packages this plugin feeds.

-----

<a id="model-experience"></a>
## Model Experience

### Failed required criterion

#### What the model sees

No prompt section and no tool schema is added. This verifier's own text — the criterion id, the outcome line, the retained output tail, and the evidence references — stays in the durable `verification/result` record. The only model-visible consequence is indirect: the repair message the kernel steers after a failed turn names the criterion as `required criterion "<id>" is fail`.

#### Token effect

Zero tokens added directly. Every command's output is retained in the session log and in the verifier's verdict, never in a request; the repair message that follows pays one short bullet line per failed criterion, whatever that command printed.

#### KV Cache effect

Independent: no prompt section and no schema are registered, so the request prefix never changes, and a repair message appends to the conversation after the failing turn rather than rewriting it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the plugin is a poor fit. They are current package constraints, not a task backlog.

- **The verification seam carries no `AbortSignal`** — `VerificationRequest` has no cancellation channel, so a running command is stopped only by its `timeoutMs` or by composition teardown. Do not configure a ceiling longer than the turn it must not outlive.
- **The kernel's verifier ceiling still wins** — `verifierTimeoutMs` (60s by default) is applied by `CriterionVerifierRegistry` around this verifier, so a command with a longer `timeoutMs` is reported as a ceiling overrun before it finishes. Raise `verifierTimeoutMs` beside a long command.
- **One command per criterion** — a criterion needing typecheck, lint, and test must either declare three criteria or compose its own shell line; multi-command targets are not implemented.
- **Expected paths are working-directory-relative** — `request.changedScopes` carries paths relative to the session working directory (or absolute ones outside it), so a glob can only match the relative form: an absolute changed path outside the working directory never matches.
- **The retained output bound is the executor's** — a verdict's detail carries the executor's collected stdout and stderr tails, each capped by that executor's own output configuration (`bash-local` defaults to 64 KiB per stream) with the complete stream at the spill path when truncation occurred. This package adds no cap of its own and cannot bound output more tightly than the executor holding it.
- **No result cache** — S6's `CriterionResult` cache keyed by criterion id and repository digest lives with the gate, not here; a re-verification runs the command again.
- **A contract compares scopes, not file contents** — every bound is evaluated against `request.changedScopes`, the paths the `workspace/changes` recorder published for the turn. The comparison reads no file and needs no working tree, so a preserved file rewritten to identical bytes still counts as changed, and a bound declared against a path the recorder never reports is never broken.
- **A declared contract that bounds nothing admits every change** — a task whose contract populates none of its five lists passes the criterion, with a detail saying so. A deployment that declares no contract target claims no criterion at all, which is the behavior this target kind leaves unchanged.
- **The boundary is declared by the task, not by this document** — the contract reaches the verifier on the verification request, so a deployment can claim the criterion but cannot write the bounds; a caller that declares no contract on the task makes the claimed criterion fail rather than pass.
- **Commands run at the executor's privilege** — this plugin adds no confinement of its own: a sandboxing executor confines them, a local one does not, and the criterion is only as trustworthy as the composition that runs it.
- **The real-composition suite needs a POSIX shell** — its `cordis.yml` mounts `dsh-bash-local`, so `vitest.config.ts` excludes that suite on win32; the unit suite covers this package's sources on every platform.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The alternatives were a `ctx.criterionVerifierRunner` service that owned configured commands for any verifier to call, and per-criterion plugins. The service would have been a second registry standing beside the one the kernel already owns, and the per-criterion form puts a deployment's shell lines in the composition rather than in one document. One plugin with a resolved claim table keeps the configuration, its validation, and the verdicts that follow from it in one place, and leaves the kernel as the only owner of gate ordering, timeouts, and completion.

</details>

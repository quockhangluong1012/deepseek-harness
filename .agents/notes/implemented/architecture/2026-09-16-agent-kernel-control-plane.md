# Agent Note: Agent kernel control plane

Status: implemented

English | [中文](2026-09-16-agent-kernel-control-plane.zh.md)

## Problem

The harness records what happened but not what was decided. A session log holds the turns, steps, tool calls, and results, and `sandbox-policy`, `user-approval`, `permission-presets`, and `guard/budgets` each decide one slice of authority — but nothing answers, from durable evidence, what a task was for, which of those decisions applied to a given tool call, or whether a completion claim was ever verified. The gaps are structural rather than missing features: there is no canonical task contract, no single record joining a policy decision to the sandbox and the human answerer that composed it, and no completion gate that can refuse a "done" no evidence supports.

## Decision

A new opt-in package, `packages/runtime/agent-kernel`, observes the waterfalls and events the loop already publishes and records the decisions it composes. It owns no execution.

The kernel attaches to four existing seams. `agent/pre-step` opens a task contract on the first admitted step and moves it to `executing`; `tools/pre-execute` appends the action proposal before evaluating it, then appends the rule decision, the composed authorization, and any capability grant; `tools/post-execute` appends the action receipt with its governance record; `agent/turn-stopping` records the observation edge and runs the completion gate when the task declares a required acceptance criterion.

Every record is a durable session event, and the kernel's read model is a fold over those events behind a per-session cursor, so a replayed log reproduces the same view. `mode: 'shadow'` (the default) records every decision and returns the waterfall untouched; `mode: 'enforce'` returns `deny` to block a call and `ask` to route it through the composed answerers the tool registry already owns.

Three decisions stay separate because three existing owners make them. The permission document decides `allow`, `ask`, or `deny` against declared capabilities and resource globs. `SandboxPolicyService` remains the only resolver of the technical boundary, and a mutating capability it refuses is denied rather than asked. `ApprovalService` remains the only interactive answerer, reached through the registry's `ask` path, and the kernel observes the resulting `approval/asked` and `approval/decided` events to fill the receipt instead of asking on its own.

Task creation happens at the first admitted step rather than at `agent/session-start`. The objective is only knowable once a step claims the human message, and a session-start append would land outside an open turn, where the durable log cannot distinguish it from crash-tail garbage.

An action the composed policy refused is recorded as `outcome: 'denied'`, never as a tool failure, so a reader can separate "the harness said no" from "the tool ran and broke".

## Alternatives considered

**Fork the agent loop into a task-aware driver.** Rejected: `core/agent-loop` owns turn and step lifecycle, cancellation, and tool concurrency, and a second driver would duplicate all of it. Every integration point the kernel needs already exists as a waterfall or event, and the specification's own invariant forbids replacing the loop.

**Enforce by default.** Rejected: a permission document that has never run against real traffic denies the wrong things, and enforcing on by default would stop every tool call in a deployment whose tools declare no capabilities. Shadow mode is the default so a deployment measures before it governs.

**Decide `ask` inside the kernel by calling `ApprovalService` directly.** Rejected: the tool registry already resolves `ask` through the composed answerers and fails closed when none is available. Calling the service a second time would ask the human twice for one call and duplicate the registry's cancellation handling.

**Model the permission document as a tool-name allowlist.** Rejected: a tool name is not a capability. The same tool can be safe against one resource and dangerous against another, and a name-based list cannot express the workspace boundary, the shell command, or the host that `capabilities.register()` projects from arguments.

**Create the task at `agent/session-start`.** Rejected on both the objective and the durability grounds recorded under Decision.

## Consequences

The kernel gives a deployment a durable task contract, one attributable record per tool call, and a completion gate that refuses an unsupported claim. It costs one audit record per tool call in every session where it is mounted, and it holds a per-session fold cursor whose memory grows with the number of kernel events rather than with the log.

The boundary it draws is deliberately narrow. It ships no capability declaration for any built-in tool, no criterion verifier, and no crash-recovery scanner, so `mode: 'enforce'` refuses every tool until a deployment or a follow-up declares them, and a required acceptance criterion stays `unknown` until a verifier is registered. Those gaps are recorded in the package README's Known Limitations, not hidden.

`packages/runtime/agent-kernel/tests` pins the behavior: the state-machine edge table and its revision guard, the permission engine's precedence and sandbox composition, the capability registry's replacement rule, the recovery table, the completion gate and the criterion-verifier registry, the ledger fold including cursor reuse and failure resolution, the kernel's own intake, authorization, commit, verification, attachment, and checkpoint paths, and one real-Loader composition booting `cordis.yml` that proves enforcement mode and document validation are configuration rather than constants.

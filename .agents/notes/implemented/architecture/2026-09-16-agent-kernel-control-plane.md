# Agent Note: Agent kernel control plane

Status: implemented

English | [中文](2026-09-16-agent-kernel-control-plane.zh.md)

## Problem

The harness records what happened but not what was decided. A session log holds the turns, steps, tool calls, and results, and `sandbox-policy`, `user-approval`, `permission-presets`, and `guard/budgets` each decide one slice of authority — but nothing answers, from durable evidence, what a task was for, which of those decisions applied to a given tool call, or whether a completion claim was ever verified. The gaps are structural rather than missing features: there is no canonical task contract, no single record joining a policy decision to the sandbox and the human answerer that composed it, and no completion gate that can refuse a "done" no evidence supports.

## Decision

A new opt-in package, `packages/runtime/agent-kernel`, observes the waterfalls and events the loop already publishes and records the decisions it composes. It owns no execution.

The kernel attaches to five existing seams. `agent/created` writes a delegation receipt into a child session's own log, before either side has a task, with an audit copy on the parent log. `agent/pre-step` opens a task contract on the first admitted step and moves it to `executing`; `tools/pre-execute` appends the action proposal before evaluating it, then appends the rule decision, the composed authorization, and any capability grant; `tools/post-execute` appends the action receipt with its governance record; `agent/turn-stopping` records the observation edge and runs the completion gate when the task declares a required acceptance criterion.

Every record is a durable session event, and the kernel's read model is a fold over those events behind a per-session cursor, so a replayed log reproduces the same view. `mode: 'shadow'` (the default) records every decision and returns the waterfall untouched; `mode: 'enforce'` returns `deny` to block a call and `ask` to route it through the composed answerers the tool registry already owns.

Four decisions stay separate because the owners stay separate. The permission document decides `allow`, `ask`, or `deny` against declared capabilities and resource globs. `SandboxPolicyService` remains the only resolver of the technical boundary, and a mutating capability it refuses is denied rather than asked. A child agent's delegation receipt intersects next: a capability, writable scope, or depth the parent never granted is refused no matter what the rules or the state say, and every child authorization names the receipt it ran under. `ApprovalService` remains the only interactive answerer, reached through the registry's `ask` path, and the kernel observes the resulting `approval/asked` and `approval/decided` events to fill the receipt instead of asking on its own.

Task creation happens at the first admitted step rather than at `agent/session-start`. The objective is only knowable once a step claims the human message, and a session-start append would land outside an open turn, where the durable log cannot distinguish it from crash-tail garbage.

An action the composed policy refused is recorded as `outcome: 'denied'`, never as a tool failure, so a reader can separate "the harness said no" from "the tool ran and broke".

## Alternatives considered

**Fork the agent loop into a task-aware driver.** Rejected: `core/agent-loop` owns turn and step lifecycle, cancellation, and tool concurrency, and a second driver would duplicate all of it. Every integration point the kernel needs already exists as a waterfall or event, and the specification's own invariant forbids replacing the loop.

**Enforce by default.** Rejected: a permission document that has never run against real traffic denies the wrong things, and enforcing on by default would stop every tool call in a deployment whose tools declare no capabilities. Shadow mode is the default so a deployment measures before it governs.

**Decide `ask` inside the kernel by calling `ApprovalService` directly.** Rejected: the tool registry already resolves `ask` through the composed answerers and fails closed when none is available. Calling the service a second time would ask the human twice for one call and duplicate the registry's cancellation handling.

**Model the permission document as a tool-name allowlist.** Rejected: a tool name is not a capability. The same tool can be safe against one resource and dangerous against another, and a name-based list cannot express the workspace boundary, the shell command, or the host that `capabilities.register()` projects from arguments.

**Create the task at `agent/session-start`.** Rejected on both the objective and the durability grounds recorded under Decision.

**Declare capabilities in each tool package.** Rejected: product tool packages would depend on the policy plane, and a tool package must stay mountable without the kernel. The separate opt-in builtins plugin keeps the vocabulary, the registry, and the shipped declarations in one plane, and the catalog-coverage spec re-derives the tool inventory from the generator the tool packages themselves feed.

**Resolve the parent session at every child action.** Rejected: the receipt is written into the child's own log at creation precisely so a replay reconstructs the child's authority without the parent's session. Re-resolving per action would make every child authorization depend on a session that may long be unloaded, and would let a later parent state rewrite the authority earlier actions ran under.

## Consequences

The kernel gives a deployment a durable task contract, one attributable record per tool call, and a completion gate that refuses an unsupported claim. It costs one audit record per tool call in every session where it is mounted, and it holds a per-session fold cursor whose memory grows with the number of kernel events rather than with the log.

The boundary it draws is deliberately narrow. Built-in tools are declared by the separate opt-in `agent-kernel-builtins` plugin rather than by the tool packages, because only the policy plane may extend the capability vocabulary; a deployment that renames a tool, mints `mcp__*` or `structured_output` names, or ships its own tools declares those itself. A delegation receipt is only as strict as the document it was issued under, and a child whose parent session does not resolve falls back to the deployment ceilings. It ships no criterion verifier and no crash-recovery scanner, so a required acceptance criterion stays `unknown` until a verifier is registered. Those gaps are recorded in the package README's Known Limitations, not hidden.

`packages/runtime/agent-kernel/tests` pins the behavior: the state-machine edge table and its revision guard, the permission engine's precedence and sandbox composition, the capability registry's replacement rule, the recovery table, the completion gate and the criterion-verifier registry, the ledger fold including cursor reuse and failure resolution, the kernel's own intake, authorization, commit, verification, attachment, and checkpoint paths, the delegation issuance at child creation and its capability, scope, and depth intersection including the cold-child and resumed-child paths, and one real-Loader composition booting `cordis.yml` that proves enforcement mode and document validation are configuration rather than constants. `packages/runtime/agent-kernel-builtins/tests` pins the declarations: every entry resolves, every projection is total, the table names exactly the tools the generated tool catalog lists, and one enforce-mode run proves a declared built-in tool executes.

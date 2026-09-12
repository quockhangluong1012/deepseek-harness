# Agent Note: Full-access sessions bypass the permission approval gate

Status: implemented

English | [中文](2026-09-11-full-access-gate-delegation.zh.md)

## Problem

Selecting the Full access permission preset (`danger-full-access`: sandbox `danger-full-access` plus approval `never`) made every gated mutating tool fail without any prompt: `Error: the user rejected tool "write"`. The chain:

1. Since the [2026-09-09 audit remediation](2026-09-09-harness-audit-remediation-signal-validation-approval-sandbox.md), `dsh-permission-presets` registers a `tools/pre-execute` producer that returns `{kind: 'ask'}` for every tool in `DEFAULT_APPROVAL_TOOLS` (`bash`, `pwsh`, `write`, `edit`, and the rest).
2. The preset pins approval policy `never`, and `ApprovalService` resolves every ask to `'rejected'` before any answerer runs.
3. `dsh-tools` maps `'rejected'` to `the user rejected tool "<name>"`.

The preset whose documented meaning is "Full file access without approval prompts" therefore rejected all file writes. Reproduced against the real services (full-access session, real `ApprovalService`, real gate, real `ToolRuntime`, one `write` tool): the exact user-visible error; the same write under `workspace-write` with a granting answerer dispatches.

## Decision

The gate delegates to `next()` instead of asking when the calling session's effective sandbox mode is `danger-full-access` — the folded `sandbox/mode` override, else the executor's configured mode. A full-access session already carries the deployment's unrestricted file authority, so the gate protects nothing there; asking only feeds the `never` policy's deterministic rejection. Agentless calls keep the ask (fail closed with no session to read), and a session with no pinned sandbox knob falls back to the composition default.

The `never` service semantics are untouched: asks that still occur under `never` (sandbox-escalation asks, hook asks) keep resolving `'rejected'` with their audit pair. The dead `config.approvalTools ?? DEFAULT_APPROVAL_TOOLS` fallback is removed alongside: the schema already defaults the list (the same precedent as the preset-table cast), and its unreachable side left one branch uncovered since the audit.

## Alternatives considered

**Ask only under the `ask` approval policy (skip the gate under `never`).** Rejected because it would silently allow mutating tools for every `never` session, including confined ones — softening the audited fail-closed property that unattended and lockdown deployments rely on, and contradicting the model-facing `never` sentence.

**Re-pair `danger-full-access` with `ask`.** Rejected because Full access would then prompt on every mutation, behaving exactly like `workspace-write` — contradicting the preset's "without approval prompts" meaning and its client copy.

**Add an auto-allow approval policy.** Rejected because a new policy value would cross the whole seam (service, docs, SDK snapshots, ACP bridge, generated catalogs) for an authority the existing sandbox mode already expresses.

## Consequences

Full access works as documented: no prompts and gated tools dispatch, while `workspace-write` and `read-only` behavior is unchanged (prompt under `ask`, reject under `never`, deny when no approval channel exists). The cost is explicit: a custom preset pairing a `danger-full-access` sandbox with `ask` also skips the gate — the sandbox mode, not the approval policy, decides whether the gate asks. Escalation and hook asks still honor the approval policy. The owning specs pin delegate-under-full-access, ask-under-confined, ask-for-bare-session, and agentless-ask, and the package measures 100% statements, branches, functions, and lines. The audit's missing shipped-profile approval proof test still stands as a follow-up.

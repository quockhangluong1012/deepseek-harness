# Agent Note: Harness audit remediation across CI signal, tool validation, approval, and sandbox parity

Status: implemented

English | [中文](2026-09-09-harness-audit-remediation-signal-validation-approval-sandbox.zh.md)

## Problem

The September 2026 harness audit verified that three enforcement layers were non-functional: no CI pipeline ran on any branch or merge request, the translation-pairing gate was already red, no shipped bundle could emit an approval prompt, every mutating tool escaped the timeout guard, tool-argument validation had three holes, and four sandbox backends derived four different writable sets.

## Decision

`.gitlab-ci.yml` admits merge-request and default-branch pipelines with eight lane jobs shelling to the existing `check:ci:*` scripts plus a pnpm-store cache keyed on `pnpm-lock.yaml`, and `scripts/verify-ci-lane-coverage.ts` asserts every required lane is invoked and the workflow admits merge requests, wired into `ci-static` and `hygiene`; `test:python` and `test:native-system` run inside `ci-consumers`, and `scripts/verify-no-fixme.ts` rejects `FIXME` markers in runtime source while the timeout-policy rename marker is resolved by keeping the published name.

The tool parameter root compiles closed (`additionalProperties: false`) so undeclared model keys fail with `INVALID_ARGS`, the MCP bridge validates arguments against the server schema and throws `ToolArgsError` instead of coercing malformed input to `{}`, and the timeout policy carries a validated `defaultTimeoutMs` (120000, explicit in `bundle/base`) so an omitted per-tool budget is bounded rather than unbounded.

`permission-presets` owns the shipped `tools/pre-execute` approval producer: `requiresApproval` gates mutating tools, every `mcp__*` bridge tool, and the `schedule_*`/`cordis_*` prefixes while observation and user-interaction tools delegate unchanged, with the gated set configurable through `approvalTools`; sandbox-escalation refusals are `HarnessError`s with routable codes (`INVALID_ESCALATION_ARGS`, `SANDBOX_ESCALATION_NOT_WIDER`, `SANDBOX_ESCALATION_UNAVAILABLE`, `SANDBOX_ESCALATION_REJECTED`, `SANDBOX_ESCALATION_CANCELLED`).

Shell parity extracts shared helpers instead of copying guards outward: `assertStandingPolicy` and `resolveWorkdir` live in `dsh-sandbox` and serve bash, pwsh, and both fs families; `throwToolAborted` and `startAbortGuardedBackground` live in `dsh-tools` and serve bash, pwsh, terminal, and subagent; `str_replace_editor` reuses `FsSandboxController` from `dsh-tool-fs` instead of its parallel `MutationPolicy` class, so the next fix cannot land on one call site only and the clone detector stays green.

Sandbox backends reduce from `writableRoots()`: bwrap binds every non-temp root and mounts an ephemeral `/tmp`, Landlock grants the canonical set, UNC workspace roots throw, `docs/subsystems/sandbox.md` states the network negative guarantee (`read-only` denies writes but not exfiltration), and a parity spec pins each reduction; `CLAUDE.md` is a skipped fallback when its `AGENTS.md` sibling exists, `AGENTS.md` documents the fallback plus `check:all`, the `check:ci:*` family, `change-scope`, the coverage exclusion scope, and the keyless snapshot-refresh path, and the tool catalog no longer claims pwsh lacks sandbox controls.

## Alternatives considered

**Copy one hardened guard per call site instead of extracting shared helpers.** Rejected because the first attempt did exactly that and the clone detector reported four new mirrors; the shared helpers in `dsh-sandbox` and `dsh-tools` plus the single `FsSandboxController` keep every future fix on one home.

**Ship a new approval-policy package instead of extending permission-presets.** Rejected because permission-presets is already mounted in `bundle/base` with the sandbox and approval knobs in scope; a new package would need scaffolding, catalog registration, and bundle wiring for the same listener.

**Restore the deleted GitHub Actions topology instead of GitLab run-gates lanes.** Rejected because the deleted workflows encoded self-hosted pools and Wine-hosted Windows that GitLab models differently; the platform-independent `run-gates.ts` inventory is the durable caller.

**Delete the `CLAUDE.md` stubs instead of a fallback skip.** Rejected because zero symlinks can be committed portably from Windows checkouts; the fallback removes the junk-instruction class whether or not the stubs are later deleted.

**Rename the timeout-policy package as its FIXME suggested.** Rejected because the name is published and referenced by the shipped bundle; the rename buys naming symmetry at the cost of breaking every consumer.

## Consequences

Mutating calls route through approval with an audit pair under both `ask` and `never` policies, undeclared tool arguments fail closed at the schema, every registered tool resolves to a finite deadline, and each sandbox backend derives its writable set from one helper with UNC rejected loud. Follow-ups remain: runtime-enumerated tool inventory, the Agent Note reference-integrity gate, incremental doc gates, a per-turn step ceiling, prompt-template activation validation, the aggregate instruction read bound, the full Windows coverage matrix, behavioral backfill for the audited commit's scheduler paths, a shipped-profile approval proof test, and the translation-pairing records that were red before this change.

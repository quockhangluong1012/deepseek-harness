# Agent Note: Webhook replay suppression window

Status: implemented

English | [中文](2026-09-13-webhook-replay-suppression-window.zh.md)

## Problem

`WebhookRuntime.dispatch` ran every rule for every delivery: `deliveryId` only named the delivery, with no deduplication. Providers redeliver on transport failure and operators redeliver manually from the provider dashboard; each repeat minted another root Session — unbounded resource consumption plus repeated prompt-injection surface from the same payload.

## Decision

`dispatch` now drops a repeated (kind, source, deliveryId) inside a one-hour window and acknowledges it without re-running rules. The store is process-local and bounded (10k entries, oldest evicted; expired entries leave on the next dispatch), and the window is a fixed security invariant, not plugin config. Repeats past the window, after a restart, or with distinct ids still run the rules — suppression is replay protection, not idempotency, and the package READMEs plus the subsystem reference say so.

## Alternatives considered

**Durable dedupe table.** Survives restarts and closes the post-restart replay gap — but needs a storage domain, schema, and crash-recovery story for what is meant to be a fire-and-forget runtime whose contract is "no delivery database". Lost: disproportionate machinery; the residual gap is documented instead.

**Configurable window and cap.** Lets deployments tune retention — but every deployment wants the same thing (drop accidental redeliveries, bounded memory), and a `DEFAULT_*` constant is not configurability per the tunables policy. Lost: config surface for no divergent use case.

**Adapter-side dedupe (per-provider).** Catches repeats before dispatch — but every current and future adapter would re-implement it, and cross-adapter duplicates (same event via two sources) would still fan out. Lost: N implementations instead of one choke point.

## Consequences

A rule test asserting re-invocation on repeat ("intentionally invokes a rule again", "creates one Session per matching repeated delivery") was rewritten to the new contract. Gained: transport retries and dashboard redeliveries no longer multiply Sessions. Given up: repeats after one hour or a restart still duplicate — rules needing idempotency still own it, as documented.

## Testing

`runtime.spec.ts`: repeat-in-window dropped with new ids still running, post-window repeat runs again (fake timers), and one-Session-per-repeat at the session-creation level. Negative control via stash: the drop test fails pre-fix. Full webhook + webhook-github suites (76 tests) pass; scoped `tsc --noEmit` clean.

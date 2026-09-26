# Agent Note: Auto mode reviews inside a workspace sandbox with a cheaper classifier

Status: implemented

English | [中文](2026-09-26-auto-mode-reviewer-scope.zh.md)

Supersedes the enforcement, routing, and decision vocabulary of [the original Auto review decision](2026-08-28-auto-review.md); the authority model, source roles, and lifecycle it defines still hold.

## Problem

The first Auto review shipped as a current-session preset sharing Full access's `danger-full-access + never` bundle, and it classified with the reviewed Session's own provider and model. That made the reviewer's full-access authorization the only thing standing between a Session and an unreviewed destructive action, spent the session's most expensive route on a single-object judgement, and left risky work with exactly two outcomes: allowed (when a prior instruction looked like authorization) or denied outright. A user who wanted to authorize an irreversible action had no way to say yes to the reviewer's own classification.

## Decision

[`dsh-experimental-auto-review`](../../../../packages/experimental/auto-review/README.md) keeps its identity (`permission/preset:auto`), its fixed `REVIEW_POLICY`, and its one-review-per-native-or-started-PTC-inner-call guarantee, and changes three things.

### Auto's bundle confines the Session

`auto` resolves to `sandbox: workspace-write`, `approval: ask` inside [`dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.md). Routine work is approved by the reviewer *inside* that scope instead of being approved without one, and the approval policy stays askable so a mid-risk action has somewhere to go. The bundle stays fixed inside the permission service; the reviewer reads it for the request's sandbox-scope section rather than declaring its own copy.

A Session recorded under the earlier bundle adopts the current one at publication: the permission service reconciles a stored `auto` identity whose sandbox or approval knob differs from the Auto bundle, so a resumed Session never keeps a stale wider scope under an identity whose meaning changed. Disposal migrates every live Auto Session to a configured preset that matches the Auto bundle, falling back to the deployment's askable default. The previous fixed migration target (`danger-full-access`, approval `never`) would have been a silent broadening once Auto stopped meaning full access.

### Classification uses a cheaper route

The reviewer classifies through the plugin's validated `Config` fields `classifierProvider` and `classifierModel`; unset, it uses the deployment's default model — the cheap class rather than the model the reviewed Session runs; a composition without that service falls back to the reviewed Session's route. The service is read optionally (`ctx.get`) rather than injected, so Auto still loads in a composition that does not provide it.

### Risky work goes to the user

The decision vocabulary mirrors the pipeline's three outcomes: `low + allow`, `medium + ask` (or `deny`), `high + deny`, each with an optional string `reason` for ask and deny and never for allow. An `ask` becomes the ordinary approval prompt through `ctx.approval`, carrying `Auto review asked you to approve tool "<name>"` plus the reviewer's reason. The retired `medium + allow` shape — a prior human instruction treated as standing authorization for medium work — no longer exists: the user decides, one action at a time, after the reviewer explains it.

While the integration is live and a Session resolves to `auto`, the shipped permission gate no longer asks for its own gated tools (`bash`, `write`, `edit`, terminals, subagents). The reviewer already resolved that exact call, and asking again would put the same decision to the user twice; the reviewer's ask path routes back through the same approval service, so every Auto approval is still audited as an `approval/asked`/`approval/decided` pair.

## Alternatives considered

**Keep `danger-full-access + never` and only change the classifier route.** Cheapest change, and it preserves the shipped migration target. Rejected: the point of the mode is that routine work needs no full-access authorization, and "routine actions inside the sandbox" in the [2.0 evolution spec](../../../../specs/deepseek-harness-2.0-evolution-spec.md) names a sandbox the mode must actually apply.

**Let the reviewer escalate to `deny` only and rely on the existing medium-plus-authorization path.** Rejected: authorization-by-prior-instruction is a judgement call the reviewer had to make from history text, and it fails closed into a denial the user cannot override for that action.

**Expose the approve/ask/deny choice as a `PresetSpec.policy` document instead of a new decision shape.** Rejected: the policy document intersects capability rules for the tool pipeline; it cannot ask the user for one action.

**Add `ask` to the reviewer's vocabulary but keep the generic tool gate asking too.** Rejected: every gated call in an Auto Session would raise two prompts, and the second one would arrive after the reviewer had already decided.

**Migrate live Auto Sessions to the deployment default preset instead of the bundle match.** Rejected: a deployment whose default is `danger-full-access + never` would silently widen every Auto Session at disposal.

## Consequences

Auto now spends two models per risky call (the classifier, then the user) and one per routine call, and its classifier no longer sees the session's strongest model — a weaker classification on subtle cases is the accepted cost of the cheaper route, and the reason the ask path exists. Auto Sessions lose full host access: work that genuinely needs it now hits a sandbox denial and the ordinary escalation path, which is the trade the spec asked for.

The permission gate's deferral lives in `dsh-permission-presets` and is conditional on a live integration and an `auto` result, so a composition without Auto, or a disposed one, keeps the ask. The certification suite that pinned `medium + allow` and the `danger-full-access` bundle was re-pointed at the new vocabulary, the new bundle, and the reviewer's route, and now records the approval request each `ask` raises; its deletion cases require a POSIX shell that shares the workspace filesystem, so it skips on Windows.

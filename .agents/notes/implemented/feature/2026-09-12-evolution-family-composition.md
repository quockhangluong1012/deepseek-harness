# Agent Note: Evolution family in the web-app bundle

Status: implemented

English | [中文](2026-09-12-evolution-family-composition.zh.md)

## Problem

The evolution family shipped package by package — memory store, reviewer, brief injector, skill telemetry and management, curator, governance commands — each with its own suite, and none of it was mounted by a profile. `packages/bundle/web-app/cordis.patch.yml` carried no evolution row, so a real Web session read no memory, injected no brief, ran no review, and never registered the `skill_manage` tool. The behaviour contract in `specs/evolutionary-harness.spec.md` fixes the order: rows land in `web-app` first, never in `base`, so the `headless`, `sdk`, and `acp` snapshots stay byte-identical until those surfaces adopt the family deliberately.

## Decision

Seven rows join the web-app insert list beside the workspace-memory family: `evolution-memory`, `evolution-reviewer`, `evolution-memory-context`, `evolution-skill-telemetry`, `evolution-skill-manage`, `evolution-curator`, and `command-evolution`. The guard and resilience rows (`budgets`, `llm-fallback`) were already mounted there in their dormant off states. `packages/bundle/web-app/package.json` gains the seven workspace dependencies, which [`verify-cordis-config`](../../../../scripts/verify-cordis-config.ts) requires of every bare plugin named in a profile's tree.

Two configuration choices are deliberate. `evolution-memory` mounts with `capacityBytes: 131072`, mirroring the workspace-memory row so both stores carry one ceiling. The reviewer and the injector both name `profile: default`, because the two halves of the loop must address the same record: the injector's scope key writes the brief, the reviewer's scope key writes the lessons, and a deployment that renames one only splits the loop.

Telemetry precedes the rows that resolve it at runtime — `evolution-skill-manage` at each mutation and `evolution-curator` for lifecycle state — so the store exists whenever either asks.

No package in the family has a client face, so the mount adds no `dsh.client` row and no browser roster entry. The Web journey page stays the deferred Phase 4 work, and the CLI commands own governance until it lands.

## Consequences

A Web session now learns. The injector appends the brief when a scope resolves and replaces it when the digest moves; the reviewer indexes produced files on every turn and extracts lessons behind the cooldown gate; the model sees `skill_manage` beside the lessons-to-skills nudge; `/memory`, `/skills`, `/journey`, `/curator`, and `/refine` answer without a model turn. The curator mounts enabled but nothing invokes `maybeRun` yet: its interval-and-idle trigger (CLI start, gateway housekeeping, `serve` maintenance) is the remaining Phase 4 owner, and `/curator status` reports the stored `lastRunAt` until that owner lands. Disabling is removing the seven rows: no record is read, no brief is injected, and no session event or durable format changes.

The mount is model-visible, so the recorded Web corpus moves. Every `snapshots/web/**` case records `system-prompt.expected.md` and `tool-schemas.expected.json`, and both change — the nudge sections, the `evolution_memory_usage` variable, and the added tool. `snapshots/session`, `snapshots/sdk`, and `snapshots/acp` run profiles that never mount the family, so they stay byte-identical.

## Verification

`pnpm run verify-cordis-config` passes on all 143 config files, `pnpm run verify-cordis-catalog` on its 103 generated regions, and `pnpm run verify-config-catalog` after regenerating `docs/config-catalog.md`. Behaviour stays covered by the family's package suites — store caps and staging, reviewer extraction and output indexing, injector render and REAL-composition injection, curation telemetry and `skill_manage`, curator transitions and ledger, and the command surface with Loader composition.

The end-to-end Web case that proves the loop on the shipped profile — brief delivered to the adapter, a produced file indexed, a staged write listed and approved — is the Phase 6 Web journey scenario plus the refreshed corpus, which regenerate on a POSIX host with `pnpm run test:snapshot:refresh`.

## Alternatives considered

**Mounting in `base`.** Every surface would inherit the family at once, including `headless`, `sdk`, and `acp`, whose recorded snapshots are the repository's cheapest regression signal. Rejected: this is a capability a deployment opts into, not a spine default, and the specification fixes web-first adoption.

**A separate `evolution` bundle applied after `dsh-web-app`.** Opt-in granularity for deployments that want the harness without the loop, at the cost of a second bundle whose only difference today is this row set. Rejected until a real second consumer exists.

**Leaving the store config implicit.** Letting each deployment invent `capacityBytes` and `profile` per row. Rejected: the two profile values must agree for the loop to work, so the shipped rows state one namespace and one ceiling, and a divergence is a visible edit rather than a silent split.

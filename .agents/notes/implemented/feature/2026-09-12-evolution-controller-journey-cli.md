# Agent Note: Evolution controller, attributed journey deltas, and the export/learn/suggestions commands

Status: implemented

English | [中文](2026-09-12-evolution-controller-journey-cli.zh.md)

## Problem

`specs/improvement.spec.md` Phase 6 named four surfaces still missing after the first CLI slice: the `evolutionController` Remote namespace (the Web journey's host half), the two deferred read-model gaps, session export, and the `/learn` + `/suggestions` verbs. Only the CLI existed, so a client had no way to read or edit a scope, the timeline could not say which document moved or how many staged writes a human had decided, and a human could not export a session or ask the harness to learn something.

The two read-model gaps were recorded as deferrals rather than guesses: `stagedApproved` / `stagedRejected` needed a resolution record the store dropped on decision, and `instructions` / `profile` deltas needed per-family write stamps the record did not keep.

## Decision

`@deepseek-ai/dsh-evolution-controller` publishes the `evolution` Remote namespace over the durable per-scope record: `read`, `setInstructions`, `setLessons`, `setProfile`, `addContextItem`, `removeContextItem`, `rebuildMemory`, `listStaged`, `approveStaged`, `rejectStaged`, `timeline`, and the `follow` stream. The request key is the frozen `scopeId`, typed as the Workspace identity: the controller namespaces it with its required `profile` config, so a client never names a scope namespace itself. Every verb resolves the Workspace through the registry first and fails `workspace/not-found`; the staged verbs additionally prove the entry belongs to the resolved scope, so another scope's id is reported `evolution/staged-not-found` rather than decided. `follow` subscribes to `domain/changed`, keeps only `evolution_memory.records` writes, ignores tombstones, maps a record key back to its registered Workspace by recomputing that Workspace's storage key, and pushes one upsert per follower after a single baseline carrying every registered scope. Reconnect stays in the client transport: one `follow` call is one generation, with no retry bookkeeping in the host.

The timeline verb reuses `scopeTimeline` from `dsh-command-evolution` instead of restating it, so `/journey` text and the Remote timeline cannot disagree.

With the store's resolution ledger and per-family stamps landed, `scopeTimeline` now emits `instructions`, `lessons`, and `profile` deltas from their own stamps (each attributed to the extraction whose instant matches, or to a hand edit) and counts `stagedApproved` / `stagedRejected` per day from `resolutions`, keeping a decision-only day active in the model. A record whose lessons/profile stamps are absent — the one-release window the store keeps `memoryUpdatedAt` for — still reads as one `lessons` delta from its extraction or from `memoryUpdatedAt`, so pre-existing records keep their previous account instead of losing it. The rendered day line names the separated kinds and the decided counts; the CLI grammar and the window semantics (zero-filled bounded ranges, data-only `all`) are unchanged.

`/trajectory [--out <path>] [--all]` exports the invoking session, or the invoking scope with `--all`, through the frozen `ctx.evolutionTrajectory` API (resolved with `ctx.get`, so a composition without the exporter answers honestly) and reports the written path with its conversation and byte counts. `/learn <anything>` builds a prompt that names the topic, the existing read/search/web tools, and the proposal-gated `skill_manage` save, then queues it as the sole ordinary message of one follow-up turn; the command writes nothing itself. `/suggestions` lists the skills whose frontmatter carries a `blueprint`, reading the parsed field or the frontmatter bag it was parsed from and rejecting unaccepted shapes, and states that it installs no schedule.

## Verification

`packages/evolution/evolution-controller/tests/controller.host.spec.ts` drives the real store over the memory storage backend: empty and populated projections, the three document writes, text and file context items with the containment refusals (missing path, directory, the Workspace root itself, outside the root, a vanished root, a vanished separator-suffixed root, a junction), rebuild success plus the unmounted reviewer and both failure mappings, staged listing and scope-checked approvals and rejections, timeline ranges and the unknown-range rejection, and the follow stream (one baseline per scope, ignored foreign domain/table/tombstone/other-profile writes, upsert on a real write, aborted generations, and teardown closing an active follower).

`packages/evolution/command-evolution/tests/journey.spec.ts` pins the pure model against a fixed clock, including the per-family separation, the single-stamp cases, the decision counts with a decision-only day, and the rendered kinds. `packages/evolution/command-evolution/tests/command-evolution.spec.ts` pins the new commands through the real registry: the trajectory grammar matrix, session and scope exports with the counts and pluralization, the unmounted exporter, the outside-scope refusal, both failure paths, `/learn`'s usage, the queued message and its prompt content, and `/suggestions`' usage, unmounted registry, blueprint filtering across both surfaces, malformed shapes, the honest empty state, and the no-cwd lookup.

Both source trees hold 100% per-file coverage in their own package runs, and the README pairs are recorded with `verify-translation-pairing`.

## Consequences

A Web client can now read and edit a scope, decide its staged writes, and render its journey from one namespace, and the CLI gained export, learn, and suggestion verbs — all without a new session event, a new domain, or new durable state. The read model keeps one definition across two consumers.

The costs are explicit. The controller's `profile` is deployment configuration, so a client that names the wrong Workspace id learns `workspace/not-found` rather than a scope mismatch. `/learn` depends on the composed agent's tools: without `skill_manage` the turn cannot save anything, which the prompt states instead of hiding. `/suggestions` reads a blueprint from whichever surface discovery publishes it — a tolerance that costs a malformed shape being silently unsuggested rather than reported, and one file load per listed skill, because the catalog's summary type carries no frontmatter.

The earlier note's two deferrals are closed: `2026-09-12-command-evolution-governance.md` records them as open gaps, which the store's resolution ledger and per-family stamps have since closed, and its `/journey` paragraph describes the pre-split account of an `updatedAt`-only record.

## Alternatives considered

**Derive the approval counts from `command/run` events.** The session-query seam returns event records without payloads, so a count would cost one read event window per command event — an N+1 read for a number the store can keep for free. The resolution ledger won.

**Restate the timeline in the controller.** Two read models over one record drift the first time a bucket changes. The controller imports `scopeTimeline` even though that means a host service package peer-depending on a command package.

**Name the wire key `workspaceId`.** The frozen cross-slice interface names `timeline({ scopeId, range })`; inventing a second spelling for the same identity in the same namespace would have been a permanent inconsistency for one naming preference.

**Require one blueprint surface from the skill packages.** Waiting on a `SkillSummary.blueprint` field would have left `/suggestions` unimplementable this wave, and the reading code is four lines either way.

**Let `/learn` write the skill itself.** A command that writes a skill file bypasses the proposal gate `skill_manage` owns, which is exactly the guarantee the gate exists to provide; queueing a prompt keeps the human's approval in the path.

## Related

Supersedes the two deferred read-model claims and the `/suggestions` deferral recorded in [Evolution governance commands](2026-09-12-command-evolution-governance.md).

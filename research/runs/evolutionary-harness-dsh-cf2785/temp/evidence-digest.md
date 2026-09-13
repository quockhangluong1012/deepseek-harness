# Evidence digest (Step 9) — top claims + verbatim quotes

## Claim 1 — Closed learning loop without privileged core patch
> "The evolution family adds a closed learning loop on top of the harness without patching a privileged core: durable per-scope memory records with staged writes, background turn review, scheduled skill curation, and long-horizon safety rails." — packages/evolution/README.md:12
> "Every learned write is capped, staged when configured, logged, and rollback-capable; removing the rows restores byte-identical legacy behaviour." — packages/evolution/README.md:12

## Claim 2 — Scope identity + storage layout
> "One durable record per `(profile, scope)` in storage domain `evolution_memory`, version `1`, layout `per-record`, table `records`, keyed by the opaque id `profile:workspaceId` or `profile:global` and stored under the path-safe `storageKey()` encoding `<profile>--<workspaceId>`" — specs/evolutionary-harness.spec.md:54
> "With the shipped `storage-json` backend that is one document per scope at `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json`." — specs/evolutionary-harness.spec.md:54

## Claim 3 — Parts table (what reaches model / counts capacity)
Subsystem Parts table: Instructions/Lessons/Profile/Context → model yes + capacity yes; Outputs → "no — a navigation index" + no; Staged → "no — pending until approved" + no. — docs/subsystems/evolutionary-harness.md:11-18

## Claim 4 — Output indexing always, extraction gated
> "Completed turns trigger extraction; output indexing always runs" — packages/evolution/evolution-reviewer/README.md:40 (`enabled` row)
> "`ctx.on('session/event', …)` filtered to `turn/end`. Resolve scope, return when none. One backward scan to most recent `turn/start` feeds output indexing (always) and extraction (when gated)." — specs/evolutionary-harness.spec.md:199
> "Skipped when `review.enabled` false, cooldown unelapsed, or admitted text under `minTurnTextBytes`." — specs/evolutionary-harness.spec.md:202

## Claim 5 — Deterministic extraction call
> "Deterministic: `temperature: 0`, reasoning disabled via `purpose: 'evolution-review'`, `maxTokens: maxOutputTokens`, `deadline(signal, timeoutMs)`." — specs/evolutionary-harness.spec.md:212
> "Transcript admits only human `user/message` (`data.source.kind === 'user'`) and `assistant/message`. Injected context (brief itself, instructions, time, references) never fed back." — specs/evolutionary-harness.spec.md:204

## Claim 6 — One brief per session, digest-gated
> "One brief per Session, replaced on change. Digest compare against newest visible `source.kind === 'evolution-memory'` message; equal → nothing; different/absent → exactly one complete fresh brief." — specs/evolutionary-harness.spec.md:184
> "Digest covers instructions, lessons, profile, and context only — never outputs, staged, resolutions, or timestamps." — specs/evolutionary-harness.spec.md:111

## Claim 7 — Timeline is a pure read model
> "Read model and rendering behind `/journey`: one scope's recorded evolution activity, bucketed on the dashboard calendar (UTC+7)… The model is pure — the command supplies the record it already read, so this module touches neither storage nor the session log, and the Remote controller reuses it unchanged." — packages/evolution/command-evolution/src/journey.ts:1-7
> "**The read model lives once.** `scopeTimeline` is imported from `dsh-command-evolution`, so `/journey` text and the timeline verb can never disagree about a bucket." — packages/evolution/evolution-controller/README.md:93

## Claim 8 — Curator cadence + transitions
> "Triggered by inactivity (`intervalHours:168`, `minIdleHours:2`)." — specs/evolutionary-harness.spec.md:233
> "`active → stale (30d) → archived (90d)` into `.archive/`." — specs/evolutionary-harness.spec.md:235
> "Only `origin: 'background_review'` sets `createdBy: 'agent'`… Foreground creates are user-directed and never auto-managed." — specs/evolutionary-harness.spec.md:131

## Claim 9 — Web-app-only composition, machine-local
> "Evolution rows go in `web-app` bundle first, not `base`, so `headless`/`sdk`/`acp` snapshots stay byte-identical until explicitly adopted." — specs/evolutionary-harness.spec.md:47
> "Both memory and skills stay machine-local under `$DSH_HOME`; neither writes inside the user's project directory." — specs/evolutionary-harness.spec.md:11
> "Disabling is removing rows: no records read, no brief, no extraction, sidebar falls back." — specs/evolutionary-harness.spec.md:284

## Claim 10 — Trajectory + scorer outer loop
> "`dsh-evolution-trajectory` writes finished Sessions as ShareGPT conversation files for evals and reinforcement-learning data." — packages/evolution/evolution-trajectory/README.md:12
> "A Session with no admitted message exports an empty array instead of failing." — packages/evolution/evolution-trajectory/README.md:12
> "Scores a recorded corpus run: workspace-diff pass, metered tokens, and median-of-N wall time" — packages/evolution/README.md (scorer row)

# Improvement Roadmap — Evolution Harness Phases 0–6

**Status:** specification. This document owns the improvement roadmap. The behaviour contract it refines lives in `specs/evolutionary-harness.spec.md`; the research input is `specs/export_3885769945348689126_1.md` plus the three review plans (spec-review, hermes-improve-deepdive, evolution-visibility-journey).

File-name note: the user-typed `improment.spec.md` is standardized to `improvement.spec.md` throughout.

## Phase 0 — Spec hygiene and baseline truth

### Implemented vs planned

Implemented:

- `evolution-memory` store (`packages/evolution/evolution-memory/src/index.ts`): 15-entry surface counting `read`/`usage`/`digest` — `read, usage, digest, setInstructions, setLessons, addLesson, replaceLesson, removeLesson, setUserProfile, addContextItem, removeContextItem, stageWrite, approveStaged, rejectStaged, recordOutputs` — plus `storageKey()` / `scopeIdFromStorageKey()` `--` encoding for the JSON backend.
- Reviewer in-process (`packages/evolution/evolution-reviewer/src/index.ts`): per-turn output indexing plus gated background extraction.
- Injector (`packages/context/evolution-memory-context/src/index.ts`): pre-step brief injection with digest-gated replacement plus scope nudges.
- Purpose union `packages/llm/llm/src/types.ts:458`: `purpose?: 'compaction' | 'session-title' | 'workspace-memory' | 'evolution-review'`.
- Reasoning disable `packages/llm/llm-deepseek/src/serialize.ts:84`: `purpose: 'evolution-review'` (with `'session-title'` and `'workspace-memory'`) resolves to `{ thinking: 'disabled' }`.
- Spec hygiene: `specs/evolutionary-harness.spec.md` typo fix with per-phase implemented-vs-planned banner and `--` storage example.
- Telemetry (`packages/skill/evolution-skill-telemetry/src/index.ts` + `src/types.ts`): `evolution_skill_usage` domain storing exactly `SkillUsageRecord`, `markAgentCreated()` as the only `createdBy: 'agent'` path, bundled/hub exclusion, `skill`-tool post-execute use hook.
- Executor (`packages/skill/evolution-skill-manage/src/index.ts` + `src/files.ts`): `skill_manage` with `create | patch | edit | write_file | remove_file | delete`, `createDir` with `~` / `${VAR}`, telemetry `markPatched` wiring, pin-blocked delete.

Implemented since (all landed after this list was written): the curator (`packages/evolution/evolution-curator`), budgets (`packages/guard/budgets`), fallback (`packages/llm/llm-fallback`), `parallelScopeKey` (`packages/tools`), defer queue, FTS5 recall with the lean squeeze (`packages/evolution/evolution-reviewer`), skill frontmatter gating and trust (`packages/skill/skill-filesystem`), curator trigger and consolidation, trajectory exporter (`packages/evolution/evolution-trajectory`), scorer (`packages/evolution/evolution-scorer`), controller (`packages/evolution/evolution-controller`), Web journey page (`packages/client/ui-evolution`), and the CLI verbs `/suggestions`, `/trajectory`, and `/learn` (`packages/evolution/command-evolution`).

Still deferred: GEPA and the `maxCostUsd` cost ceiling (no pricing source exists).

### Spec hygiene (fixed)

- Rename `specs/evolutary-harness.spec.md` → `specs/evolutionary-harness.spec.md` (typo fix).
- Update exactly two verbatim links: the `docs/subsystems/evolutionary-harness.md` Source pointer and `packages/evolution/evolution-memory/README.md:93`.
- Replace the whole-file `Nothing below is implemented` banner with this per-phase implemented-vs-planned split. No phase below claims a blanket unimplemented state.

### Storage-key encoding

- External identity is opaque: `EvolutionScopeId(profile, workspaceId?)` builds `'profile:workspaceId'` or `'profile:global'` (`packages/evolution/evolution-memory/src/index.ts:66-73`); profile and scope must be non-empty and free of `':'`.
- Internal file encoding stays `storageKey()` `<profile>--<workspaceId>` / `<profile>--global` because `storage-json/src/per-record-unit.ts:39` `SAFE_KEY_RE` forbids `':'`. If `storage-json` ever moves `evolution_memory` to SQLite instead of `--`-encoding, keep the opaque-key sentence and drop the JSON filename example.

### Store truth (reuse: `packages/evolution/evolution-memory/src/index.ts`, `src/types.ts`, `src/digest.ts`)

- Stale-name fixes, verbatim: `setMemory` → `setLessons`; `maxMemoryBytes` → `maxAgentBytes` / `maxUserBytes`.
- Stamping family: `setLessons` / `setUserProfile` / `addLesson` / `replaceLesson` / `removeLesson` stamp `memoryUpdatedAt`; staged approve stamps it only when `memoryTouched`.
- Caps: `setInstructions` is bounded only by `capacityBytes`; lessons/profile/item writes throw `evolution/too-large` against `maxAgentBytes` (65536) / `maxUserBytes` (32768) / `maxContextItemBytes` (262144); over-capacity or over-count throws `evolution/capacity-exceeded`.
- Errors: six `RemoteError` codes — `evolution/too-large`, `evolution/capacity-exceeded`, `evolution/item-not-found`, `evolution/ambiguous-match`, `evolution/staged-not-found`, `evolution/extraction-failed` — plus the plain-`Error` contract for caller bugs (empty lesson/oldText, bad staged kind/op/gist, unstarted store, bad profile/scope). Failed writes never mutate the record; ambiguous substring rejects with bounded candidates (`MAX_AMBIGUOUS_CANDIDATES = 5`).
- Staged semantics: explicit-only staging; skill-kind approve only drops (the approver performs the skill write before approving); a failing memory-kind op keeps the entry staged and propagates; duplicate-drop touches nothing except `updatedAt` (never `memoryUpdatedAt`); `findStagedScope` is O(n) over scopes.
- Rival patterns named and rejected: do not copy the full-record transform of workspace-memory; do not reuse `evolution_memory/records` for any ledger.

### Composition, wire, docs (reuse verbatim)

- Composition is web-app-first, never `base` / `sdk-minimal`: evolution rows land in the web-app bundle first so headless/sdk/acp snapshots stay byte-identical until adopted. Client triple applies only where a client face ships.
- Controller shape: `super(ctx, 'evolutionController', { namespace: 'evolution' })`, reusing `workspace/not-found` for scope-first verbs and the `follow` baseline/upsert/idle-abort pattern.
- Session-format split: the brief needs no bump; `budget/exceeded` + `llm/fallback` are durable events that bump `SESSION_FORMAT_VERSION` with adjacent migration plus both SDK projections.
- Locale: browser copy is locale-owned; CLI/wire stays English-stable.
- Scenario: `snapshots/web/` plus enumerated gates; `docs/architecture.md` gains exactly 2 map rows; HMR proof runs on the JSON backend; `type-equiv` rows are conditional on the session-format split.

## Phase 1 — Inner-loop safety (budgets, fallback, concurrency)

### Implemented vs planned

- Implemented: current ceilings stay (`maxSteps:100`, `maxRequestRetries:10`, `maxParallelToolCalls:10`); `maxTokens` remains the per-request cap, distinct from turn budgets. `dsh-budgets` guard plugin, `dsh-llm-fallback` listener, and `defineTool.parallelScopeKey(args): string` all ship, with `write` / `edit` / `str_replace_editor` declaring their path scope.
- Planned: nothing on this phase. The reviewer defer queue is Phase 2.

### Budgets (`dsh-budgets`, guard group)

- New guard plugin copying the `guard/timeout-policy` wrapper and `repeat-tool-reminder` counting. Never patch the `agent-loop/src/agent.ts` driver.
- Enforcement points: `agent/turn-stopping` serial listener receiving `{ agent, turn, signal }` (steer vs `signal` abort → `turn/end aborted`) plus early-reject at `agent/pre-step`.
- Inputs: `tokenMeter.measure(session, requestHeader?)` + `contextPressure.projectedTokens` checked against Config `{ maxTotalTokens?, maxToolCalls?, maxWallMs? }` before the step and `maxCostUsd` after (a new pricing source is required for cost).
- v1 adds no `TurnEndReason`. The durable `budget/exceeded` event shipped as a required-on-read member (no `SESSION_FORMAT_VERSION` bump: ordinary event additions never bump, and `llm/fallback` is the shipped precedent); it carries the ceiling name, the observed value, the limit, and the rejected turn/step. Merge-extension and invariant coverage stay with the upgrade path.

### Fallback (`dsh-llm-fallback`, llm group)

- Downstream of `llm-retry` on the `agent/request-error` waterfall. The spec records order, retry-count consumption, `providerRetryAfterMs`, and breaker durability (session projection).
- The durable `llm/fallback` event fires only when `llm/retry` does not already carry `attemptedRoutes`. Key rotation needs a new interface; it is not bolted onto the breaker.

### Concurrency (`parallelScopeKey`)

- `defineTool.parallelScopeKey(args): string` joins `DefineToolOptions` + `ToolDefinition` (`tools/src/schema.ts:487-551`, today only the binary `isConcurrencySafe`).
- The native scheduler consults it in `fillPool` before PTC; PTC keeps `maxParallelSubCalls:10` with no PTC behavior change.
- Semantics: same-key mutating calls serialize (exclusive barrier / sub-pool); distinct keys still pack to `maxParallelToolCalls`.
- Shipped declarations: `write` and `edit` key on `file_path`, `str_replace_editor` on `path`, each the platform `node:path` normalization of that argument, so one key spans all three tools. Case-insensitive aliases and symlinks stay outside the key; a guarded mutation racing through one fails closed with `FS_STALE_VERSION`. Read-only tools keep the unscoped parallel declaration.

### Corrected claims (verbatim reuse, no redesign)

- `toolOrder` is assembly-time: `orderTools` runs at `assemble()` and shape failures surface at load, not on the first turn.
- Persona is global-only: per-agent persona fields are dropped in favor of preset shadowing.

## Phase 2 — Memory recall and continuity (Hermes 3-layer + Honcho)

### Implemented vs planned

- Implemented: `dsh-evolution-reviewer` in-process extraction and output indexing with the defaults below, plus the brief injector fork `dsh-evolution-memory-context` (digest-gated `agent/pre-step` brief, `maxBytes` + `profile` required).
- Implemented since: the reviewer defer queue (`defer`/`deferMaxAgeMs`, coalesced per session, in-memory), the injector nudge cadence (`memoryNudgeInterval`/`skillNudgeInterval`), FTS5 recall (ranked cross-session cwd-scoped `searchSessions`/`searchEvents` via `session-query-sqlite`), and lean squeeze (`squeezeLessons` with `MEMORY_HEADINGS` pressure order between extractor output and store write).
- Deferred: Honcho user-fact table (traits/confidence/decay). Keep `userProfile: string (maxUserBytes: 32768)` + provenance; a future user-fact table runs parallel, never inside `contextItems`.
- Reuse paths: workspace-memory `render.ts` + `index.ts`, `workspace-memory-llm/src/index.ts`, `session-query-sqlite/schema.ts` + `query.ts`, `compaction-basic` checkpoint, `MEMORY_HEADINGS`.

### Brief injector (implemented fork of the workspace-memory injector)

- `dsh-evolution-memory-context` is a fork of the workspace-memory injector: title, sections, usage line, and drop order all differ, so reuse is verbatim-copy, not shared code.
- Reuse `render.ts` (`escapeFrameBody`, `truncateUtf8`, `unavailableFileLine`, drop/truncate notice) and `index.ts` (`newestVisibleDigest` vs `source.kind === 'evolution-memory'`, `workspaceBySession` cache + `session/disposed` invalidation, non-prepended spread preserving `startsRequestSeries`, `ctx.get('fs')` fallback to `node:fs/promises`, `section()` / `variable()` + `toolOrder` assembly-loud).
- Frame `<system-reminder>`; drop order context → lessons/profile → instructions; budget `maxBytes` (required).

### Reviewer (implemented, fork of `workspace-memory-llm/src/index.ts`)

- `observeTurn` scans backward to `turn/start`; `indexOutputs` always runs over `file_path | path` excluding `view` / `undo_edit` and keeping only inside-scope paths.
- Gated extraction defaults verbatim: `enabled: true`, `minTurnTextBytes: 200`, `cooldownMs: 60000`, `maxInputBytes: 131072`, `maxOutputTokens: 1024`, `timeoutMs: 60000`, `rebuildSessionLimit: 20`, `outputTools: ['write', 'edit', 'str_replace_editor']`.
- Call: `temperature: 0`, `purpose: 'evolution-review'`, `deadline(signal, timeoutMs)`; route precedence is configured provider+model pair, else the session header route, else skip-with-warning (rebuild with no route rejects `evolution/extraction-failed`); UTF-8 truncation flags `truncated: true`; terminal-finish semantics; document headings `## Purpose/Preferences/Decisions/References`; prohibitions on code-derivable content, credentials, and health/race/religion/political/gender data; teardown and `session/disposed` abort in-flight work; usage persisted with `task = 'evolution_review'`; provenance stamped as `EvolutionExtraction { origin: 'foreground' | 'background_review' | 'user-edit' | 'rebuild' }`.
- Same-model forks keep byte-identical prompts/tools for cache reuse; different-model forks replay a compact digest (recent verbatim + older summary).
- Whitelist: memory / skill-manage / read-only-file / session-query tools only; `extraTools[]` must already exist on the parent.
- Defer is reviewer-owned (`Map<sessionId, { snapshot, timer }>`): `defer: 'auto' | 'never'` + `deferMaxAgeMs: 1800000` with coalesce/preempt/force semantics, distinct from `deferContext`; explicit `/refine` is always immediate.

### FTS5 recall, squeeze, Honcho

- FTS5 recall keeps the `storage-sqlite` KV store and reuses read-only `session-query-sqlite/schema.ts` (`persisted_docs` / `live_docs USING fts5`, `unicode61`) + `query.ts`; rebuild and injection-retrieval switch to ranked cross-session cwd-scoped `searchSessions` / `searchEvents` (auth pattern of `tool-session-query`, never the tool itself); `filterEvents` stays for exact scans.
- Lean squeeze sits between extractor output and store write (reusing `MEMORY_HEADINGS` + pressure order); the `compaction-basic` checkpoint is untouched.
- Honcho: DEFER traits/confidence/decay; keep `userProfile: string (maxUserBytes: 32768)` + provenance; a future user-fact table runs parallel, never inside `contextItems`.

### VERIFIED vs HEARSAY

- VERIFIED (read primary): curator/Honcho/memory-providers/self-evolution `$2–10` figures, Phase-1 guardrails.
- HEARSAY (never used for sizing): labels `TAO`, `≥3 repeats`, `~30K/event`, GEPA `10–20 variants` and Pareto axes. Any reuse must keep the hearsay mark.

## Phase 3 — Skill lifecycle (frontmatter, scan/trust, telemetry, writer)

### Implemented vs planned

- Implemented: `evolution_skill_usage` telemetry matching `SkillUsageRecord` (`packages/skill/evolution-skill-telemetry`) and the `skill_manage` executor (`packages/skill/evolution-skill-manage`); scan-lite / gating / read-only telemetry landed before the writer, per the mandatory ordering.
- Implemented since: the frontmatter allowlist's parse half (`required_env`, `config`, warn-and-keep for unknown keys), load-time `skills.config` injection and `required_env` passthrough (`packages/skill/tool-skill/src/load.ts`), `discoverRoot` security scan (4 lexical rules: pipe-to-shell, encoded-shell, root-delete, credential-exfiltration; `packages/skill/skill-filesystem`), quarantine (skip-with-warning + `quarantinedCount`), 2-level precedence (layer-shadows-rank with `PROJECT_DSH 100 / PROJECT_AGENTS 200 / RUNTIME 250 / CUSTOM 300 / USER_DSH 400 / USER_AGENTS 500 / BUNDLED 600`), and trust allowlist (`trustedProjectDirs`, `projectDiscovery: false`).
- Implemented computation, not yet wired to a consumer: counted trigger (`skillCreationEvidence(paths)` with `SKILL_CREATION_OUTPUT_THRESHOLD = 3` in `packages/skill/evolution-skill-telemetry`). The reviewer indexes produced files at `turn/end` but does not feed `record.outputs[].path` through the evidence counter or propose skills when it fires.
- Reuse paths: `ParsedSkill` + `parseSkillFile` (`skill-filesystem:~L797`), `collectFresh`, `tool-skill` execute/catalog hooks, `ctx.fs` + `observeHostMutation`.

### Frontmatter allowlist

- Allowlist on `ParsedSkill` + `parseSkillFile` (today at `skill-filesystem:~L797`: `name` kebab-required, `description` required, `whenToUse?`, `metadata?`, invocation booleans; extras silently ignored).
- Shipped: `metadata`-passthrough plus `required_env` / `config` parsed onto the skill, with unknown top-level keys warn-and-keep. `${DSH_SKILL_DIR}` / `${DSH_SESSION_ID}` also shipped in `tool-skill`. Implemented: `skills.config` injection and `required_env` passthrough on load (`packages/skill/tool-skill/src/load.ts`). Still deferred: shell expansion, `blueprint`, and `references/`.

### Scan, quarantine, precedence

- Scan runs at `discoverRoot` between parse success and candidate push; hash cache is realpath+mtime (or list-time-only).
- Quarantine is skip-with-warning plus `quarantinedCount` on `skills/change` via the host log, never the model catalog.
- Precedence is 2-level: `collectFresh` layer-shadows-rank, with in-layer rank `PROJECT_DSH 100 / PROJECT_AGENTS 200 / RUNTIME 250 / CUSTOM 300 / USER_DSH 400 / USER_AGENTS 500 / BUNDLED 600`; project root is `.git` else cwd. Identity is `(scope-chain, name)` → winner.
- All implemented: scan/quarantine/precedence in `packages/skill/skill-filesystem/src/index.ts`, registry aggregation in `packages/skill/skill/src/index.ts`.

### Telemetry (`evolution_skill_usage`)

- New domain `evolution_skill_usage` stores exactly `SkillUsageRecord` (never bolted onto `SkillSummary`):

```ts
interface SkillUsageRecord {
  useCount: number; viewCount: number; patchCount: number;
  lastUsedAt: string | null; lastViewedAt: string | null; lastPatchedAt: string | null;
  createdAt: string; state: 'active' | 'stale' | 'archived';
  pinned: boolean; createdBy: 'agent' | 'foreground' | null;
  absorbedInto: string | null; archivedAt: string | null;
}
```

- Only `origin: 'background_review'` via `markAgentCreated()` sets `createdBy: 'agent'`; bundled and hub skills are excluded from writes; hooks sit at `tool-skill` execute/catalog.
- `skillCreationEvidence(paths)` computation exists (`SKILL_CREATION_OUTPUT_THRESHOLD = 3` in `packages/skill/evolution-skill-telemetry`) but consumer wiring (reviewer feeding `record.outputs[].path` through the evidence counter) is the remaining gap.

### Executor, trigger, cost, trust

- Implemented: `skill_manage` executor (`packages/skill/evolution-skill-manage`) with `create | patch | edit | write_file | remove_file | delete` verbs, gated by `writeApproval`. Trust allowlist (`trustedProjectDirs`, `projectDiscovery: false`) shipped. Counted trigger computation (`skillCreationEvidence(paths)`) exists but consumer wiring remains.
- Not yet recorded: cost rows `{ inputBytes, maxOutputTokens, provider, model, truncated }`.

## Phase 4 — Curator GC + ledger

### Implemented vs planned

- Implemented: `dsh-evolution-curator` (`packages/evolution/evolution-curator`): host-owned interval+idle trigger (`intervalHours: 168`, `minIdleHours: 2`, `tickMinutes: 15`), always-on auto-transitions (`active → stale 30d → archived 90d`), content-addressed JSONL ledger (`packages/evolution/evolution-curator/src/safety.ts`), tar.gz pass backups (keep 5), reversible fail-closed rollback (whole pass + single entry, pre-rollback snapshot), `adopt` (manual-only, no clock reset), `purge` (TTL-gated, `--dry-run` preview, skip pinned), opt-in LLM consolidation (two-tool whitelist, full-package rule), and `pin` enforcement (blocks auto-transitions + `skill_manage delete`; patch still allowed). Hub skills always exempt; protected built-ins filtered.
- CLI gaps (service layer supports these verbs but `/curator` CLI only exposes `status` and `run [--dry-run]`): `adopt <name>`, `purge [--dry-run]`, `backup`, `rollback [--id <id>]`, `ledger`, `pin <name>`, `unpin <name>`.
- Reuse path: none for the ledger (reusing `evolution_memory/records` would break capacity/digest, so it is forbidden).

### Trigger and transitions

- Trigger is interval+idle with `intervalHours: 168`, `minIdleHours: 2`, driven by the CLI start, gateway housekeeping, and `serve` maintenance timer under a new owner (the `schedule` facility is session-local and insufficient). First run seeds `lastRunAt` and defers one interval. `run --dry-run` previews. Implemented in `EvolutionCurator`.
- Auto-transitions are always on: `active → stale 30d → archived 90d` into `.archive/`; skip pinned and schedule-referenced skills (even paused/disabled; consolidation rewrites refs on merge); never-used grace applies; `pruneBuiltins: { true }` with hub exemption; never auto-delete.

### Ledger, backup, rollback, governance

- All implemented in `packages/evolution/evolution-curator`: content-addressed JSONL ledger (`src/safety.ts`), tar.gz pass backups (keep 5), reversible fail-closed rollback (whole pass + single entry, pre-rollback snapshot), `adopt` (manual-only, no clock reset), `purge` (TTL-gated, `--dry-run` preview, skip pinned), and `pin` enforcement (blocks auto-transitions + `skill_manage delete`; patch still allowed).
- CLI gaps: `adopt <name>`, `purge [--dry-run]`, `backup`, `rollback [--id <id>]`, `ledger`, `pin <name>`, `unpin <name>` remain to be wired to the service layer.
- Consolidation is opt-in (`consolidate: false`) and only after ledger + budgets + a cheaper aux model exist.
- Full-package rule: a skill shipping `references / templates / scripts / assets` must be kept standalone, re-homed with rewritten paths, or archived whole — never flattened to `SKILL.md` alone.

## Phase 5 — Outer loop (trajectory, scorer, GEPA)

### Implemented vs planned

- Implemented: ShareGPT trajectory exporter (`packages/evolution/evolution-trajectory`) beside `session-log-export`, reading `filterEvents` + persistence with SDK/ACP collection seam and `/trajectory [--out <path>] [--all]` CLI. Scorer triple (`packages/evolution/evolution-scorer`) reusing `test-support/session-snapshot` + `llm-replay` + `snapshots/` corpus: pass/workspace-diff + billed tokens via `tokenMeter.measure` + bench-style wall time (median-of-N, fresh process; `benchmarks/` gates).
- Deferred: GEPA fan-out, Hub/quarantine/lock, blueprints→cron, reviewer-fork upgrade. Reuse paths: `workflowEngine` + `subagents` spawn/fork. Self-evolution guardrails: suite passes, ≤15KB change, no mid-conversation change, semantic preservation, human-reviewed PR, never direct commit.

### Trajectory exporter

- New ShareGPT exporter beside `session-log-export`, reading `filterEvents` + persistence. SDK/ACP streams are the collection seam; `ui-trajectory` is only a view.

### Scorer

- Reuse `test-support/session-snapshot` (closed `snapshot.yml`, canonical logs, redaction/normalization, `workspace.expected/` compare, adapters, record/replay/refresh) + `llm-replay` (first-call-order, override sidecar, `assertConsumed`) + the `snapshots/` corpus.
- Metric triple: pass/workspace-diff + billed tokens via `tokenMeter.measure` + bench-style wall time (median-of-N, fresh process; `benchmarks/` keeps the perf gates).

### GEPA (deferred)

- Fan-out of 10–20 variants via `workflowEngine` + `subagents` spawn/fork (one-shot byte-identical prefix); Pareto on (success↑, tokens↓, ms↓) ships as a `consolidate` extension or an `evolution-gepa` package.
- Self-evolution guardrails: suite passes, ≤15KB change, no mid-conversation change, semantic preservation, human-reviewed PR, never direct commit; per-variant ceilings come from budgets (`$2–10`-equivalent).
- Also deferred: Hub/quarantine/lock, blueprints→cron.
- Reviewer-fork upgrade (warm cache vs compact digest, `defer: auto` queue, whitelist, `/refine`) waits until the subagent path is proven; the in-process cheap default stays.

## Phase 6 — Visibility journey (seeing improvement day by day)

### Implemented vs planned

- Implemented: `read(scopeId)` diff source, `usage()` + `digest()`, `filterEvents` time/seq/type/surface filtering, `dayKeyUTC7` / `daysOfRange` / `windowStartOfRange` (now re-exported from the `dsh-usage-ledger` root), `summarizeLedger` / `sweepRetention`, `ui-workspace-memory` controller + `follow` baseline/upsert template, plus the CLI governance slice `/memory pending | approve <id> | reject <id>`, `/skills pending | approve <id> | diff <id>`, `/journey [today | 7d | 30d | all]`, `/curator status | run [--dry-run]`, `/trajectory [--out <path>] [--all]`, `/learn <anything>`, `/suggestions`, and `/refine` (`packages/evolution/command-evolution`, honest empty states, no new domain and no new session event). The `/journey` read model lives in `packages/evolution/command-evolution/src/journey.ts` as exported pure functions.
- Implemented since: `evolutionController` clone (`packages/evolution/evolution-controller`) with all spec'd verbs (read/setInstructions/setLessons/setProfile/addContextItem/removeContextItem/rebuildMemory/listStaged/approveStaged/rejectStaged/timeline/follow scope-first resolving `workspace/not-found`), dual-face `dsh-client-ui-evolution` (`packages/client/ui-evolution`) with journey/pending/curator/capacity cards, CSS Modules + `--dsw-*` tokens, locale `NS = 'evolution'` with zh-source + en-satisfies + `t`, and composition triple in `bundle/web-app/cordis.patch.yml`.
- Remaining: Web scenario `snapshots/web/evolution-journey/` + e2e `apps/web/tests/evolution-journey.e2e.ts`, journey ZIP export (reusing `serializeSessionLog` + `fflate` with `timeline.json`). The two read-model gaps (staged-approved/rejected counts from `record.resolutions`, per-family stamps) are closed.

### Read model (query-time, verbatim types)

```ts
type JourneyDay = string;
type TimelineDeltaKind = 'lessons' | 'context' | 'outputs' | 'staged';
interface TimelineDelta { day: JourneyDay; kind: TimelineDeltaKind; gist: string; sessionId: string | null; at: string; }
interface TimelineDayBucket { day: JourneyDay; deltas: TimelineDelta[]; stagedOpened: number; outputsIndexed: number; contextAttached: number; }
interface TimelineCumulative { usedBytes: number; capacityBytes: number; digest: string; lessonsBytes: number; profileBytes: number; }
interface TimelinePending { id: string; kind: 'memory' | 'skill'; op: string; gist: string; originSessionId: string; createdAt: string; }
interface JourneyTimeline { range: 'today' | '7d' | '30d' | 'all'; now: number; days: TimelineDayBucket[]; cumulative: TimelineCumulative; pending: TimelinePending[]; }
```

- Single source: `read(scopeId)` facts the record proves — `lastExtraction.at` (memory document), `memoryUpdatedAt` (hand-edited fallback), each `contextItems[].addedAt`, each `outputs[].at`, each `staged[].createdAt` — placed on the UTC+7 calendar; cumulative comes from `usage()` + `digest()` plus `utf8Bytes` of the two documents; pending is `staged[]` directly. No session-log join runs today.
- Two spec'd bucket counts now ship from the store: `stagedApproved` / `stagedRejected` read from `record.resolutions` (newest-first, capped by `maxResolutions`) rather than requiring a session-log join; `instructions` / `profile` deltas separate from lessons via the per-family stamps `instructionsUpdatedAt` / `lessonsUpdatedAt` / `profileUpdatedAt`.
- Bounded ranges are zero-filled; `all` is data-only. Live vs shadowed briefs are told apart by `compactionId` + `surface`.
- Poll/diff verbs: `lessons-updated | profile-updated | instructions-updated | staged-proposed | staged-approved | staged-rejected | output-indexed | context-attached | context-detached`; `follow` rides `domain/changed`.

### Controller (`evolutionController`)

- Clone of `ui-workspace-memory/src/index.ts` + `client/rpc.ts` + `types.ts` with the scope key, record fields, and cards swapped: `super(ctx, 'evolutionController', { namespace: 'evolution' })`, `inject = ['typert', 'workspaceRegistry', 'evolutionMemory']`.
- Verbs `read / setInstructions / setLessons / setProfile / addContextItem / removeContextItem / rebuildMemory` (scope-first → `workspace/not-found`) plus separate `listStaged` and `approveStaged(id)` / `rejectStaged(id)` plus `timeline({ scopeId, range })`; stream `follow` emits the baseline for every scope plus upserts filtered on `evolution_memory.records` (Deque + exactly-one-baseline + reconnect inside `RemoteStream`). No new session event.

### CLI (owns governance until Web lands; CLI-first)

- Via `ctx.commands.register` (`parseCommand`, `command/run | done`, `success { text?, sourceEventSeq? } | error { text }`): `/memory pending | approve <id> | reject <id>`, `/skills pending | approve <id> | diff <id>`, `/journey [today | 7d | 30d | all]`, `/curator status` (host-wide, no scope), and `/refine` (`rebuildSessionLimit: 20`) are implemented in `packages/evolution/command-evolution`; `/skills diff` reports the deferred payload shape, and `/suggestions` remains planned with the blueprint frontmatter.
- Never use `approval/request` or `ask_user_question` for staged writes; only reuse the approval-panel idiom + golden.

### Web (dual-face `dsh-client-ui-evolution`)

- Implemented: dual-face package (`packages/client/ui-evolution`) with `journeyPage` / `EvolutionSeat` / `shell.page` + `rpc.ts` / `Page.tsx` / `Seat.tsx` / `locales.ts`; cards for journey/pending/curator/capacity; CSS Modules + `--dsw-*` tokens; locale `NS = 'evolution'` with zh-source + en-satisfies + `t`; composition triple in `bundle/web-app/cordis.patch.yml`.
- Remaining: scenario `snapshots/web/evolution-journey/` + e2e `apps/web/tests/evolution-journey.e2e.ts`.

### Export, scenario, gates

- Journey export reuses `serializeSessionLog` + `fflate` ZIP with a flush barrier and a bundled `timeline.json` (no new manifest).
- Scenario `snapshots/web/evolution-journey/` + e2e `apps/web/tests/evolution-journey.e2e.ts` on `scaffold.ts` (seed/capture/compare/inventory/console-tripwire); clone the `approval-composer` + `lifecycle-chrome/command-menu` goldens.
- Enumerated gates: `verify-cordis-catalog`, config-catalog, translation-pairing, client-packages.
- Proof sketch (read-only, no new code): seed one scope with 2 lessons + 1 staged + 2 outputs across 2 UTC+7 days → `scopeTimeline({ range: '7d' })` yields 2 buckets with the right kinds/counts, 1 pending entry with full fields, cumulative equal to `usage()` + `digest()`; approving the staged entry empties pending and drops the entry, while the approved/rejected counts stay deferred (see the read-model gaps above).

# Evolutionary Harness — Self-Learning / Self-Improving Harness

**Status:** specification. This document owns the behaviour contract — what the harness learns, what the model sees, what the wire carries, what the user can govern, and what proves it correct. Implemented: `dsh-evolution-memory` store with `storageKey()` `--` encoding, `dsh-evolution-reviewer` in-process extraction plus output indexing, `dsh-evolution-memory-context` brief injector, `purpose: 'evolution-review'` with reasoning disabled, `dsh-evolution-skill-manage` plus `dsh-evolution-skill-telemetry`, `dsh-evolution-curator` automatic transitions with snapshots/ledger/rollback/adopt/purge, `dsh-command-evolution` (`/memory`, `/skills`, `/journey`, `/curator`, `/refine`), `dsh-llm-fallback`, `dsh-budgets`, `parallelScopeKey` declarations on the filesystem mutation tools, the reviewer defer queue, the injector's nudge cadence, and the skill frontmatter allowlist, the curator's host-wide interval and idle trigger plus opt-in consolidation under the full-package rule, FTS5 ranked recall with the lean squeeze, skill frontmatter gating with project scan, quarantine, precedence, and trust, `required_env` passthrough and load-time `config` injection with the inline-shell opt-in, the durable `budget/exceeded` event and the shipped key-rotation hook, the ShareGPT trajectory exporter, the corpus scorer, and the `evolutionController` with the browser journey, pending, curator, and capacity surfaces. Planned: GEPA fan-out and the `maxCostUsd` cost ceiling (no pricing source exists). The ordered edit list lives in `specs/improvement.spec.md`; this file is the source text for `docs/subsystems/evolutionary-harness.md` (plus its `.zh.md` / `.i18n.yaml` pair and its `type-equiv` manifest rows) when the feature lands.

## Summary

DeepSeek Harness is an all-plugin Cordis agent harness. Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself.

The Evolutionary Harness adds a closed learning loop on top of that spine without patching a privileged core: the harness continuously learns from user behaviour, curates bounded memory, creates and improves skills during use, reviews turns in the background, maintains the skill library on a schedule, recalls across sessions, and exports trajectories for outer-loop training. The loop is consent-aware, cache-aware, and recoverable: every learned write is capped, staged when configured, logged, and rollback-capable; disabling the rows restores byte-identical legacy behaviour.

The split mirrors Hermes Agent (`hermes-agent.nousresearch.com`, Nous Research, MIT): foreground writes in-turn, background review fork after-turn, curator maintenance on interval+idle, FTS5 recall + lean compaction for continuity, Hub sharing + trajectory export for evolution. Both memory and skills stay machine-local under `$DSH_HOME`; neither writes inside the user's project directory.

## Glossary

- **Workspace** — durable record of a directory the user works in (`ctx.workspaceRegistry`, `packages/workspace/workspace`). Navigation only until memory attaches.
- **Memory record** — durable per-scope document: user-authored instructions plus model-maintained lessons and user profile, keyed by `(profile, workspaceId|global)` in its own storage domain.
- **Brief** — single `<system-reminder>`-framed message assembled from Instructions + Lessons + Profile + Context and injected into a Session.
- **Digest** — sha1 identity of the brief's inputs. The injector compares it against the newest visible brief to decide whether anything must be added.
- **Extraction** — one deterministic LLM call (`temperature: 0`, `purpose: 'evolution-review'`) that rewrites a memory document from a turn transcript or workspace history.
- **Skill** — reusable task instructions discovered from providers and loaded through the session catalog and `skill` tool (`ctx.skills`).
- **Review fork** — background agent run after `turn/end` that replays the turn digest and proposes memory/skill writes without touching the live conversation.
- **Curator** — scheduled maintenance pass over agent-created skills: `active → stale → archived`, optional LLM consolidation into umbrellas, with backup + ledger + rollback.
- **Trajectory** — ShareGPT-format export of sessions for evals and RL training (outer loop).
- **Budget** — token/tool-call/wall ceiling checked before each proposed step; the step is rejected and the turn ends `blocked`. The guard appends a durable `budget/exceeded` record; only the cost ceiling stays deferred (no pricing source exists).

## Package inventory

New packages, plus widened unions in existing packages. Every package follows the repository defaults: ESM, `@deepseek-ai/cordis` as peer + dev dependency, contributions through `ctx.effect()` / `ctx.on()`, README triplet, and a row in the owning group's package table.

| Package | Group | Role |
|---|---|---|
| `@deepseek-ai/dsh-evolution-memory` | `evolution/` (new group, or `workspace/` if group review rejects) | Service Provider for `ctx.evolutionMemory`: two-tier lessons/profile store, caps, provenance, staged writes |
| `@deepseek-ai/dsh-evolution-reviewer` | `evolution/` | `ctx.evolutionReviewer`: per-turn output indexing, gated background extraction, on-demand `/refine` |
| `@deepseek-ai/dsh-evolution-memory-context` | `context/` | Function plugin: renders the brief and splices it into `agent/pre-step` |
| `@deepseek-ai/dsh-evolution-skill-manage` | `skill/` | Consumer on `ctx.tools`: `skill_manage` create/patch/edit/write_file/remove_file/delete |
| `@deepseek-ai/dsh-evolution-skill-telemetry` | `skill/` | Telemetry store: use/view/patch counters, provenance, pin, lifecycle state |
| `@deepseek-ai/dsh-evolution-curator` | `evolution/` | `ctx.evolutionCurator`: interval+idle maintenance, prune + opt-in consolidate, backup/ledger/rollback/purge |
| `@deepseek-ai/dsh-budgets` | `guard/` | Policy plugin on `agent/pre-step`: token/tool-call/wall ceilings reject the next step |
| `@deepseek-ai/dsh-llm-fallback` | `llm/` | Listener on `agent/request-error`: fallback routes + circuit breaker |
| `@deepseek-ai/dsh-client-ui-evolution` | `client/` | Dual-face: host controller + browser journey/pending/curator pages |

Existing code this changes:

- `@deepseek-ai/dsh-llm` — `GenerateOptions.purpose` gains `'evolution-review'` beside `'compaction'` and `'workspace-memory'`; DeepSeek adapter disables reasoning for it. Extraction is deterministic; reasoning tokens buy nothing.
- `@deepseek-ai/dsh-tools` — `defineTool` gains optional `parallelScopeKey(args): string` for semantic concurrency; PTC `maxParallelSubCalls` semantics aligned with native pool.
- `@deepseek-ai/dsh-system-prompt` — no code change; new sections/variables registered from evolution packages through existing `section()`/`variable()` + `toolOrder`.
- `@deepseek-ai/dsh-bundle-web-app`, `@deepseek-ai/dsh-bundle-base` — composition rows. Evolution rows go in `web-app` first, not `base`, so `headless`/`sdk`/`acp` snapshots stay byte-identical until explicitly adopted.
- `docs/architecture.md` — minimal map update only when a new seam/loop-doc changes: one row in `Core packages`, one row in `Where new behavior goes`, link to subsystem. Detail lives in subsystem + READMEs to respect the 2400-word budget.

## Data model

### Evolution memory record

One durable record per `(profile, scope)` in storage domain `evolution_memory`, version `1`, layout `per-record`, table `records`, keyed by the opaque id `profile:workspaceId` or `profile:global` and stored under the path-safe `storageKey()` encoding `<profile>--<workspaceId>` or `<profile>--global`. With the shipped `storage-json` backend that is one document per scope at `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json`.

```ts
interface EvolutionMemoryRecord {
  instructions: string
  agentLessons: string
  userProfile: string
  /** ISO-8601 instant of the last instructions write, or null when never written. */
  instructionsUpdatedAt: string | null
  /** ISO-8601 instant of the last lessons write, or null when never written. */
  lessonsUpdatedAt: string | null
  /** ISO-8601 instant of the last profile write, or null when never written. */
  profileUpdatedAt: string | null
  /** ISO-8601 instant of the last lessons or profile write, or null. Derived as the later of `lessonsUpdatedAt` and `profileUpdatedAt`; kept for one release beside the per-family stamps. */
  memoryUpdatedAt: string | null
  contextItems: readonly EvolutionContextItem[]
  outputs: readonly EvolutionOutput[]
  lastExtraction: EvolutionExtraction | null
  staged: readonly StagedWrite[]
  /** Decided staged entries, newest first, capped by `maxResolutions`. */
  resolutions: readonly StagedResolution[]
  updatedAt: string
}
type EvolutionContextItem =
  | { kind: 'text'; id: string; label: string; text: string; sizeBytes: number; addedAt: string }
  | { kind: 'file'; id: string; label: string; path: string; sizeBytes: number; addedAt: string }
interface EvolutionOutput { path: string; tool: string; sessionId: string; at: string }
interface EvolutionExtraction {
  at: string; sessionId: string; provider: string; model: string
  origin: 'foreground' | 'background_review' | 'user-edit' | 'rebuild'
  inputBytes: number; truncated: boolean
}
interface StagedWrite {
  id: string; kind: 'memory' | 'skill'; op: string
  /** JSON payload the op consumes; the store validates it before persisting. */
  payload: JsonValue
  originSessionId: string; createdAt: string; gist: string
}
/** One decided staged entry, kept so the journey can count approvals and rejections. */
interface StagedResolution {
  id: string; kind: 'memory' | 'skill'; op: string; gist: string
  decision: 'approved' | 'rejected'; at: string; originSessionId: string
}
/** Caller-supplied payload for stageWrite. */
interface StagedWriteInput {
  scopeId: EvolutionScopeId; kind: 'memory' | 'skill'; op: string
  /** JSON payload; a non-JSON value is refused loudly. */
  payload: JsonValue
  originSessionId: string; gist: string
}
```

Invariants:

- **Item ids are generated uuids**, never derived from label or path.
- **Text items store content; file items store a path.** File bytes are read at injection time; `sizeBytes` is the size observed at add time and never refreshed.
- **Capacity** = UTF-8 bytes of `instructions` + `agentLessons` + `userProfile` + Σ `contextItems[].sizeBytes` against `capacityBytes`. `outputs`, `staged`, and `resolutions` excluded.
- **Digest covers instructions, lessons, profile, and context only** — never outputs, staged, resolutions, or timestamps.
- **Per-family writes stamp their own field.** `setInstructions` stamps `instructionsUpdatedAt`; `setLessons` / `addLesson` / `replaceLesson` / `removeLesson` stamp `lessonsUpdatedAt`; `setUserProfile` stamps `profileUpdatedAt`. `memoryUpdatedAt` stays as `max(lessons, profile)` for one release.
- **Resolutions capped** by `maxResolutions` (default 200), newest first, appended by `approveStaged` / `rejectStaged`.
- **A rejected write never mutates the record.** Caps and security scan run before the write chain.
- **Substring replace/remove** requires a unique substring; ambiguous match rejects with candidates; exact duplicate add resolves without writing.

### Skill telemetry record

One record per skill name in domain `evolution_skill_usage`, version `1`, layout `per-record`:

```ts
interface SkillUsageRecord {
  useCount: number; viewCount: number; patchCount: number
  lastUsedAt: string | null; lastViewedAt: string | null; lastPatchedAt: string | null
  createdAt: string; state: 'active' | 'stale' | 'archived'
  pinned: boolean; createdBy: 'agent' | 'foreground' | null
  absorbedInto: string | null; archivedAt: string | null
}
```

Only `origin: 'background_review'` sets `createdBy: 'agent'` via `markAgentCreated()`. Foreground creates are user-directed and never auto-managed. Bundled and hub skills excluded from writes.

## The store: `ctx.evolutionMemory`

`EvolutionMemoryStore extends Service`, `static inject = ['storageDomain']`, domain opened in `[Service.init]` and closed through `ctx.effect`.

```ts
read(id: EvolutionScopeId): EvolutionMemoryRecord | undefined
usage(id: EvolutionScopeId): EvolutionMemoryUsage
digest(id: EvolutionScopeId): string
setInstructions(id: EvolutionScopeId, text: string): Promise<EvolutionMemoryRecord>
setLessons(id: EvolutionScopeId, text: string, extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord>
addLesson(id: EvolutionScopeId, text: string): Promise<EvolutionMemoryRecord>
replaceLesson(id: EvolutionScopeId, oldText: string, content: string): Promise<EvolutionMemoryRecord>
removeLesson(id: EvolutionScopeId, oldText: string): Promise<EvolutionMemoryRecord>
setUserProfile(id: EvolutionScopeId, text: string, extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord>
addContextItem(id: EvolutionScopeId, input: EvolutionContextItemInput): Promise<EvolutionMemoryRecord>
removeContextItem(id: EvolutionScopeId, itemId: string): Promise<EvolutionMemoryRecord>
stageWrite(input: StagedWriteInput): Promise<StagedWrite>
approveStaged(id: string): Promise<void>
rejectStaged(id: string): Promise<void>
recordOutputs(id: EvolutionScopeId, entries: readonly EvolutionOutput[]): Promise<EvolutionMemoryRecord>
```

Semantics mirror `workspace-memory`: synchronous reads from validated memory, absent record reads as `undefined` / zero usage / digest `'empty'`, first write seeds the record, every accepted write stamps `updatedAt` (`setInstructions` stamps `instructionsUpdatedAt`; `setLessons` / `addLesson` / `replaceLesson` / `removeLesson` stamp `lessonsUpdatedAt`; `setUserProfile` stamps `profileUpdatedAt`; `approveStaged` stamps the family of the op it approves and appends a `StagedResolution`), `recordOutputs` returns the record so callers can read the new index without a second read, byte caps throw `evolution/too-large`, capacity/item-count throws `evolution/capacity-exceeded`, unknown item throws `evolution/item-not-found`, items not found within the record throw `evolution/item-not-found`, `recordOutputs` newest-first capped by `maxOutputs` and resolves without writing when unchanged (no `domain/changed` churn), staged-write approvals caller-responsible (resolutions capped by `maxResolutions`), `structuredClone` on read and write. No `./invariant` companion: the domain table is the only copy.

## What the model sees

The brief is one durable `user/message`, appended from an `agent/pre-step` contribution — same mechanism as `dsh-agent-instructions` and `dsh-workspace-memory-context`. Replayable, compactable, reconstructable from the log. No new session event type unless a future structural input requires it (then bump `SESSION_FORMAT_VERSION` with adjacent migration).

```text
<system-reminder>
# Workspace memory: <title>
Directory: <canonical path>
Memory usage: <used>/<cap> (<pct>%)

## Instructions
<instructions>

## Lessons
<agentLessons>

## User profile
<userProfile>

## Context: <label>
<materialized content>
</system-reminder>
```

Rules:

- **Empty sections omitted.** All empty → no message, zero tokens.
- **One brief per Session, replaced on change.** Digest compare against newest visible `source.kind === 'evolution-memory'` message; equal → nothing; different/absent → exactly one complete fresh brief.
- **Budget.** Complete text including frame never exceeds `maxBytes`. Drop order: trailing Context first, then Lessons/Profile truncate, Instructions last. One notice line names what was dropped/truncated. UTF-8 boundary safe.
- **Frame safety.** Literal `</system-reminder>` rewritten to `<\/system-reminder>`.
- **Unavailable files degrade.** Missing/unreadable renders `Context "<label>" is unavailable (<path>).`, step proceeds. Reads via `ctx.get('fs')` when mounted else `node:fs/promises`.
- **Outside any Workspace/scope → nothing.** Membership from registry `sessionIds` falling back to canonical-path `cwd` match, cached per Session id, invalidated on `session/disposed`.
- **Listener not prepended**, observes final claimed batch, spreads decision to preserve `startsRequestSeries`.

Nudge sections (via `ctx.systemPrompt.section()`): lessons-go-to-skills guidance (only when `skill_manage` visible, and only on turns that are a multiple of `skillNudgeInterval`), memory-narrow-exception guidance (every `memoryNudgeInterval` turns), capacity header variables `{{evolutionMemoryUsage}}`, session-search hint. Variables resolved per assembly; unknown/malformed fails assembly loudly.

## How Memory is written

Two paths, both producing whole replacement text.

### Incremental, on every completed turn

`ctx.on('session/event', …)` filtered to `turn/end`. Resolve scope, return when none. One backward scan to most recent `turn/start` feeds output indexing (always) and extraction (when gated).

1. **Index produced files, always.** Every `tool/call` in `outputTools` with non-error `tool/result` contributes `{path, tool, sessionId, at}`. Path is `file_path` else `path`; unparseable or neither → ignored; `view`/`undo_edit` ignored. Resolved against Session `cwd`, kept only inside scope directory.
2. **Extract, when gated in.** Skipped when `review.enabled` false, cooldown unelapsed, or admitted text under `minTurnTextBytes`. Enqueued on per-scope promise chain; never blocks the turn.

Transcript admits only human `user/message` (`data.source.kind === 'user'`) and `assistant/message`. Injected context (brief itself, instructions, time, references) never fed back.

### Full rebuild, on demand

`rebuild(scopeId, signal)` for regenerate control. Takes scope sessions, drops archived, keeps newest `rebuildSessionLimit`, reads each session's current surface through `ctx.sessionQuery.readSurface` and admits rows through the same predicate the incremental path uses (human `user/message` and `assistant/message` only; injected context never feeds back), newest-first up to input budget. Empty `<current-memory>`, one call, then `setMemory`.

### The call

- Deterministic: `temperature: 0`, reasoning disabled via `purpose: 'evolution-review'`, `maxTokens: maxOutputTokens`, `deadline(signal, timeoutMs)`.
- **Route precedence**: configured `provider`+`model`, else Session last `request/header` route. Neither → skip with warning; rebuild with no route rejects `evolution/extraction-failed`.
- Input `JSON.stringify` `{role, text}` rows, byte-capped dropping oldest first. Same-model fork keeps byte-identical prompt/tools for cache reuse; different-model fork replays compact digest (recent verbatim + older summary).
- Failures as terminal `finish`, not throw: `error`/`aborted` throw, `max-tokens` tolerated `truncated:true`, tool-call blocks rejected. Only returned text enters the document under `## Purpose/Preferences/Decisions/References`. Forbids code-derivable content, credentials, health/race/religion/political/gender data; drops contradicted entries.
- Over-budget output truncated at UTF-8 boundary to `maxMemoryBytes` flagged `truncated:true` before store call.
- Failed extraction warns and keeps previous document; never surfaces as Session error. Teardown aborts in-flight; `session/disposed` aborts bound one. Usage persisted with `task='evolution_review'`.

## Reviewer tools whitelist and deferral

Background fork may use memory/skill-manage/read-only file and session-query tools only. `extraTools[]` must already exist on the parent; prefer stage-proposal tools over destructive ones. `defer: auto` (the default) queues a gated turn in an in-memory per-session slot, coalescing later turns onto the first snapshot's `deferMaxAgeMs` deadline; `never` extracts at turn end, and explicit `/refine` is always immediate. The fork's `extraTools[]` whitelist stays planned with the fork itself.

## Skills: manage, telemetry, learn, trust

`skill_manage` Consumer on `ctx.tools`: `create|patch|edit|write_file|remove_file|delete`. New skills go to `skills.createDir` (default profile skills dir); existing patched in place wherever found if writable. `createDir`/external dirs support `~` and `${VAR}`; missing dirs skipped. Local wins on name collision. Project-local `<git-root>/.hermes|dsh/skills` + `.agents/skills` highest precedence, gated by `trust/untrust` (`trustedProjectDirs`, `projectDiscovery:false` disables). Every project skill security-scanned before index; dangerous quarantined with explanatory load error; hash-cached outside repo. Non-interactive surfaces inherit trust, never prompt.

`/learn <anything>`: prompt-builder + normal turn, gathers via `read_file/search_files/web_extract`, saves via `skill_manage` (gated). Large sources become knowledge-base skills: lean `SKILL.md` + per-chapter `references/`, loaded on demand.

Frontmatter compatible with `agentskills.io`: `platforms`, `requires_tools/toolsets`, `fallback_for_*`, `required_env` (values pass through to the skill's execution environment; an unset name skips the skill with an explanatory error) and `config` (deployment values beat frontmatter defaults and substitute `${key}` in the body; a missing value skips the skill), `blueprint {schedule, deliver, prompt}` (install suggests cron via `/suggestions`, never silent schedule). Template vars `${DSH_SKILL_DIR}/${DSH_SESSION_ID}`, inline shell opt-in with timeout and 4000-char cap.

## Curator

Triggered by inactivity (`intervalHours:168`, `minIdleHours:2`). The curator owns one host-wide timer (`tickMinutes`), because a host plugin is mounted once per host and that single timer therefore covers the desktop app, the gateway, and `serve`; an awaited start-time due-check covers a short-lived CLI start, which is also why the host counts as idle before it observes any session activity. First run seeds `lastRunAt` and defers one interval. `run --dry-run` previews.

1. **Auto-transitions (always on, no LLM).** `active → stale (30d) → archived (90d)` into `.archive/`. Skips pinned and schedule-referenced (even paused/disabled; consolidation rewrites refs on merge). Never-used grace: not archived until `stale_after_days` old.
2. **LLM consolidation (opt-in `consolidate:false`).** A bounded in-package tool loop over `ctx.llm` surveys agent-created skills through a two-tool whitelist (view, apply) and keeps, patches, consolidates into umbrellas, or archives them; the curator performs every write, so the whitelist cannot bypass the rule below. The subagent seam is not usable here: an in-process provider inherits its route from a live parent Session's latest request, which a maintenance pass does not have. Full-package rule: with `references/templates/scripts/assets` must keep standalone, re-home + rewrite paths, or archive whole package — never flatten only `SKILL.md`.

Backups tar.gz per real pass (keep N), whole-run `rollback --list/--id/-y` (pre-rollback snapshot makes rollback reversible), append-only JSONL ledger `{actor, action, evidence, before/after sha blobs content-addressed}` + single-entry `rollback <entry-id>` fail-closed, `archiveTtlDays:0` never auto-purge + explicit `purge --dry-run`, manual `adopt` (no heuristic, no clock reset), `pin` blocks auto-transitions + `skill_manage delete` (patch still allowed), hub always exempt, protected built-ins filtered.

## Budgets and fallback (long-horizon safety)

`dsh-budgets` (guard group) enforces token/tool-call/wall ceilings from `ctx.tokenMeter` plus per-turn facts observed on `session/event`, by rejecting the next proposed step at `agent/pre-step`; the turn closes with the existing `blocked` reason, no message carrying `source.kind === 'user'` is ever discarded, and the durable `budget/exceeded` event ships as a required-on-read member (no format bump; the `llm/fallback` precedent), while the cost ceiling stays deferred (no pricing source exists). `dsh-llm-fallback` on `agent/request-error` after `llm-retry`: `fallbackRoutes[]` + breaker `{failureThreshold, coolMs}` + key rotation hook, durable `llm/fallback` event. `defineTool.parallelScopeKey` groups same-scope mutating calls serially within `maxParallelToolCalls`; `write`, `edit`, and `str_replace_editor` declare the path each call occupies. Declarative agents support stable `sessionId` + per-agent persona prefix/suffix. `toolOrder` validated at boot, not first turn.

## Remote API and UI (web owner approved)

Host `ctx.evolutionController` (Typert namespace `evolution`): `read/setInstructions/setLessons/setProfile/addContextItem/removeContextItem/rebuildMemory/follow`. Verbs resolve scope first (`workspace/not-found` reused). `follow` baseline + upsert per `domain/changed`. UI: journey timeline + pending approvals + curator status + capacity bars, locale-owned copy, CSS Modules tokens. CLI/commands own governance alongside it, shipped in `dsh-command-evolution`: `/memory pending/approve/reject`, `/skills pending/approve/diff`, `/journey [today|7d|30d|all]`, `/curator status`, `/curator run [--dry-run]`, `/refine`, `/trajectory [--out <path>] [--all]`, `/learn <anything>`, and `/suggestions` listing blueprint-backed skills without ever installing a schedule.

## Composition and configuration

Evolution rows go in `web-app` bundle first, not `base`. Storage/domain facility already in `base`, no storage row added.

| Row | Field | Default | Effect |
|---|---|---|---|
| `evolution-memory` | `capacityBytes` | **required** | Hard ceiling |
| | `maxAgentBytes` | 65536 | Lessons cap |
| | `maxUserBytes` | 32768 | Profile cap |
| | `maxContextItemBytes` | 262144 | Per-item cap |
| | `maxContextItems` | 50 | Count cap |
| | `maxOutputs` | 200 | Index size |
| `evolution-reviewer` | `enabled` | true | Auto fork |
| | `minTurnTextBytes` | 200 | Trivial skip |
| | `cooldownMs` | 60000 | Per-scope gap |
| | `maxInputBytes` | 131072 | Transcript budget |
| | `maxOutputTokens` | 1024 | Output cap |
| | `timeoutMs` | 60000 | Deadline |
| | `rebuildSessionLimit` | 20 | Rebuild scan |
| | `outputTools` | `write,edit,str_replace_editor` | Productions |
| | `provider/model` | unset | Both or neither |
| | `extraTools` | [] | Whitelist add |
| | `defer/deferMaxAgeMs` | `auto/1800000` | Local GPU queue |
| | `memoryNudgeInterval/skillNudgeInterval` | 1/10 turns | Frequency |
| | `maxResolutions` | 200 | Decided staged entries kept |
| | `squeezeOrder` | `References,Decisions,Preferences,Purpose` | Lean-squeeze pressure order |
| | `recallLimit/recallQueryChars` | 20/160 | Ranked recall breadth and query length |
| `evolution-memory-context` | `maxBytes` | **required** | Brief cap |
| `evolution-curator` | `enabled/intervalHours/minIdleHours/tickMinutes/staleAfterDays/archiveAfterDays/consolidate/pruneBuiltins/backup/archiveTtlDays` | `true/168/2/15/30/90/false/true/{true,5}/0` | Lifecycle and the host-wide check interval |
| | `provider/model/maxInputBytes/maxOutputTokens/maxSteps/timeoutMs` | unset/unset/65536/2048/4/60000 | Consolidation route, budget, and loop bound (both route fields or neither) |
| `evolution-controller` | `profile` | **required** | Namespace of the scope keys the Remote face serves |
| `evolution-trajectory` | `outDir` | `$DSH_HOME/evolution-trajectories` | Export destination |
| `evolution-scorer` | `corpusDir`, `attempts` | **required**, 3 | Recorded corpus and median-of-N attempts |
| `budgets` | `maxTotalTokens/maxToolCalls/maxWallMs` | unset (off) | Ceilings; `maxCostUsd` deferred until a pricing source exists, and the field is `maxTotalTokens` because `ctx.tokenMeter` measures total request pressure |
| `llm-fallback` | `fallbackRoutes/breaker` | [] | Resilience |

Disabling is removing rows: no records read, no brief, no extraction, sidebar falls back.

## Verification contract

| Claim | Proof |
|---|---|
| Brief reaches model and is logged once | REAL-composition: real store + registry + loop + mock adapter; adapter got framed text; log holds exactly one `user/message` with evolution source |
| Unchanged record does not re-inject | Second turn adds nothing; after `setInstructions` exactly one replacement with new digest |
| Budget/drop/escape | Pure render spec: exact byte cap, order context→lessons/profile→instructions, notice line, literal `</system-reminder>` escaped |
| Caps reject never mutate | Store spec: `too-large/capacity-exceeded/item-not-found`, record unchanged, by error code |
| Extraction writes with provenance | Extractor spec: scripted mock adapter, stored lessons/profile, `lastExtraction` origin/provider/truncated, `purpose:'evolution-review'`; sub-threshold no call; rebuild over two sessions frames both |
| Output indexing idempotent | Successful write records path/tool/session; failed records nothing; repeat collapses to newer `at`, digest unchanged |
| Background staged when gated | `writeApproval:true`: background write staged, `/memory pending/approve` applies, `/reject` drops; `notifications:off` still writes silently |
| Foreground not curated | Foreground `skill_manage create` never `createdBy:agent`; only background umbrella marked; `adopt` required; `pin` blocks archive/delete not patch |
| Curator safe | Dry-run no mutation; real pass snapshot + REPORT + ledger; whole-run and single-entry rollback restore; purge dry-run previews TTL |
| Budgets/fallback | Runaway turn cut at a reached ceiling (turn ends `blocked`, host warning names the ceiling and observed value); fallback switches route reconstructably; breaker cools down |
| Disposal removes all | HMR spec per registering package |
| Headless untouched | Recorded snapshots byte-identical unless web scenario; new web scenario covers page |
| Nothing uncovered/undocumented | Per-file 100% on new `src`, structural gates, regenerated catalogs, subsystem triplet, Agent Note same PR |

Remote built before typecheck; fixture transport one case per verb including `follow` baseline+idle-abort. UI acceptance on real surface: open scope, edit, compose in scope, produced file in outputs, preview/regenerate memory, add file via picker.

## Limits

- **Web only first.** Scopes exist only in web composition; headless/sdk/acp get nothing until adopted.
- **One brief at a time.** Change appends complete message; many edits accumulate superseded briefs (compaction shadows them).
- **File context re-read per refresh.** Budget bounds model bytes, not reads.
- **File capacity snapshot.** Recorded size not refreshed on disk change.
- **Outputs tool-derived.** Shell-written or unlisted-tool files not indexed.
- **Tile opens Session, not file.** No workspace-scoped file reader.
- **One document per scope.** No per-entry history (ledger has per-mutation blobs for audit/rollback).
- **Extraction needs a route.** No-request sessions produce no memory unless row names provider/model.
- **Reviewer/curator cost.** Background calls billed; `enabled:false` + cheaper aux model + `consolidate:false` bound it.

## Product choices open to override

- **Two-tier lessons/profile, not entry list.** One capped document per tier keeps cards editable; per-entry provenance would turn fields to arrays touching store/extractor/UI only.
- **Turn/end incremental, not session-end.** Keeps long sessions useful; `enabled:false` pays only for regenerate.
- **Machine-local `$DSH_HOME`, not project files.** No project write permission needed; committable per-project records would swap domain for files, extractor/injector/controller/UI unaffected.
- **Prune always on, consolidate opt-in.** Prune free and safe; consolidation 50-100 calls and structural — default off.
- **Adoption manual, never inferred.** Patch count proves maintenance not authorship; heuristic would archive hand-written skills.
- **Description display-only.** Injecting would add `## About` + digest churn for zero model value.

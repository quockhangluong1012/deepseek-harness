# Workspace Memory — Instructions / Memory / Context

**Status:** specification. Nothing below is implemented. This document owns the behaviour contract — what the feature stores, what the model sees, what the wire carries, what the user can do, and what proves it correct. The ordered edit list lives in the implementation plan; this file is the source text for `docs/subsystems/workspace-memory.md` (plus its `.zh.md` / `.i18n.yaml` pair and its `type-equiv` manifest rows) when the feature lands.

## Summary

A Workspace in DeepSeek Harness is the durable record of a directory the user works in: a stable id over a canonical `fs.realpath` path, a display title, and the ordered account of Sessions that ran there (`ctx.workspaceRegistry`, `packages/workspace/workspace`). It is navigation only — invisible to models, no prompt cost, no session events.

Workspace Memory gives each Workspace a durable body of knowledge that every Session in that Workspace inherits, and a Workspace page reachable by clicking the Workspace name in the sidebar.

| Part | Written by | Reaches the model | Counts against capacity |
|---|---|---|---|
| **Instructions** | the user | yes | yes |
| **Memory** | the model from this Workspace's own chat history; the user may edit or regenerate it | yes | yes |
| **Context** | the user, as attached workspace files or pasted text | yes | yes |
| **Description** | the user | no — page metadata | no |
| **Outputs** | derived from successful mutation-tool calls | no — a navigation index | no |

The split mirrors the two systems a coding agent normally keeps: author-written project instructions that live with the project, and a model-written memory document that lives beside the agent's own state. Both are machine-local under `$DSH_HOME`; neither writes inside the user's project directory.

## Glossary

- **Workspace record** — `Workspace { id, path, title, sessionIds, createdAt, updatedAt }` from `@deepseek-ai/dsh-workspace`. Unchanged by this feature; no `workspaceId` is added to `SessionHeader`, which is a released format.
- **Memory record** — the new durable per-Workspace document defined in [Data model](#data-model), keyed by `WorkspaceId` in its own storage domain.
- **Brief** — the single `<system-reminder>`-framed message assembled from Instructions + Memory + Context and injected into a Session.
- **Digest** — the sha1 identity of the brief's inputs. The injector compares it against the newest brief already visible in the Session to decide whether anything must be added.
- **Extraction** — one LLM call that rewrites the whole Memory document from a turn's transcript, or from the Workspace's chat history.

## Package inventory

Four new packages, plus a widened union and one new optional seam in an existing client package.

| Package | Group | Role |
|---|---|---|
| `@deepseek-ai/dsh-workspace-memory` | `workspace/` | Service Provider for `ctx.workspaceMemory`: the durable record, its caps, and its capacity accounting |
| `@deepseek-ai/dsh-workspace-memory-llm` | `workspace/` | `ctx.workspaceMemoryExtractor`: per-turn output indexing, per-turn memory extraction, on-demand rebuild |
| `@deepseek-ai/dsh-workspace-memory-context` | `context/` | Function plugin: renders the brief and splices it into `agent/pre-step` |
| `@deepseek-ai/dsh-client-ui-workspace-memory` | `client/` | Dual-face: host `ctx.workspaceMemoryController` (Remote namespace `workspaceMemory`) + the browser Workspace page |

Existing code this changes:

- `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-deepseek-llm-api-extensions` — `GenerateOptions.purpose` gains `'workspace-memory'` beside `'compaction'` and `'session-title'`; `@deepseek-ai/dsh-llm-deepseek` disables reasoning for it, as it already does for `'session-title'`. Memory extraction is a deterministic derivation; reasoning tokens buy nothing.
- `@deepseek-ai/dsh-client-ui-workspace` — declares the optional `ctx.workspacePage` opener and moves the Workspace row's click meaning (see [Opening the page](#opening-the-page)). The seam lives here, not in the new package, so the sidebar never depends on a specific page implementation and the type edge points one way.
- `@deepseek-ai/dsh-bundle-web-app`, `@deepseek-ai/dsh-api-remotes` — composition rows and the client Remote mount.

Every package follows the repository defaults: ESM, `@deepseek-ai/cordis` as peer + dev dependency, contributions registered through `ctx.effect()` / `ctx.on()`, README triplet, and a row in the owning group's package table.

## Data model

One durable record per Workspace in storage domain `workspace_memory`, version `1`, layout `per-record`, table `records`, keyed by `WorkspaceId`. With the shipped `storage-json` backend that is one document per Workspace at `$DSH_HOME/storages/workspace_memory/records/<workspaceId>.json`.

`per-record` because records are independent and per-record reads are the layout that can later accept `compatibleVersions`. Invalid records are **not** skipped-and-backed-up: Instructions are user-authored, not disposable derived data, so a corrupt record fails the domain open loudly. There is no `global` slot and no migration facility — a compatible reshape is an optional or defaulted zod field, never a `version` bump.

```ts
interface WorkspaceMemoryRecord {
  /** Page blurb under the Workspace title. Never reaches a model request. */
  description: string
  /** User-authored rules for every Session in this Workspace. */
  instructions: string
  /** Model-maintained knowledge document; markdown, user-editable. */
  memory: string
  /** ISO-8601 instant of the last memory write, or null when never written. */
  memoryUpdatedAt: string | null
  /** Attached context, newest last. */
  contextItems: readonly WorkspaceContextItem[]
  /** Produced-file index, newest first, capped by `maxOutputs`. */
  outputs: readonly WorkspaceOutput[]
  /** Provenance of the last model-written memory, or null. */
  lastExtraction: WorkspaceMemoryExtraction | null
  /** ISO-8601 instant of the last durable mutation. */
  updatedAt: string
}

type WorkspaceContextItem =
  | { kind: 'text'; id: string; label: string; text: string; sizeBytes: number; addedAt: string }
  | { kind: 'file'; id: string; label: string; path: string; sizeBytes: number; addedAt: string }

interface WorkspaceOutput { path: string; tool: string; sessionId: string; at: string }

interface WorkspaceMemoryExtraction {
  at: string; sessionId: string; provider: string; model: string
  inputBytes: number; truncated: boolean
}
```

Invariants:

- **Item ids are generated uuids**, never derived from a label or a path.
- **Text items store their content; file items store a path.** A file item's bytes are read at injection time, so editing the file on disk changes what the model sees without touching the record. Its `sizeBytes` is the size observed when it was added and is never refreshed.
- **Capacity** = UTF-8 byte length of `instructions` + `memory` + Σ `contextItems[].sizeBytes`, measured against the configured `capacityBytes`. `description` and `outputs` are excluded: the capacity bar measures what the model is charged for, and neither reaches a request.
- **The digest covers `instructions`, `memory`, and the context items only** — never `description`, `outputs`, or `updatedAt`. A produced file or a description edit must not invalidate the injected brief and force a re-injection.
- **A rejected write never mutates the record.** Every cap is checked before the write chain is entered.

## The store: `ctx.workspaceMemory`

`WorkspaceMemoryStore extends Service`, `static inject = ['storageDomain']`, domain opened in `[Service.init]` and closed through `ctx.effect`.

```ts
read(id: WorkspaceId): WorkspaceMemoryRecord | undefined
usage(id: WorkspaceId): WorkspaceMemoryUsage                    // { usedBytes, capacityBytes }
digest(id: WorkspaceId): string
setDescription(id: WorkspaceId, description: string): Promise<WorkspaceMemoryRecord>
setInstructions(id: WorkspaceId, instructions: string): Promise<WorkspaceMemoryRecord>
setMemory(id: WorkspaceId, memory: string, extraction?: WorkspaceMemoryExtraction): Promise<WorkspaceMemoryRecord>
addContextItem(id: WorkspaceId, input: WorkspaceContextItemInput): Promise<WorkspaceMemoryRecord>
removeContextItem(id: WorkspaceId, itemId: string): Promise<WorkspaceMemoryRecord>
recordOutputs(id: WorkspaceId, entries: readonly WorkspaceOutput[]): Promise<void>
```

Semantics:

- **Reads are synchronous** from the domain's validated memory, so the injector needs no projection and no cache of its own.
- **Absent record** — `read` returns `undefined`, `usage` returns `{ usedBytes: 0, capacityBytes }`, and `digest` returns the fixed string `'empty'`. The injector treats `'empty'` as "nothing to inject" and emits no message.
- **First write seeds the record.** A write on an absent key puts a fresh `{ description: '', instructions: '', memory: '', memoryUpdatedAt: null, contextItems: [], outputs: [], lastExtraction: null }` carrying the new value; a present key goes through `table.update`, so the read-modify-write lands in one write-chain slot. The branch is required, not defensive: `table.update` on an absent key throws `missing-key`.
- **Every accepted write stamps `updatedAt`** with a fresh ISO-8601 instant; `setMemory` also stamps `memoryUpdatedAt`.
- **Caps are byte caps**, measured with `Buffer.byteLength(value, 'utf8')` before any write, and reported as `workspace-memory/too-large` with the offending field, the observed bytes, and the ceiling.
- **`addContextItem`** rejects with `workspace-memory/capacity-exceeded` when it would exceed `maxContextItems`, or push `usedBytes` past `capacityBytes`. **`removeContextItem`** on an unknown id rejects with `workspace-memory/item-not-found`.
- **`recordOutputs`** prepends entries newest-first, collapses a repeat of a path already present onto the newer `at`, truncates to `maxOutputs`, and resolves **without writing** when the resulting list is unchanged, so an idempotent turn produces no `domain/changed` churn.
- **Stored objects never leak by reference**: `structuredClone` on read and on write.

The package publishes no `./invariant` companion: the domain table is the only copy of this state, so there is no second independent observation to check it against. Its README source map states that reason, which is what `verify-package-invariants` requires.

## What the model sees

The brief is one durable `user/message`, appended by the agent loop from an `agent/pre-step` contribution — the same mechanism `dsh-agent-instructions` uses for `AGENTS.md` files. It is therefore replayable, compactable, and reconstructable from the session log, which satisfies *model-visible ⟺ logged*. No new session event type is introduced.

```text
<system-reminder>
# Workspace memory: <workspace title>
Directory: <canonical path>

## Instructions
<instructions>

## Memory
<memory>

## Context: <label>
<materialized content>
</system-reminder>
```

Rules:

- **Empty sections are omitted.** When Instructions, Memory, and Context are all empty, no message is emitted at all — a Workspace with no memory costs zero tokens.
- **One brief per Session, replaced on change.** At each eligible pre-step the injector compares the record's digest against the newest visible `user/message` whose `source.kind === 'workspace-memory'`, scanning the claimed batch first and then the Session surface in reverse. Equal digest ⇒ nothing is added. Different or absent ⇒ exactly one complete fresh brief is appended.
- **Budget.** The complete emitted text including the frame never exceeds the configured `maxBytes`. Under pressure the injector drops trailing Context items first, then truncates Memory, then truncates Instructions last — Instructions are explicit user rules and outrank a derived document — and appends one notice line naming what was dropped or truncated. Truncation backs up over UTF-8 continuation bytes.
- **Frame safety.** Every workspace-authored string has a literal `</system-reminder>` rewritten to `<\/system-reminder>`, so user- or repository-controlled text cannot close the plugin-owned frame.
- **Unavailable file items degrade, never fail.** A missing or unreadable file item renders as one line, `Context "<label>" is unavailable (<path>).`, and the step proceeds. Reads go through `ctx.get('fs')` when a provider is mounted, else `node:fs/promises`.
- **A Session outside any Workspace gets nothing.** Membership resolves from the Workspace records' `sessionIds`, falling back to a canonical-path match on the Session's `cwd` for a Session created before attach completed. The resolution is cached per Session id and invalidated on `session/disposed`.
- **The listener is not prepended**, so it observes the final claimed batch, and it returns `{ ...decision, messages: [...] }` — spreading the decision is mandatory, since a bare `{ kind: 'enter', messages }` drops `startsRequestSeries`.

The message carries a typed source, declaration-merged into `MessageSourceMap`, so replay and deduplication are exact:

```ts
interface WorkspaceMemorySource {
  kind: 'workspace-memory'
  form: 'instructions'
  workspaceId: WorkspaceId
  digest: string
}
```

## How Memory is written

Two paths write the document, both producing the whole replacement text.

### Incremental, on every completed turn

`ctx.on('session/event', …)` filtered to `turn/end`. The extractor resolves the owning Workspace and returns when there is none; otherwise one backward scan of the live Session's events to the most recent `turn/start` feeds two independent steps. The live log is already in memory, so `readSession` / `readSurface` are never called here.

1. **Index produced files, always.** Every `tool/call` whose name is in the configured `outputTools` and whose matching `tool/result` is not an error contributes `{ path, tool, sessionId, at }`. The path is `file_path`, else `path` (the `str_replace_editor` spelling), parsed from the call's `arguments` JSON; a call whose arguments do not parse or carry neither key is ignored, as are the `str_replace_editor` commands `view` and `undo_edit`. Paths resolve against the Session `cwd` and are kept only when inside the Workspace directory.
2. **Extract memory, when gated in.** Skipped when `autoExtract` is false, when the Workspace's cooldown has not elapsed, or when the turn's admitted text is under `minTurnTextBytes`. Otherwise the work is enqueued on a per-`WorkspaceId` promise chain, so one Workspace never runs two extractions at once and a turn is never blocked by one.

The transcript admits only human `user/message`s (`data.source.kind === 'user'`) and `assistant/message`s. Every other source is injected context — the brief itself, agent instructions, time context, session references — and feeding it back would make memory amplify its own output.

There is no durable produced-file record in the repository to reuse, and `fs/observed` cannot serve as one: it fires for reads as well as writes.

### Full rebuild, on demand

`rebuild(workspaceId, signal)` backs the page's regenerate control. It takes the Workspace's `sessionIds`, drops archived ids, keeps the newest `rebuildSessionLimit`, and reads each Session's `user/message` and `assistant/message` text through `ctx.sessionQuery.filterEvents` — which returns already-extracted semantic text and does not replay whole logs — concatenating newest-Session-first up to the input budget. One call with an empty `<current-memory>`, then `setMemory`.

### The call

- Deterministic: `temperature: 0`, reasoning disabled through `purpose: 'workspace-memory'`, `maxTokens: maxOutputTokens`, wrapped in a `deadline(signal, timeoutMs, 'WORKSPACE_MEMORY_TIMEOUT')`.
- **Route precedence**: the configured `provider` + `model` pair, else the Session's last logged `request/header` route (`session.requestHeader()?.config`). There is no third fallback — the listener receives a `Session` and no `Agent`, so `agent.options` is unreachable. Neither available ⇒ skip with one warning and no call. A rebuild that resolves no route rejects with `workspace-memory/extraction-failed` so the card renders the reason instead of silently doing nothing.
- Input is `JSON.stringify`-framed `{ role, text }` rows, so conversation text cannot break the prompt delimiters, and is byte-capped to `maxInputBytes` by dropping oldest rows first.
- Failures arrive as a terminal `finish` chunk, not a throw, so the assembled result is inspected: `error` / `aborted` throw with the reported code, `max-tokens` is tolerated and sets `truncated: true`, tool-call blocks are rejected.
- The model returns **only** the replacement document, under the fixed headings `## Purpose`, `## Preferences`, `## Decisions`, `## References`. The instruction forbids recording anything derivable from the code or from the Workspace's Instructions, forbids credentials, tokens, keys, and health, race, religion, political, or gender-identity data, and requires dropping entries the new conversation contradicts.
- Over-budget output is truncated at a UTF-8 boundary to `maxMemoryBytes` and flagged `truncated: true` before the store is called, rather than being rejected by the store.
- A failed extraction logs a warning and leaves the previous document intact. It never surfaces as a Session error: a background derivation must not break a turn.

Provenance for every model-written document is durable in `lastExtraction`: when, from which Session, with which provider and model, over how many input bytes, and whether it was truncated.

Teardown aborts every in-flight extraction; `session/disposed` aborts the one bound to that Session.

## Remote API

Host service `ctx.workspaceMemoryController` (`TypertRemoteService`, namespace `workspaceMemory`). Every verb resolves the Workspace first and fails with the existing `workspace/not-found` code. Every unary verb returns the same projection:

```ts
interface WorkspaceMemoryValue {
  workspaceId: WorkspaceId
  description: string
  instructions: string
  memory: string
  memoryUpdatedAt: string | null
  contextItems: readonly WorkspaceContextItem[]
  outputs: readonly WorkspaceOutput[]
  lastExtraction: WorkspaceMemoryExtraction | null
  usage: { usedBytes: number; capacityBytes: number }
  updatedAt: string
}
```

| Verb | Purpose |
|---|---|
| `read` | Load one Workspace's record |
| `setDescription` | Replace the page blurb |
| `setInstructions` | Replace the instruction text |
| `setMemory` | Replace the memory document by hand |
| `addContextItem` | Attach pasted text (`kind: 'text'`) or a workspace file (`kind: 'file'`) |
| `removeContextItem` | Detach one item |
| `listContextFiles` | Candidate paths under the Workspace root for the add-file picker |
| `rebuildMemory` | Rebuild the document from the Workspace's chat history |
| `follow` (stream) | One complete baseline, then an upsert per durable record change |

- **`addContextItem`** with `kind: 'file'` realpath-resolves the path (absolute, or relative to the Workspace path), stats it, and rejects with `workspace-memory/context-unreadable` when it is missing, not a regular file, or resolves outside the Workspace. The observed size becomes `sizeBytes`.
- **`listContextFiles`** walks the Workspace directory depth-limited to 3, skipping `node_modules`, `.git`, and any dot-directory, keeps `.md` / `.markdown` / `.txt` / `.json`, filters case-insensitively by the query, sorts, and caps at 200 workspace-relative paths. `ctx.workspaceFiles` cannot serve this: each of its verbs resolves its root from an Agent's sandbox policy, and a root-scoped page holds only a `workspaceId`.
- **`follow`** emits `{ type: 'baseline', values }` — every registered Workspace's record, absent records rendered as the empty projection — then `{ type: 'upsert', value }` per `domain/changed` filtered to this domain and table. A reconnect starts a new generation with a fresh baseline, so no durable cursor exists. This is what keeps the page live while a background extraction or an output-index write lands.

### Error codes

Declared in the producing package's `RemoteErrorDetailsMap` merge.

| Code | Meaning | Details |
|---|---|---|
| `workspace/not-found` | No Workspace with that id (existing code, reused, never redeclared) | `{ workspaceId }` |
| `workspace-memory/too-large` | A field exceeds its configured byte cap | `{ field, bytes, maxBytes }` |
| `workspace-memory/capacity-exceeded` | The write would exceed the item count or push used bytes past capacity | `{ usedBytes, capacityBytes }` |
| `workspace-memory/item-not-found` | No context item with that id | `{ itemId }` |
| `workspace-memory/context-unreadable` | The path is missing, not a regular file, or outside the Workspace | `{ path }` |
| `workspace-memory/extraction-failed` | The rebuild could not produce a document | `{ workspaceId }` |

## User interface

### Opening the page

Clicking a Workspace **name** in the sidebar opens its page. Expand/collapse moves to a dedicated disclosure button in the row's leading slot, which keeps the folder↔chevron glyph swap; the row keeps its `treeitem` role and its `aria-expanded` attribute, which existing browser tests locate it by.

`ui-workspace` declares the opener as an optional seam and calls it through `ctx.get('workspacePage')`:

```ts
/** Optional opener for a Workspace's own page; absent compositions fall back to expand/collapse. */
export interface WorkspacePageOpener {
  open(workspaceId: WorkspaceId): void
}
```

A composition without the page plugin, and the Ungrouped bucket that has no backing Workspace, keep today's behaviour exactly: the name toggles the group.

### The page

The page routes `shell.page` — the center-track slot `ui-layout` declares for one page at a time. The entry exists only while a Workspace is open, so an empty slot routes the centre back to the conversation; the page is an ordinary scrolling surface in the center column, dismissed with its back control.

On open it calls `read` and subscribes to `follow` through the injected Remote stream service — a generation-aware baseline/upsert consumer over `remote.openStream`, never a hand-rolled reconnect loop (reconnect stays inside `RemoteStream`).

- **Identity block** — the page's first content row, spanning the full content width above both the composer band and the right column: the back control, then the Workspace title and canonical directory path from the root workspaces hook, then the description as one editable paragraph. An empty description renders a placeholder line that opens the same editor. Blur or Save calls `setDescription`; Escape cancels.
- **Composer band** — the page holds a transparent band open between the identity block and the scrolling body, sized to the resident composer seat's live height (`--dsh-composer-height`) and anchored by the band's own box (`--dsh-page-composer-top`, `-left`, `-right`), all read off the document root the two subtrees share. The conversation's resident composer — the same control the home page shows, with its model, permission, and mode seats live, and the agent-preset chip above it — docks into the band, inset to the main column the outputs and the chats fill, so a page reads name/description → composer → body and the composer is no wider than the content under it. The page carries no input of its own, so there is exactly one editor.
- **Outputs** — a horizontally scrolling row of tiles, one per indexed produced file, showing basename, workspace-relative directory, and producing tool, with the full path as the tooltip. Previous/next controls scroll one container width at a time and disable at each end. Selecting a tile opens the Session that produced the file. An empty index renders an empty-state line instead of the track.
- **Chats / Activity** — a tab pair over one panel. **Chats** lists this Workspace's Sessions with title and last-updated time. **Activity** flattens those Sessions' `turnOutline` projection values into one list ordered by session recency then turn, capped at 50 rows, each showing the session title, the turn number, and the prompt preview. Both read data the Session list already carries, including for cold Sessions seeded from the projection cache, so neither tab issues an extra request. Selecting a row opens its Session and closes the page.
- **Right column** — three cards in a `workspace.memory.card` list slot the page declares itself:
  - **Instructions** — clipped preview; a pencil opens a modal textarea; save calls `setInstructions`. A `workspace-memory/too-large` failure renders as card copy, never a throw.
  - **Memory** — clipped preview, `memoryUpdatedAt` as relative time, and the writing model as the provenance line. **Preview** opens the whole document read-only as rendered markdown; **Edit** opens the same modal over a textarea and saves with `setMemory`; **Regenerate** calls `rebuildMemory` and holds a busy state for the round trip.
  - **Context** — a capacity bar (`usedBytes` of `capacityBytes`), one chip per item with label, size, and a remove control, and an add menu offering pasted text or a workspace file chosen from a debounced, abortable `listContextFiles` query.

All copy is locale-owned through typed dictionaries — Simplified Chinese is the key-set source of truth, English satisfies the same key union — because `verify-client-ui-i18n` rejects hardcoded copy anywhere under `packages/client/ui-*/src`, including `aria-label`, `title`, and `placeholder`. Styling is CSS Modules with `--dsw-*` tokens. Textarea, tabs, and carousel are local components: no primitive exists for them.

## Composition and configuration

All three host rows go in the `web-app` bundle, not `base`: `ctx.workspaceRegistry` exists nowhere else, so a `base` row would stay permanently pending in the `headless`, `sdk`, and `acp` profiles. Storage and the domain facility already ship in `base`, so no storage row is added. The browser plugin joins the `web-app` browser roster, and its generated Remote client mounts in `packages/api/remotes`.

| Row | Field | Default | Effect |
|---|---|---|---|
| `workspace-memory` | `capacityBytes` | **required** | Capacity-bar denominator and the hard ceiling on stored bytes |
| | `maxDescriptionBytes` | 4096 | Description cap |
| | `maxInstructionsBytes` | 65536 | Instructions cap |
| | `maxMemoryBytes` | 65536 | Memory document cap |
| | `maxContextItemBytes` | 262144 | Per-item cap, and the ceiling on a file item's observed size |
| | `maxContextItems` | 50 | Item count cap |
| | `maxOutputs` | 200 | Produced-file index size |
| `workspace-memory-llm` | `autoExtract` | true | Whether a completed turn triggers extraction; output indexing always runs |
| | `minTurnTextBytes` | 200 | Skip extraction for trivial turns |
| | `cooldownMs` | 60000 | Minimum gap between two extractions for one Workspace |
| | `maxInputBytes` | 131072 | Transcript budget per call |
| | `maxOutputTokens` | 1024 | Output cap |
| | `timeoutMs` | 60000 | Call deadline |
| | `rebuildSessionLimit` | 20 | Sessions scanned by a rebuild |
| | `outputTools` | `write`, `edit`, `str_replace_editor` | Which successful calls count as productions |
| | `provider` / `model` | unset | Route override; both or neither, one alone fails plugin load |
| `workspace-memory-context` | `maxBytes` | **required** | Cap on the complete injected brief |

`capacityBytes` and `maxBytes` are required rather than defaulted, matching `agent-instructions`: the deployment must choose what a Workspace may cost per request. Every other field is a validated `Config` member changeable from `cordis.yml`; none is a hardcoded tunable.

Disabling the feature is removing its rows: no rows, no records read, no brief, no extraction, and the sidebar name falls back to toggling.

## Verification contract

What proves this feature correct, by claim:

| Claim | Proof |
|---|---|
| The brief reaches the model and is logged once | Composed integration spec: real store + registry + agent loop + mock adapter; assert the adapter received the framed text carrying Instructions, Memory, and a context item, and the log holds exactly one `user/message` with source `workspace-memory` |
| An unchanged record does not re-inject | Second turn in the same spec adds no second such message; after `setInstructions`, the next turn adds exactly one replacement carrying the new digest |
| Budget, drop order, and frame escaping | Pure render spec: exact byte cap on the complete framed output, context → memory → instructions drop order, the emitted notice line, and a literal `</system-reminder>` inside Instructions escaped |
| Caps reject and never mutate | Store spec: `too-large`, `capacity-exceeded` at both ceilings, `item-not-found`, and the record unchanged after each rejection, asserted by error code, not by class |
| Extraction writes the document with provenance | Extractor spec: scripted mock adapter, assert the stored memory, `lastExtraction` provider/model/`truncated: false`, and that the request carried `purpose: 'workspace-memory'`; a sub-threshold turn performs no call; a rebuild over two persisted Sessions frames text from both |
| Output indexing is correct and idempotent | Same harness: a successful `write` call records the resolved path with its tool and Session; a failed result records nothing; a repeat leaves one entry with the newer `at` and leaves the digest unchanged, proving an output never re-injects the brief |
| Disposal removes every contribution | One HMR spec per registering package: pre-step listener gone, slot entry gone, Remote namespace unmounted |
| The page behaves | jsdom spec with a test Remote: renders nothing closed, renders the composer entry and three cards open, regenerate calls `rebuildMemory` and shows busy, a `too-large` failure renders card copy |
| The sidebar gesture changed deliberately | The name fires the opener and not the toggle; the disclosure button fires the toggle and not the opener; the existing expand/collapse suites and browser tests retarget at the disclosure button, and the four affected accessibility snapshots are re-recorded |
| Headless output is untouched | Recorded-session snapshots stay byte-identical — a diff there means a row landed in `base` by mistake — and a new web scenario covers the page |
| Nothing ships uncovered or undocumented | Per-file 100% coverage on every new `src` file, the structural gates (`cordis-config`, `package-dependencies`, `client-packages`, `client-ui-i18n`, `package-invariants`, `no-hardcoded-tunables`), the regenerated catalogs, the subsystem page triplet, and an Agent Note in the same change |

The Remote artifacts must be built before typecheck: the generator emits the host and remote-client files and hard-fails on a wrong `./typert` / `./remote` export or `files` list. The browser fixture transport needs one case per verb, including a `follow` case emitting a baseline and idling until abort, or every fixture-driven client spec rejects as soon as the page opens.

Acceptance for the UI half is the real surface: build, launch the web app, click a Workspace name, edit the description, open the composer entry and confirm the conversation route shows a blank Session in that Workspace, send a prompt there, confirm a produced file appears in Outputs and that the track scrolls, switch tabs, open the Memory preview, regenerate, and add a markdown file through the Context picker.

## Limits

- **Web only.** Workspaces exist only in the web composition, so headless, sdk, and acp Sessions never carry a brief.
- **One brief per Session at a time.** A change appends a complete new message rather than a diff, so a Workspace edited many times inside one Session accumulates superseded briefs in the log.
- **File context is read per request.** A large attached file is re-read on every brief refresh; the budget bounds what reaches the model, not what is read.
- **Capacity for file items is a snapshot.** Their recorded size is not refreshed when the file changes on disk, so accounting is exact for text items and an estimate for files.
- **Outputs are tool-derived.** A file written by a shell command, or by a tool outside the configured set, is not indexed.
- **An Outputs tile opens its Session, not the file.** A workspace-scoped surface has no file reader; the readers in this product are Session-scoped.
- **Memory is one document.** There is no per-entry provenance, per-entry deletion, or memory history.
- **Extraction needs a route.** A Session that never issued a model request has no route to reuse, so its turns produce no memory unless the plugin row names a provider and model.

## Product choices open to override

Everything else is decided. These are the user-facing tradeoffs, each with the change it would cost.

- **Memory is one markdown document, not a typed entry list.** A single capped document needs no second storage tier and makes the card directly editable. Per-entry provenance or deletion would turn the field into an array and touch only `setMemory`, the extractor's merge, and the Memory card.
- **Extraction runs on `turn/end` with a cooldown, not at Session end.** Incremental extraction keeps Memory useful inside a long Session. Set `autoExtract: false` to pay only for the page's regenerate control, which runs the same code path.
- **Storage is machine-local under `$DSH_HOME`, not files inside the Workspace directory.** No write permission is needed in the user's project. Committable per-project records would keep the store's API and swap the domain for files under the Workspace path; extractor, injector, controller, and UI are unaffected.
- **The page is a `shell.page` route, not an overlay.** It renders instead of the conversation while open and carries no input of its own; the composer entry navigates to the conversation route. A URL-addressable route with history and deep linking would be a separate capability.
- **Context items are inline text and single files.** A folder item would become a third `kind: 'directory'` in the union plus a listing pass in the injector's materialization step.
- **The Workspace name opens the page; a new disclosure button expands the group.** This is the requested gesture and it costs the enumerated test and snapshot churn. The lower-blast-radius alternative is leaving the row click as toggle and adding an "Open workspace" entry to the row's context menu — one unit test changes instead of sixteen unit gestures, eight browser gestures, and four accessibility snapshots.
- **Description is display-only, never injected.** Instructions is the channel that reaches the model, so a description edit costs no tokens and does not change the digest. Injecting it would add a leading `## About` section and pull it into the digest.
- **Activity is the Sessions' turn outlines, not a separate event feed.** Those values already ship with the Session list for live and cold Sessions. A richer stream — tool runs, file writes, schedule fires — would need a new durable per-workspace feed.

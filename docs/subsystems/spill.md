# Spill Storage

English | [中文](spill.zh.md)

The spill storage [capability seam](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) persists caller-provided text and returns a model-facing locator with retrieval guidance. Its Service Definition is [dsh-spill](../../packages/spill/spill) (`ctx.spillStore`), which also defines the read-only artifact retrieval seam (`ctx.artifacts`) over the same stored artifacts, and its local Service Provider is [dsh-spill-local](../../packages/spill/spill-local), which registers both. Consumers include the [tool-result policy](../../packages/spill/spill-policy) and [session references](../../packages/context/session-reference/README.md). Spill is optional, not part of the [agent-loop spine](core.md); consumers own preview and spill decisions, while storage saves the supplied text verbatim.

Source: [`packages/spill/spill/src/types.ts`](../../packages/spill/spill/src/types.ts)

## The save request

`saveText` is the sole service operation: persist `content` verbatim, return an opaque locator, a backend-supplied retrieval hint, and the exact byte count. The request carries the save-time storage namespace (`owner`), descriptive producer details (`source`, never access control), and a `suggestedName` the backend may use as a naming hint, not a path. A tool source identifies the actual tool call; a session-reference source identifies the captured source session, while its owner is the target session receiving the context.

```ts type-equiv
/** One request to persist text to a spill artifact. */
interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}
```

```ts type-equiv
/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
interface SpillOwner {
  sessionId: SessionId
}
```

A retention-period cleanup may expire old locators with other old session artifacts; the spill seam does not define a per-session cleanup policy.

```ts type-equiv
/**
 * Producer of a spilled artifact. Tool results carry their model-issued call id;
 * session references identify the captured source session instead. Descriptive
 * source description only, never access control.
 */
type SpillSource = {
  kind: 'tool'
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: ToolCallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
} | {
  kind: 'session-reference'
  /** Session whose projected conversation was captured. */
  sessionId: SessionId
  /** Host-provided label for the referenced session. */
  label: string
}
```

## The result

```ts type-equiv
/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
```

`SpillLocator` is a [branded](core.md#branded-ids) model-facing handle returned by the backend. The local backend renders it as a filesystem path; a remote or database backend can render a URI, key, or command token. Consumers treat it as opaque and render it with `retrievalHint` instead of assuming `read` is always the right retrieval mechanism.

```ts type-equiv
/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render it with {@link SpillRef.retrievalHint}, but do not parse it.
 */
type SpillLocator = Branded<'SpillLocator'>
```

## The service

`SpillStore` (`ctx.spillStore`, defined in [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)) is a one-method abstract service: `saveText(input) → Promise<SpillRef>`. It persists the FULL `content` and REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable). The storage seam owns storage only: no retention policy, no tool-result replacement, and no retrieval API; retrieval is the separate read-only `ArtifactStore` seam below.

The local backend ([dsh-spill-local](../../packages/spill/spill-local)) writes under `<root>/session-<hash>/<random>-<safeName>` — a configured or lazily-created private (0700) root, a `sha256(sessionId)` session subdir, and an exclusive owner-only (`open(path, 'wx', 0o600)`) write so a planted symlink cannot redirect it. Its `locator` is the local path and its `retrievalHint` tells the model to use `read` or `grep` on that path. The policy consumer ([dsh-spill-policy](../../packages/spill/spill-policy)) replaces an over-`maxInlineTokens` text/image result with ordered head/tail content and a spill address, best-effort: a save failure keeps the original inline result rather than turning a successful call into an `isError`.

## Artifact retrieval

`ArtifactStore` (`ctx.artifacts`, defined in [`packages/spill/spill/src/artifacts.ts`](../../packages/spill/spill/src/artifacts.ts)) is the read-only retrieval seam over the artifacts a `SpillStore` backend stored, exposing the artifact APIs named by the evolution specification. Its five operations are `search` — list one session's artifacts newest first, optionally matching a stored-name substring — `read` — return the stored text or one line window — `extract` — project the lines matching a regular expression — `diff` — compare two artifacts into a unified patch — and `summarize` — retain an artifact's head and tail under a byte budget and report the exact omitted byte count.

Locators stay the opaque handles `saveText` returned. Every operation but `search` takes them, and a locator this backend did not store — a foreign path, an unknown name, an entry that is not a regular file — rejects with `ArtifactLocatorError` instead of reading an arbitrary file. Retrieval never writes, replaces, exports, or deletes an artifact and never changes a model request, so it cannot bypass the [tool-result policy](../../packages/spill/spill-policy): retention still decides what a model sees of an oversized result, and a retrieval recovers the complete text its notice points at. `summarize` composes the byte-oriented retention library the policy uses, so a caller can render the shipped notice from its `omittedBytes`.

[dsh-spill-local](../../packages/spill/spill-local) registers both services from one plugin fiber over one root: the local provider reads exactly the files its `saveText` wrote, and one disposal releases both.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifacts--artifactstore-abstract-seam"></a>

### `ctx.artifacts` — `ArtifactStore` (abstract seam)

Abstract artifact retrieval service over the artifacts of one `SpillStore` backend. Subclass, implement every operation, and load the subclass as a plugin — it registers as `ctx.artifacts` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- Retrieval is READ-ONLY. No operation writes, replaces, exports, or deletes an artifact, and none changes what a model request contains; the writing seam is `SpillStore`, and model-facing preview policy stays in `@deepseek-ai/dsh-spill-policy`.
- read, extract, diff, and summarize accept only locators this backend stored. Another backend's locator, an unknown name, or a non-artifact entry REJECTS with ArtifactLocatorError rather than reading an arbitrary file.
- Search is scoped to the request's SearchArtifacts.owner session, like storage, and never reaches another session's artifacts.
- summarize retains the artifact's head and tail under the request's byte budget with the same byte-oriented retention the spill policy composes, so its exact `omittedBytes` is what the shipped notice formatter consumes.

```ts cordis-catalog
/**
 * List artifacts of the owner session, newest first, filtered by the request's
 * criteria. A session with no stored artifact returns an empty list.
 * @param request - the owner session scope, optional stored-name substring, and match limit.
 * @returns the matching artifacts, newest first; empty when none match.
 */
abstract search(request: SearchArtifacts): Promise<ArtifactMatch[]>

/**
 * Read one line window of a stored artifact, defaulting to all of it.
 * @param request - the artifact locator and the optional 1-based line window.
 * @returns the window text and both the window's and the artifact's sizes.
 */
abstract read(request: ReadArtifact): Promise<ArtifactText>

/**
 * Project the artifact lines matching a regular expression, in artifact order.
 * @param request - the artifact locator, the pattern source, and the optional match limit.
 * @returns the matching lines with their line numbers and the complete match count.
 */
abstract extract(request: ExtractArtifact): Promise<ArtifactExtract>

/**
 * Compare two stored artifacts line by line.
 * @param request - the two artifact locators and the optional unchanged-line context.
 * @returns the unified patch and the added/deleted line counts.
 */
abstract diff(request: DiffArtifacts): Promise<ArtifactDiff>

/**
 * Retain an artifact's head and tail under a byte budget.
 * @param request - the artifact locator and the maximum returned UTF-8 bytes.
 * @returns the retained ends and the exact omitted byte count.
 */
abstract summarize(request: SummarizeArtifact): Promise<ArtifactSummary>
```

Source: [`packages/spill/spill/src/artifacts.ts`](../../packages/spill/spill/src/artifacts.ts)

<a id="ctxspillstore--spillstore-abstract-seam"></a>

### `ctx.spillStore` — `SpillStore` (abstract seam)

Abstract spill storage service. Subclass, implement saveText, and load the subclass as a plugin — it registers as `ctx.spillStore` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- saveText persists the FULL `content` verbatim and returns an opaque locator, exact byte length, and model-facing retrieval guidance.
- Storage is scoped by the request's SaveTextSpill.owner session; the backend chooses a private (not world-readable) location and a collision-free name derived from — never equal to — the caller's `suggestedName`.
- `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable); the caller decides how to degrade (the spill policy treats a rejection as best-effort and keeps the inline result).

```ts cordis-catalog
/**
 * Persist `input.content` to a session-scoped spill artifact.
 * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
 * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
 */
abstract saveText(input: SaveTextSpill): Promise<SpillRef>
```

Source: [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)
<!-- END GENERATED cordis-surface -->

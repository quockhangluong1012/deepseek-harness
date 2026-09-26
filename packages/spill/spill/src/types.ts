/**
 * Vocabulary for the spill storage and artifact retrieval Service Definitions.
 * Types only — the abstract services live in `./index.ts` and `./artifacts.ts`,
 * implementations in sibling packages (`@deepseek-ai/dsh-spill-local` first).
 *
 * @module @deepseek-ai/dsh-spill/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render it with {@link SpillRef.retrievalHint}, but do not parse it.
 */
export type SpillLocator = Branded<'SpillLocator'>

/**
 * Brand a string as a {@link SpillLocator}.
 *
 * @param locator The backend-produced locator string to brand.
 * @returns The branded spill locator.
 */
export function SpillLocator(locator: string): SpillLocator {
  return locator as SpillLocator
}

/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
export interface SpillOwner {
  sessionId: SessionId
}

/**
 * Producer of a spilled artifact. Tool results carry their model-issued call id;
 * session references identify the captured source session instead. Descriptive
 * source description only, never access control.
 */
export type SpillSource = {
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

/** One request to persist text to a spill artifact. */
export interface SaveTextSpill {
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

/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
export interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}

/** Criteria selecting stored artifacts of one owning session. */
export interface SearchArtifacts {
  owner: SpillOwner
  /**
   * Case-sensitive substring of the artifact's stored name — the backend's
   * collision-resistant prefix plus the sanitized `suggestedName`, so a caller
   * matches the name it suggested. Omitted selects every artifact of the session.
   */
  name?: string
  /** Maximum matches, newest first; omitted returns every match. */
  limit?: number
}

/** One artifact a search selected, with the facts a caller needs before reading it. */
export interface ArtifactMatch {
  locator: SpillLocator
  /** The artifact's stored leaf name, not a path. */
  name: string
  /** UTF-8 byte length of the stored text. */
  bytes: number
  /** Last-modification time as an ISO 8601 timestamp. */
  savedAt: string
}

/** Read one line window of a stored artifact. */
export interface ReadArtifact {
  locator: SpillLocator
  /** 1-based first line of the window; omitted starts at line 1. */
  offset?: number
  /** Maximum lines in the window; omitted returns every remaining line. */
  limit?: number
}

/** The requested window plus the artifact's own size, so a caller sees what it did not read. */
export interface ArtifactText {
  /** The window's lines joined with `\n`; a line never includes its terminator. */
  text: string
  /** UTF-8 byte length of `text`. */
  bytes: number
  /** Line count of `text`. */
  lines: number
  /** UTF-8 byte length of the whole artifact. */
  totalBytes: number
  /** Line count of the whole artifact. */
  totalLines: number
  /** Whether the window omits artifact lines. */
  truncated: boolean
}

/**
 * Project the artifact lines that match a regular expression. Lines are
 * `\n`-separated segments and a trailing newline adds no empty final line.
 */
export interface ExtractArtifact {
  locator: SpillLocator
  /** JavaScript regular expression source, tested against each line with `RegExp.prototype.test`. */
  pattern: string
  /** Maximum matching lines in artifact order; omitted returns every match. */
  limit?: number
}

/** One artifact line and its 1-based line number. */
export interface ArtifactLine {
  line: number
  text: string
}

/** The projected matching lines plus the artifact's complete match count. */
export interface ArtifactExtract {
  matches: ArtifactLine[]
  /** Matching lines in the artifact, including any beyond `limit`. */
  totalMatches: number
  /** Whether `matches` omits matching lines. */
  truncated: boolean
}

/** Compare two stored artifacts line by line. */
export interface DiffArtifacts {
  /** Artifact read as the "before" side. */
  left: SpillLocator
  /** Artifact read as the "after" side. */
  right: SpillLocator
  /** Unchanged lines shown on each side of a change; omitted uses 3. */
  context?: number
}

/** The line comparison of two artifacts. Identical artifacts produce an empty patch and zero counts. */
export interface ArtifactDiff {
  /** Unified diff of `left` → `right`, one `@@` header plus body per changed region. */
  patch: string
  /** Lines only the `right` artifact holds. */
  added: number
  /** Lines only the `left` artifact holds. */
  deleted: number
}

/** Bound one stored artifact to a byte budget by retaining its head and tail. */
export interface SummarizeArtifact {
  locator: SpillLocator
  /** Maximum UTF-8 bytes of `text`; an artifact that already fits is returned whole. */
  maxBytes: number
}

/** The retained ends of an artifact, with the byte accounting a retrieval notice consumes. */
export interface ArtifactSummary {
  /** The artifact's head and tail, at most `maxBytes` bytes, cut on UTF-8 boundaries. */
  text: string
  /** UTF-8 byte length of `text`. */
  bytes: number
  /** UTF-8 byte length of the whole artifact. */
  totalBytes: number
  /** UTF-8 bytes between the retained ends, absent from `text`. */
  omittedBytes: number
  /** Whether the artifact was larger than `maxBytes`. */
  truncated: boolean
}

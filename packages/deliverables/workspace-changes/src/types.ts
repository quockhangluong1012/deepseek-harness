/** Per-turn workspace change summaries, the Session event announcing them, and the Host service serving them with their comparisons. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One file changed during a turn, with line counts from git or from the whole-file captures around its file-tool edits. */
export interface WorkspaceChangedFile {
  /** Path relative to the Session working directory, or an absolute Host path outside it. */
  path: string
  /**
   * Sort key and label: the relative path inside the working directory, a
   * `../` path for repository files above it, a `~` path under the home
   * directory, otherwise the absolute path. Always slash-separated.
   */
  display: string
  /** Lines added; zero for a binary or oversized file. */
  added: number
  /** Lines deleted; zero for a binary or oversized file. */
  deleted: number
  /** Present when git reported the file as binary, or when a captured side holds a NUL byte. */
  binary?: true
  /** Present when a captured side exceeded the plugin's `maxFileBytes`; the file is listed without counts or comparison. */
  oversized?: true
}

/** Files changed during one top-level turn, kept on the Host until its Session is disposed. */
export interface WorkspaceChangesSummary {
  /** The turn whose file changes this summary describes. */
  turn: number
  /** The Session working directory `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Lines added over every changed file, including files omitted by the cap. */
  added: number
  /** Lines deleted over every changed file, including files omitted by the cap. */
  deleted: number
  /** Git tree ids of the turn-start and turn-end snapshots; absent when no snapshot was taken. */
  snapshot?: { before: string; after: string }
}

/** One unified-diff hunk with three context lines; every line keeps its `+`, `-`, or space prefix. */
export interface WorkspaceDiffHunk {
  /** First line of the hunk in the turn-start content, 1-based; a side without lines starts at 1 with zero lines. */
  oldStart: number
  /** Lines of the hunk taken from the turn-start content. */
  oldLines: number
  /** First line of the hunk in the turn-end content, 1-based; a side without lines starts at 1 with zero lines. */
  newStart: number
  /** Lines of the hunk taken from the turn-end content. */
  newLines: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  lines: string[]
}

/** The comparison of one listed file's turn-start and turn-end contents, computed when asked for. */
export type WorkspaceFileDiff =
  | {
    kind: 'text'
    /** The listed file's `path`. */
    path: string
    /** The listed file's `display`. */
    display: string
    /** Whether the file existed at turn start. */
    before: boolean
    /** Whether the file existed at turn end. */
    after: boolean
    /** Hunks in file order; empty when both sides hold the same lines. */
    hunks: WorkspaceDiffHunk[]
    /** True when the line comparison exceeded the plugin's `diffTimeoutMs` and every line is shown as replaced. */
    coarse: boolean
  }
  /** A side git reported as binary or that holds a NUL byte; no lines are served. */
  | { kind: 'binary'; path: string; display: string }
  /** A side larger than the plugin's `maxFileBytes`; no lines are served. */
  | { kind: 'oversized'; path: string; display: string }


/** One hunk's decision: `accept` writes the hunk's turn-end lines, `reject` keeps its turn-start lines. */
export type WorkspaceHunkDecision = 'accept' | 'reject'

/** The outcome of applying one listed file's hunk decisions, written as one atomic replacement. */
export interface WorkspaceHunkApplyResult {
  /** The listed file's `path`. */
  path: string
  /** The listed file's `display`. */
  display: string
  /** Hunk indices whose turn-end lines were written, ascending. */
  accepted: number[]
  /** Hunk indices whose turn-start lines were kept, ascending. */
  rejected: number[]
  /**
   * Whether the file exists after the write: false when the turn created it and no hunk was accepted,
   * or when the turn deleted it and every hunk was accepted.
   */
  exists: boolean
}

/** One file a rewind could not write back, and why. */
export interface WorkspaceRestoreSkip {
  /** The listed file's `path`. */
  path: string
  /** The listed file's `display`. */
  display: string
  /** Binary content, a side larger than `maxFileBytes`, or a read/write failure. */
  reason: 'binary' | 'oversized' | 'error'
}

/** The outcome of rewinding a working directory to one turn's start. */
export interface WorkspaceRestoreResult {
  /** Display paths successfully written back or removed, in file order. */
  restored: string[]
  /** Files left untouched, with the reason each was skipped. */
  skipped: WorkspaceRestoreSkip[]
}

/** Serves the summaries and file comparisons the recorder keeps for live Sessions. */
export interface WorkspaceChanges {
  /**
   * The summary announced by one `workspace/changes` event.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined once its Session was disposed or when this Host never recorded it.
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
  /**
   * Compare one listed file's contents at turn start and turn end.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined once its Session was disposed, when this Host never recorded it, or when no file has that index.
   * @throws when a snapshot read fails for a live Session.
   */
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
  /**
   * Apply one decision per hunk to one listed file, replacing it in one step: the file ends as its
   * turn-start content with every accepted hunk's turn-end lines in place, so a rejected hunk keeps
   * exactly its own turn-start lines while its neighbours stay as decided. A file the turn created
   * is removed when no hunk is accepted, and a file the turn deleted is removed when every hunk is
   * accepted. The new content is written to a sibling temporary file and renamed over the target, so
   * a reader observes either the previous or the new complete content and a failed write leaves the
   * previous content in place. Accepting the same decisions again writes the same content, because
   * the recorded comparison and the decisions fully determine it. The written content comes from the
   * recorded sides, not from the file as it stands now, so an edit made to a decided region after the
   * turn end is overwritten.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param decisions - one decision per hunk of that file's comparison, in hunk order.
   * @param signal - cancels the reads and the write.
   * @returns the outcome, or undefined once its Session was disposed, when this Host never recorded
   *   it, when no file has that index, or when the comparison is not text.
   * @throws when `decisions` does not carry exactly one decision per hunk, or when the write fails
   *   for a live Session.
   */
  applyHunks(
    sessionId: SessionId, seq: number, index: number, decisions: readonly WorkspaceHunkDecision[], signal: AbortSignal,
  ): Promise<WorkspaceHunkApplyResult | undefined>
  /**
   * Rewind every file changed since one turn's start back to its content at that moment: a file
   * present in the turn-start snapshot is written back to that content, and a file absent there
   * (created since) is removed. Spans every turn between the given one and now, not only the
   * given turn's own diff. Requires a git repository; a binary, oversized, or unreadable/unwritable
   * file is skipped rather than failing the whole rewind.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number, naming the turn to rewind to.
   * @param signal - cancels the reads and writes.
   * @returns the outcome, or undefined once its Session was disposed, when this Host never recorded
   *   it, or when the turn was recorded without a git snapshot.
   * @throws when a git read fails for a live Session.
   */
  restore(sessionId: SessionId, seq: number, signal: AbortSignal): Promise<WorkspaceRestoreResult | undefined>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A completed top-level turn's changed files were summarized; the summary itself stays on the
     * Host and is served by `workspaceChanges.summary` for the event's sequence while the Session
     * lives. The latest event for one turn replaces earlier ones.
     */
    'workspace/changes': { turn: number }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-turn changed-file summaries and comparisons of live Sessions. */
    workspaceChanges: WorkspaceChanges
  }
}

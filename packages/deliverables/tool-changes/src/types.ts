/** Canonical values of the recorded per-turn change tools. */

/** One file a turn changed, as the model reads it: names, line counts, and refusal markers. */
export interface TurnChangesFile {
  /** Path relative to the Session working directory, or an absolute Host path outside it. */
  path: string
  /** Label the summary lists the file under; a `../` path above the working directory, a `~` path under the home directory. */
  display: string
  /** Lines added; zero for a binary or oversized file. */
  added: number
  /** Lines deleted; zero for a binary or oversized file. */
  deleted: number
  /** Present when git or a captured side reported binary content. */
  binary?: boolean
  /** Present when a captured side exceeded the recorder's byte cap, so the file is listed without counts. */
  oversized?: boolean
}

/** Files one recorded turn changed, capped by the recorder's file limit. */
export interface TurnChangesValue {
  /** The turn the record belongs to. */
  turn: number
  /** The Session working directory `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, at most the recorder's file cap. */
  files: TurnChangesFile[]
  /** Complete changed-file count, including files the cap omitted. */
  total: number
  /** Lines added over every changed file, including omitted ones. */
  added: number
  /** Lines deleted over every changed file, including omitted ones. */
  deleted: number
}

/** One unified-diff hunk with three context lines; every line keeps its `+`, `-`, or space prefix. */
export interface TurnDiffHunk {
  /** First line of the hunk in the turn-start content, 1-based. */
  oldStart: number
  /** Lines of the hunk taken from the turn-start content. */
  oldLines: number
  /** First line of the hunk in the turn-end content, 1-based. */
  newStart: number
  /** Lines of the hunk taken from the turn-end content. */
  newLines: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  lines: string[]
}

/** One listed file's comparison in a recorded turn, discriminated by what the comparison could read. */
export type TurnDiffValue =
  | {
    kind: 'text'
    /** The turn the record belongs to. */
    turn: number
    /** The listed file's durable path. */
    path: string
    /** The listed file's display label. */
    display: string
    /** Whether the file existed at turn start. */
    before: boolean
    /** Whether the file existed at turn end. */
    after: boolean
    /** Hunks in file order; empty when both sides hold the same lines. */
    hunks: TurnDiffHunk[]
    /** True when the line comparison hit its time bound and every line is shown as replaced. */
    coarse: boolean
  }
  | {
    kind: 'binary'
    turn: number
    path: string
    display: string
  }
  | {
    kind: 'oversized'
    turn: number
    path: string
    display: string
  }

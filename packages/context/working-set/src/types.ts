/**
 * The working-set vocabulary: the files one task selects, per role, and the
 * bounds a caller applies to the selection.
 * @module @deepseek-ai/dsh-working-set/types
 */

/**
 * The files one task's working set holds, each list best-first and free of
 * duplicates. A file appears in one role only: `primary` when the objective
 * names a symbol it declares, `dependencies` when a primary file imports it,
 * and `tests`, `configs`, and `docs` when it serves one of those files.
 */
export interface WorkingSet {
  /** Files declaring a symbol the objective names. */
  readonly primary: readonly string[]
  /** Repository files the primary files import, one import level deep. */
  readonly dependencies: readonly string[]
  /** Test files whose name shares a word with a selected file's name. */
  readonly tests: readonly string[]
  /** Configuration files in the ancestor directories of the selected files. */
  readonly configs: readonly string[]
  /** Documentation files in the ancestor directories of the selected files. */
  readonly docs: readonly string[]
}

/** The file-count bounds one selection applies, one cap per role. */
export interface WorkingSetSelection {
  /** Maximum primary files. */
  readonly maxPrimaryFiles: number
  /** Maximum dependency files. */
  readonly maxDependencyFiles: number
  /** Maximum test files. */
  readonly maxTestFiles: number
  /** Maximum configuration files. */
  readonly maxConfigFiles: number
  /** Maximum documentation files. */
  readonly maxDocs: number
}

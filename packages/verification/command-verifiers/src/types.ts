/**
 * Vocabulary for the command-backed criterion verifiers: the deployment
 * document a composition configures, and the resolved target one criterion is
 * verified against.
 *
 * @module @deepseek-ai/dsh-command-verifiers/types
 */

/** One configured target, keyed in `Config.verifiers` by criterion id or verifier family. */
export interface VerifierEntry {
  /**
   * Shell command line, executed through `ctx.shell`. Mutually exclusive with
   * {@link expectedPaths}.
   */
  command?: string
  /**
   * Shell text appended to {@link command}, one space apart, in order. Each
   * entry is shell source like the command itself, so an argument the shell
   * must treat literally is quoted here.
   */
  args?: string[]
  /**
   * Working directory for the command, resolved by the shell executor's own
   * rules (an absolute path is used as given, a relative one against the
   * executor's configured directory). Absent uses that directory.
   */
  cwd?: string
  /**
   * Wall-clock ceiling for the command in milliseconds. Required with
   * {@link command}. The shell executor may clamp it to its own maximum.
   */
  timeoutMs?: number
  /** Exit codes that count as a pass. Required with {@link command}. */
  expectedExitCodes?: number[]
  /**
   * Working-directory-relative globs every changed scope of a `diff` criterion
   * must match. Mutually exclusive with {@link command}. Glob semantics are
   * picomatch's with `dot: true`: `**` spans `/`, `*` and `?` stop at `/`.
   */
  expectedPaths?: string[]
  /**
   * Decide the criterion by comparing the scopes the task changed against the
   * change contract the task declared. Mutually exclusive with {@link command}
   * and {@link expectedPaths}: both the contract and the changed scopes come
   * from the verification request, and the task states the bounds, so the
   * declaration here claims only which criterion is held to them.
   */
  contract?: boolean
}

/** A resolved target: the command one criterion runs, the scopes it may touch, or the boundary it is held to. */
export type ResolvedTarget = ResolvedCommandTarget | ResolvedScopeTarget | ResolvedContractTarget

/** A criterion decided by running one command and checking how it ended. */
export interface ResolvedCommandTarget {
  readonly kind: 'command'
  /** The configuration key this target was declared under. */
  readonly claim: string
  /** Fully composed command line: the declared command plus its arguments. */
  readonly command: string
  readonly timeoutMs: number
  readonly expectedExitCodes: readonly number[]
  /** Declared working directory, or undefined for the shell executor's own. */
  readonly cwd?: string
}

/** A `diff` criterion decided by comparing changed scopes with expected paths. */
export interface ResolvedScopeTarget {
  readonly kind: 'scopes'
  /** The configuration key this target was declared under. */
  readonly claim: string
  readonly expectedPaths: readonly string[]
}

/** A criterion decided by comparing the change against the contract its task declared. */
export interface ResolvedContractTarget {
  readonly kind: 'contract'
  /** The configuration key this target was declared under. */
  readonly claim: string
}

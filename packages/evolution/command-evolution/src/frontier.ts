/**
 * Capability frontier (§33): the weakest-first ordering of one scope's
 * skills from measured evidence. Pure derivation over the seams one command
 * reads — skill telemetry, the optimizer ledger, feedback signals, and the
 * skill catalog — so the ranking is unit-testable without a host.
 *
 * A capability is one skill: the telemetry record is the only per-skill
 * identity every other seam can join on. Archived skills never rank; leaving
 * the learning pool is the curator's decision, and the frontier must not
 * second-guess it.
 *
 * @module @deepseek-ai/dsh-command-evolution/frontier
 */

/** Measured winner behind one frontier score, as the ledger stores it. */
export interface FrontierWinner {
  /** Whether the newest measured winner passed. */
  readonly pass: boolean
  /** Billed tokens behind that winner. */
  readonly tokens: number
  /** Promotion tally behind that winner, or null when unconfirmed. */
  readonly confidence: { readonly wins: number; readonly runs: number } | null
}

/** Everything one frontier row is derived from. */
export interface FrontierInput {
  /** Skill name, the join key across every seam. */
  readonly name: string
  /** Catalog description, absent when the registry does not list the skill. */
  readonly description?: string | undefined
  /** Curator lifecycle state: archived skills never rank. */
  readonly archived: boolean
  /** Successful model loads through the skill tool. */
  readonly useCount: number
  /** Failed `skill`-tool loads. */
  readonly failureCount: number
  /** Times attributed evidence demoted the skill. */
  readonly trustFailures: number
  /** Sessions that loaded the skill. */
  readonly sessions: number
  /** Newest measured winner, or null when no run ever produced one. */
  readonly winner: FrontierWinner | null
  /** Top failure message observed while the skill was in play, if any. */
  readonly topFailure: string | null
}

/** One ranked frontier row, ready to render. */
export interface FrontierRow {
  /** Skill name. */
  readonly name: string
  /** Catalog description, absent when the registry does not list the skill. */
  readonly description?: string | undefined
  /** Measured score, or `unmeasured` when no run ever produced a winner. */
  readonly score: string
  /** Promotion tally, or null when unconfirmed. */
  readonly confidence: string | null
  /** Telemetry failures: attributed demotions plus failed loads. */
  readonly failures: number
  /** Top failure message observed while the skill was in play, if any. */
  readonly topFailure: string | null
  /** Successful model loads through the skill tool. */
  readonly loads: number
  /** Sessions that loaded the skill. */
  readonly sessions: number
}

/**
 * Render one input as a row. Sorting happens on the inputs, never on these
 * strings, so numeric tokens cannot misorder through lexicographic compare.
 * @param input - one skill's frontier evidence.
 * @returns the renderable row.
 */
function toRow(input: FrontierInput): FrontierRow {
  return {
    name: input.name,
    description: input.description,
    score: input.winner === null ? 'unmeasured' : `${input.winner.pass ? 'pass' : 'fail'} at ${input.winner.tokens} tokens`,
    confidence: input.winner?.confidence === null || input.winner?.confidence === undefined
      ? null
      : `${input.winner.confidence.wins}/${input.winner.confidence.runs}`,
    failures: input.trustFailures + input.failureCount,
    topFailure: input.topFailure,
    loads: input.useCount,
    sessions: input.sessions,
  }
}

/**
 * Rank one scope's skills weakest first: failing without a passing winner,
 * then unmeasured, then passing. Failing sorts by failures, passing by
 * confirmation, then demonstrated wins, then win rate, then cost — thin
 * evidence outranks a measured-good tally, and among equal tallies the
 * costlier pass is the weaker one, the same dominance the optimizer selects
 * by. No weights, no thresholds; the groups are the ranking.
 * @param inputs - one input per skill the seams know.
 * @returns the ranked rows, archived skills dropped.
 */
export function rankFrontier(inputs: readonly FrontierInput[]): FrontierRow[] {
  const live = inputs.filter(input => !input.archived)
  const failing = live
    .filter(input => input.trustFailures + input.failureCount > 0 && input.winner?.pass !== true)
    .sort((left, right) => (
      (right.trustFailures + right.failureCount) - (left.trustFailures + left.failureCount)
      || (left.name < right.name ? -1 : 1)
    ))
  const unmeasured = live
    .filter(input => input.winner === null && input.trustFailures + input.failureCount === 0)
    .sort((left, right) => (left.name < right.name ? -1 : 1))
  const passing = live
    .filter((input): input is FrontierInput & { winner: FrontierWinner } => input.winner?.pass === true)
    .sort((left, right) => {
      const leftConfidence = left.winner.confidence
      const rightConfidence = right.winner.confidence
      if (leftConfidence === null && rightConfidence !== null) return -1
      if (leftConfidence !== null && rightConfidence === null) return 1
      if (leftConfidence !== null && rightConfidence !== null && leftConfidence.wins !== rightConfidence.wins) {
        return leftConfidence.wins - rightConfidence.wins
      }
      if (leftConfidence !== null && rightConfidence !== null) {
        const weaker = leftConfidence.wins * rightConfidence.runs - rightConfidence.wins * leftConfidence.runs
        if (weaker !== 0) return weaker
      }
      return right.winner.tokens - left.winner.tokens || (left.name < right.name ? -1 : 1)
    })
  return [...failing, ...unmeasured, ...passing].map(toRow)
}

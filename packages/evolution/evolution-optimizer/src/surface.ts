/**
 * Failure surfaces: what the ledger has learned about which mutation operator
 * repairs which failure mode. The signature is the shape of the evidence a run
 * addressed — its wording without the magnitudes a fresh telemetry reading
 * changes — so the same recurring failure shares one record across runs, and
 * the operator lineups those runs drew from become a prior the next run can
 * order itself by.
 * @module @deepseek-ai/dsh-evolution-optimizer/surface
 */

import type { MutationOperator } from './mutate.ts'
import type { ExperimentRecord } from './types.ts'

/**
 * The shape of one evidence text: its wording, with every run of digits folded
 * to a single `#`, lowercased, and its whitespace collapsed. Counters move
 * between runs while the failure they describe does not, so the numbers are
 * exactly the part that must not split one failure mode into many.
 * @param evidence - the evidence text a run was given.
 * @returns the signature, stable across telemetry readings.
 */
export function failureSignature(evidence: string): string {
  return evidence.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}

/** What the ledger remembers about one operator under one failure signature. */
export interface OperatorRecord {
  /** Operator id. */
  operator: string
  /** Runs in which this operator produced a candidate. */
  tries: number
  /** Runs in which this operator produced the candidate the run promoted. */
  wins: number
  /**
   * Whether any of those candidates stated material the run's starting body did
   * not carry. False means this operator has only ever restated the body for
   * this failure, which orders it behind an operator that said something new.
   */
  fresh: boolean
}

/**
 * Record every operator the ledger watched under one failure signature. A run
 * credits a try to each operator that produced a candidate and a win to the one
 * whose candidate was promoted, so a run that promoted nothing still reports
 * the operators it exercised.
 * @param rows - one scope's ledger rows, newest first.
 * @param signature - failure signature, from {@link failureSignature}.
 * @returns one record per operator seen, by operator id.
 */
export function operatorRecords(
  rows: readonly ExperimentRecord[],
  signature: string,
): readonly OperatorRecord[] {
  const records = new Map<string, OperatorRecord>()
  const record = (operator: string): OperatorRecord => {
    const existing = records.get(operator)
    if (existing !== undefined) return existing
    const created: OperatorRecord = { operator, tries: 0, wins: 0, fresh: false }
    records.set(operator, created)
    return created
  }
  for (const row of rows) {
    if (row.baseline === null || failureSignature(row.evidence) !== signature) continue
    const novel = new Set(row.novelOperators)
    for (const operator of row.operators) {
      const entry = record(operator)
      entry.tries += 1
      if (novel.has(operator)) entry.fresh = true
    }
    if (row.winnerOperator !== null) record(row.winnerOperator).wins += 1
  }
  return [...records.values()].sort((left, right) =>
    left.operator.localeCompare(right.operator))
}

/**
 * Order one mutation lineup by what the ledger learned about this failure:
 * operators that have won here first (best win rate first), then operators this
 * failure has no record of, then operators that have only ever lost here —
 * and, among those losers, the ones that have at least restated the body in a
 * new way ahead of the ones that only ever repeated it, because repeating a
 * body this skill already carries cannot repair a failure it already failed.
 * The order matters because the candidate budget is split in lineup order, so
 * the operators with evidence take the remainder.
 * @param portfolio - operators this run may draw from, in configuration order.
 * @param records - what the ledger remembers, from {@link operatorRecords}.
 * @param minTries - candidate-producing runs an operator needs before its record counts.
 * @returns the lineup, in the order this run draws from it.
 */
export function orderPortfolio(
  portfolio: readonly MutationOperator[],
  records: readonly OperatorRecord[],
  minTries: number,
): readonly MutationOperator[] {
  const byId = new Map(records.map(record => [record.operator, record]))
  const index = (operator: MutationOperator): number => portfolio.indexOf(operator)
  const eligible = (record: OperatorRecord | undefined): record is OperatorRecord =>
    record !== undefined && record.tries >= minTries
  const rank = (operator: MutationOperator): number => {
    const record = byId.get(operator.id)
    if (!eligible(record)) return 1
    return record.wins > 0 ? 0 : 2
  }
  return [...portfolio].sort((left, right) => {
    const difference = rank(left) - rank(right)
    if (difference !== 0) return difference
    const leftRecord = byId.get(left.id)
    const rightRecord = byId.get(right.id)
    if (eligible(leftRecord) && eligible(rightRecord) && leftRecord.wins > 0 && rightRecord.wins > 0) {
      const rate = rightRecord.wins / rightRecord.tries - leftRecord.wins / leftRecord.tries
      if (rate !== 0) return rate
    }
    if (eligible(leftRecord) && eligible(rightRecord) && leftRecord.wins === 0 && rightRecord.wins === 0) {
      const fresh = Number(rightRecord.fresh) - Number(leftRecord.fresh)
      if (fresh !== 0) return fresh
      const spread = rightRecord.tries - leftRecord.tries
      if (spread !== 0) return spread
    }
    return index(left) - index(right)
  })
}

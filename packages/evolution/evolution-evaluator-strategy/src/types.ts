/**
 * Public type vocabulary of the evaluator-strategy store: one measured
 * evaluator verdict paired with its later ground truth, the durable
 * per-evaluator and per-task-class strategy statistics, and the ranked
 * recommendation of which evaluator to trust for a task class (§9). Types
 * only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-evaluator-strategy/src/types
 */

/** One evaluator identity, e.g. a scorer version. */
export type Evaluator = string

/** One task class an evaluator is judged on, e.g. a skill name. */
export type TaskClass = string

/**
 * Whether one verdict came from a route independent of the candidate's own
 * model (§28): a judge that produced the candidate it judges cannot corroborate
 * anything about it.
 */
export type JudgeIndependence = 'independent' | 'same-model'

/** One measured evaluator verdict paired with the later ground truth. */
export interface EvaluatorOutcome {
  /** The evaluator that produced the verdict. */
  evaluator: Evaluator
  /** The task class the verdict covers. */
  taskClass: TaskClass
  /** Model that produced the judged candidate; an empty string when unrecorded. */
  candidateModel: string
  /** Model that produced the verdict, as the route recorded it. */
  judgeModel: string
  /** The verdict the evaluator returned (the candidate passed). */
  verdict: boolean
  /** The later ground-truth result the verdict is judged against. */
  groundTruth: boolean
  /** Whether the ground truth came from an independent measurement. */
  independent: boolean
}

/** Durable trust statistics of one evaluator on one task class. */
export interface EvaluatorStrategy {
  /** The evaluator the statistics cover. */
  evaluator: Evaluator
  /** The task class the statistics cover. */
  taskClass: TaskClass
  /** Total recorded verdicts, independent or not. */
  samples: number
  /** Verdicts judged against an independent ground truth. */
  independentSamples: number
  /** Independent verdicts that matched the ground truth. */
  corroborations: number
  /**
   * Verdicts whose judge was the candidate's own model (§28). Absent on rows
   * recorded before judge identity was measured, which reads as 0.
   */
  selfJudgedSamples?: number | undefined
  /** Smoothed corroboration rate over the independent samples. */
  weight: number
  /** ISO-8601 instant of the last recorded verdict. */
  lastAt: string
}

/** One ranked evaluator with the numbers behind its rank. */
export interface StrategyRanking {
  /** The ranked evaluator. */
  evaluator: Evaluator
  /** Total recorded verdicts. */
  samples: number
  /** Verdicts judged against an independent ground truth. */
  independentSamples: number
  /** Independent verdicts that matched the ground truth. */
  corroborations: number
  /** Verdicts whose judge was the candidate's own model. */
  selfJudgedSamples?: number | undefined
  /**
   * The route §28 assigns to the final promotion review — the strongest
   * configured verifier — or null when no assignment is recorded. Set by
   * `ranking` and `recommend`; absent from a ranking a caller builds itself.
   */
  promotionReview?: { provider: string; model: string } | null
  /** Smoothed corroboration rate over the independent samples. */
  weight: number
  /** Why the evaluator ranks here, naming the numbers. */
  reason: string
}

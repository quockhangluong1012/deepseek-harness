/**
 * Public vocabulary of the evolution actuator: the closed loops it drives and
 * the decision each recorded verdict yields. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-actuator/src/types
 */

/**
 * One closed loop: the recorded verdict it reads and the step it performs. A
 * loop whose store is not mounted, or whose verdict has nothing to act on,
 * changes nothing.
 */
export type AutomationLoop =
  /** A live canary rollout, decided from its recorded triple. */
  | 'rollout'
  /** Islands whose scheduled migration is due. */
  | 'migration'
  /** Skills whose stagnation ladder rung asks for a change. */
  | 'recovery'
  /** The highest-priority uncertain evaluations. */
  | 'drain'
  /** Open curriculum proposals awaiting a benchmark task. */
  | 'admission'
  /** Recorded failures and recorded exposure, mined into benchmark tasks and ladder steps. */
  | 'growth'
  /** Recorded weaknesses turned into adversarial probes and §14 adversarial examples. */
  | 'adversary'

/** What a live rollout's recorded evidence decides. */
export type RolloutDecision =
  /** The patch holds or improves on the incumbent and reaches production. */
  | 'promote'
  /** The patch regressed against the incumbent and leaves the ladder. */
  | 'rollback'
  /** The patch carries no measurement, so nothing can be decided. */
  | 'hold'

/** The step a stagnant skill's ladder rung asks for. */
export type RecoveryStep =
  /** Move the skill's elite into its novelty lane (§32's first rung). */
  | 'diversify'
  /** Stage the tasks its measured capability gaps derive (§32's third rung). */
  | 'propose'
  /** Report the mutation instruction `evolution-operators` recommends for the skill (§32's second rung). */
  | 'operators'
  /** No store accepts this rung's switch, so the package that owns that evaluator set or route decides it. */
  | 'unactionable'

/**
 * Public type vocabulary of the meta-evolution store: the engine components
 * whose choices make an engine configuration, one run of the evolution engine
 * under a configuration, the derived per-configuration summary, and the
 * recommendation of which engine configuration to run next (§9). Types only —
 * no runtime code.
 * @module @deepseek-ai/dsh-evolution-meta/src/types
 */

/** The engine components an engine configuration selects. */
export type EngineComponent = 'operators' | 'evaluator' | 'budget' | 'routing'

/** One choice per engine component, e.g. an operator portfolio key. */
export interface EngineConfig {
  /** The mutation-operator choice. */
  operators: string
  /** The evaluator choice, e.g. a scorer version. */
  evaluator: string
  /** The budget-choice identity. */
  budget: string
  /** The routing choice. */
  routing: string
}

/** One task class an engine configuration is judged on, e.g. a skill name. */
export type MetaTaskClass = string

/** One run of the evolution engine under a configuration. */
export interface EngineRunInput {
  /** Run identity (the record key). */
  runId: string
  /** The task class the run optimized. */
  taskClass: MetaTaskClass
  /** The engine configuration the run used; missing fields take the default. */
  config: Partial<EngineConfig>
  /** Whether the run's winner passed. */
  pass: boolean
  /** Tokens the run spent. */
  tokens: number
  /** Wall time the run spent, in milliseconds. */
  wallTimeMs: number
}

/** One durable engine run. */
export interface EngineRun extends Omit<EngineRunInput, 'config'> {
  /** The complete engine configuration the run used. */
  config: EngineConfig
  /** ISO-8601 instant the run was recorded. */
  at: string
}

/** Derived summary of one engine configuration on one task class. */
export interface ConfigSummary {
  /** Deterministic identity of the configuration. */
  configId: string
  /** The configuration the summary covers. */
  config: EngineConfig
  /** The task class the summary covers. */
  taskClass: MetaTaskClass
  /** Runs recorded under the configuration on the class. */
  samples: number
  /** Runs whose winner passed. */
  passes: number
  /** Share of runs whose winner passed. */
  passRate: number
  /** Mean tokens per run. */
  meanTokens: number
  /** The sample-confidence-adjusted score that ranks the configuration. */
  score: number
  /** ISO-8601 instant of the last recorded run. */
  lastAt: string
}

/** One recommended engine configuration with the numbers behind it. */
export interface ConfigRecommendation {
  /** The recommended configuration. */
  config: EngineConfig
  /** Deterministic identity of the configuration. */
  configId: string
  /** The task class the recommendation covers. */
  taskClass: MetaTaskClass
  /** The sample-confidence-adjusted score of the configuration. */
  score: number
  /** Runs recorded under the configuration on the class. */
  samples: number
  /** Share of runs whose winner passed. */
  passRate: number
  /** Why the configuration ranks here, naming the numbers. */
  reason: string
}
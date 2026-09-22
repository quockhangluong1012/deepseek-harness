/**
 * Public type vocabulary of the meta-evolution store: the engine components
 * whose choices make an engine configuration, the recorded sequence of stages
 * an engine run performed (§26 level 2), one run of the evolution engine under
 * a configuration and that sequence, the derived per-configuration summary,
 * and the recommendation of which configuration and workflow to run next
 * (§9). Types only — no runtime code.
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

/**
 * One stage of the sequence an engine run performed — which component it
 * reached for, and in which position. The same configuration run in two orders
 * is two workflows, so the sequence is recorded rather than inferred from the
 * configuration (§26 level 2).
 */
export interface WorkflowStep {
  /** The engine component this stage used. */
  component: EngineComponent
  /** The choice the stage used for that component, e.g. an operator portfolio key. */
  choice: string
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
  /**
   * The sequence the run performed, in order; an absent one records that the
   * caller observed none, never a default sequence.
   */
  workflow?: readonly WorkflowStep[] | undefined
  /** Whether the run's winner passed. */
  pass: boolean
  /** Tokens the run spent. */
  tokens: number
  /** Wall time the run spent, in milliseconds. */
  wallTimeMs: number
}

/** One durable engine run. */
export interface EngineRun extends Omit<EngineRunInput, 'config' | 'workflow'> {
  /** The complete engine configuration the run used. */
  config: EngineConfig
  /** The recorded sequence the run performed, empty when the caller observed none. */
  workflow: readonly WorkflowStep[]
  /** ISO-8601 instant the run was recorded. */
  at: string
}

/** Derived summary of one configuration-and-workflow on one task class. */
export interface ConfigSummary {
  /** Deterministic identity of the configuration and workflow together. */
  configId: string
  /** The configuration the summary covers. */
  config: EngineConfig
  /** The sequence the summary covers, empty when no run recorded one. */
  workflow: readonly WorkflowStep[]
  /** Readable form of the sequence, e.g. `operators=portfolio-v1>evaluator=scorer-v1`. */
  workflowId: string
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

/** One recommended engine configuration and workflow with the numbers behind it. */
export interface ConfigRecommendation {
  /** The recommended configuration. */
  config: EngineConfig
  /** The recommended sequence, empty when the winning runs recorded none. */
  workflow: readonly WorkflowStep[]
  /** Readable form of the recommended sequence. */
  workflowId: string
  /** Deterministic identity of the configuration and workflow together. */
  configId: string
  /** The task class the recommendation covers. */
  taskClass: MetaTaskClass
  /** The sample-confidence-adjusted score of the configuration. */
  score: number
  /** Runs recorded under the configuration on the class. */
  samples: number
  /** Share of runs whose winner passed. */
  passRate: number
  /** Why the configuration ranks here, naming the numbers and the sequence. */
  reason: string
}

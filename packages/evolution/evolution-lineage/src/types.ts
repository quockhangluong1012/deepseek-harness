/**
 * Public type vocabulary of the dependency-aware lineage store: dependency
 * versions, experiment envelopes, comparability verdicts, and ablation
 * attribution (§34 dependency-aware evolution, §36 artifact lineage and
 * causal attribution, §48 reproducible evolutionary experiments). Types
 * only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-lineage/src/types
 */

/** One named dependency whose version an experiment envelope records. */
export type DependencyKey = 'prompt' | 'skill' | 'retriever' | 'evaluator' | 'model' | 'tool' | 'env'

/** The dependency versions an experiment ran under. */
export interface DependencyVersions {
  /** Version of the prompt in effect. */
  prompt?: string | undefined
  /** Version of the skill under test. */
  skill?: string | undefined
  /** Version of the retriever configuration in effect. */
  retriever?: string | undefined
  /** Version of the evaluator that measured the outcome. */
  evaluator?: string | undefined
  /** Version of the model route in effect. */
  model?: string | undefined
  /** Version of the tool set in effect. */
  tool?: string | undefined
  /** Version of the environment in effect. */
  env?: string | undefined
}

/** The measured verdict of one experiment. */
export type ExperimentOutcome = 'improved' | 'regressed' | 'inconclusive'

/** One durable dependency-versioned experiment envelope. */
export interface ExperimentEnvelope {
  /** Experiment identity. */
  experimentId: string
  /** Skill the experiment evaluated. */
  skill: string
  /** The hypothesis the experiment tested. */
  hypothesis?: string | undefined
  /** Identity of the candidate under test. */
  candidate: string
  /** Mutation operator that produced the candidate. */
  operator?: string | undefined
  /** Tasks the experiment ran. */
  tasks: string[]
  /** The experiment's measured triple. */
  metrics: {
    /** Whether the candidate passed its corpus. */
    pass: boolean
    /** Billed tokens the experiment consumed. */
    tokens: number
    /** Wall time of the experiment, in milliseconds. */
    wallTimeMs: number
  }
  /** The experiment's measured verdict. */
  outcome: ExperimentOutcome
  /** Skills that regressed under this experiment. */
  regressions: string[]
  /** Why the experiment was rejected, when it was. */
  rejectedReason?: string | undefined
  /** What the experiment taught, when it taught anything. */
  lessons?: string | undefined
  /** The dependency versions the experiment ran under. */
  dependencies: DependencyVersions
  /** Seeds the experiment ran, for replay. */
  seeds: number[]
  /** ISO-8601 instant the experiment was recorded. */
  at: string
}

/** One experiment offered for recording: the envelope minus its stamp. */
export type ExperimentInput = Omit<ExperimentEnvelope, 'at'>

/** Whether two experiments may be compared, and what changed. */
export interface ExperimentComparison {
  /** Whether the two envelopes ran under the same dependency versions. */
  comparable: boolean
  /** Compared keys whose versions differ, in compared order. */
  changed: DependencyKey[]
}

/** Which change an ablation credits with the improvement. */
export type Attribution = 'a' | 'b' | 'both' | 'interaction' | 'none'

/** Pass or fail of each arm of a two-factor ablation. */
export interface AblationResults {
  /** Whether the baseline arm passed. */
  baseline: boolean
  /** Whether the A-only arm passed. */
  aOnly: boolean
  /** Whether the B-only arm passed. */
  bOnly: boolean
  /** Whether the joint A+B arm passed. */
  both: boolean
}


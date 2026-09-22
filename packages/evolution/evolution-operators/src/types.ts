/**
 * Public type vocabulary of the mutation-operator store: the canonical
 * mutation operators, one artifact class they mutate, the durable
 * effectiveness statistics accumulated per operator and class, and the ranked
 * recommendation of which operator to try next (§8, §9). Types only — no
 * runtime code.
 * @module @deepseek-ai/dsh-evolution-operators/src/types
 */

/**
 * One mutation operator identity. The canonical operators are the eight named
 * by {@link MUTATION_OPERATORS}; deployments may add their own ids, which the
 * ranking admits once observed.
 */
export type MutationOperator = string

/** One artifact class a mutation operator may be used on, e.g. a skill name. */
export type ArtifactClass = string

/** One measured outcome of an operator used on one artifact class. */
export interface OperatorOutcome {
  /** The operator that performed the mutation. */
  operator: MutationOperator
  /** The artifact class the mutation targeted. */
  artifactClass: ArtifactClass
  /** Whether the mutated candidate was accepted (e.g. staged). */
  accepted: boolean
  /** The outcome delta: pass-delta (+1 improved, 0 unchanged, −1 regressed). */
  delta: number
}

/** Durable effectiveness statistics of one operator on one artifact class. */
export interface OperatorStats {
  /** The operator the statistics cover. */
  operator: MutationOperator
  /** The artifact class the statistics cover. */
  artifactClass: ArtifactClass
  /** Total recorded uses of the operator on the class. */
  attempts: number
  /** Uses whose candidate was accepted. */
  accepted: number
  /** Mean outcome delta over the attempts. */
  meanDelta: number
  /** Share of attempts whose delta was negative (a regression). */
  regressionRate: number
  /** ISO-8601 instant of the last recorded outcome. */
  lastAt: string
}

/** One ranked operator with the numbers behind its rank. */
export interface OperatorRanking {
  /** The ranked operator. */
  operator: MutationOperator
  /** Attempts recorded for the operator on the artifact class. */
  attempts: number
  /** Acceptance rate over the attempts (0.5 with no attempts yet). */
  acceptanceRate: number
  /** Mean outcome delta over the attempts (0 with no attempts yet). */
  meanDelta: number
  /** The nudge the operator's recorded instruction verdicts contribute. */
  instructionAdjustment: number
  /** The exploration-adjusted score that ranks the operator. */
  score: number
  /** Why the operator ranks here, naming the numbers. */
  reason: string
}

/** One proposed mutation instruction and the evidence for and against it (§9). */
export interface OperatorInstruction {
  /** The operator the instruction belongs to. */
  operator: MutationOperator
  /** The artifact class the instruction mutates. */
  artifactClass: ArtifactClass
  /** The instruction line the operator would send to a mutation request. */
  instruction: string
  /** Why the instruction was proposed, naming the evidence that motivated it. */
  reason: string
  /** Proposals recorded for this operator and class, including replaced ones. */
  proposals: number
  /** Verdicts accepting the current instruction. */
  accepted: number
  /** Verdicts rejecting the current instruction. */
  rejected: number
  /** Why the latest verdict landed as it did, null while none was recorded. */
  lastVerdict: string | null
  /** ISO-8601 instant the current instruction was proposed. */
  at: string
  /** ISO-8601 instant of the latest verdict, null while none was recorded. */
  decidedAt: string | null
}

/** One proposed mutation instruction offered for recording. */
export interface InstructionInput {
  /** The operator the instruction belongs to. */
  operator: MutationOperator
  /** The artifact class the instruction mutates. */
  artifactClass: ArtifactClass
  /** The instruction line to propose. */
  instruction: string
  /** Why this instruction, naming the evidence that motivates it. */
  reason: string
}

/** One verdict on the instruction its operator and artifact class holds. */
export interface InstructionVerdict {
  /** The operator whose instruction was judged. */
  operator: MutationOperator
  /** The artifact class whose instruction was judged. */
  artifactClass: ArtifactClass
  /** Whether the proposal was accepted. */
  accepted: boolean
  /** Why the verdict landed this way, naming the evidence behind it. */
  reason: string
}

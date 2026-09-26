/**
 * Contracts of the research controller: the research quality-control loop's
 * stage vocabulary, its durable run record, the stage-provider seam, and the
 * six-way answer contract. This module declares types only — the ordered stage
 * table and the transition rules live in `stages.ts` and `pipeline.ts`.
 *
 * A run's observations and claims are the agent kernel's records; this package
 * holds their identities, never copies of them. The durable record mirrors the
 * zod schema in `spec.ts` field for field, with `null` where a field is absent:
 * an absent field is written as `null` so a stored record round-trips exactly.
 * @module @deepseek-ai/dsh-research-controller/src/types
 */

import type { Evidence, EvidenceInput, TaskClaim, TaskClass } from '@deepseek-ai/dsh-agent-kernel'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one research run, as the run table is keyed. */
export type ResearchRunId = Branded<'ResearchRunId'>

/** One stage of the research quality-control loop. */
export type ResearchStage =
  | 'question'
  | 'decompose'
  | 'research-plan'
  | 'search'
  | 'source-triage'
  | 'claim-extraction'
  | 'evidence'
  | 'contradiction-search'
  | 'synthesis'
  | 'epistemic-review'

/** Who performs one stage's work. */
export type StageProducer =
  /** The agent loop: the model supplies the stage's output. */
  | 'agent-loop'
  /** A provider registered against this service; a stage with none fails loud. */
  | 'provider'

/** One stage's place in the loop. */
export interface StageDefinition {
  /** The stage. */
  readonly stage: ResearchStage
  /** Role that performs it. */
  readonly producer: StageProducer
  /** What the stage establishes, as this package states it. */
  readonly purpose: string
}

/** How far one stage has got. */
export type StageStatus =
  /** Not advanced yet. */
  | 'pending'
  /** Settled with output. */
  | 'produced'
  /** Settled without output; `failure` says what was missing. */
  | 'failed'

/** What one stage of one run produced. */
export interface StageRecord {
  /** The stage this record belongs to. */
  readonly stage: ResearchStage
  /** How far the stage has got. */
  readonly status: StageStatus
  /** Lines the stage produced, in order. */
  readonly output: readonly string[]
  /** Kernel evidence identities this stage recorded, in order. */
  readonly evidence: readonly string[]
  /** Kernel claim identities this stage asserted, in order. */
  readonly claims: readonly string[]
  /** Identity of the registered provider that performed the stage; `null` for the agent loop's stages. */
  readonly provider: string | null
  /** ISO-8601 instant the stage was first advanced. */
  readonly startedAt: string
  /** ISO-8601 instant the stage settled; `null` while it is pending. */
  readonly settledAt: string | null
  /** Why the stage failed; `null` unless the stage failed. */
  readonly failure: string | null
}

/** One statement of the final answer, with the claims it rests on. */
export interface AnswerStatement {
  /** The statement itself. */
  readonly statement: string
  /** Kernel claim identities the statement rests on. */
  readonly claims: readonly string[]
}

/**
 * The bucket one answer statement is stated in. The six buckets keep
 * documented facts, observations, interpretations, inferences, hypotheses, and
 * unresolved uncertainty distinguishable, which is the answer's whole contract.
 */
export type AnswerBucket =
  | 'documented'
  | 'observation'
  | 'interpretation'
  | 'inference'
  | 'hypothesis'
  | 'unresolved'

/** The final answer: one list per epistemic bucket. */
export interface ResearchAnswer {
  /** What sources document, as opposed to what this run inferred. */
  readonly documented: readonly AnswerStatement[]
  /** What this run observed directly. */
  readonly observation: readonly AnswerStatement[]
  /** What an observer made of the observations. */
  readonly interpretation: readonly AnswerStatement[]
  /** What follows from observations and interpretations without being either. */
  readonly inference: readonly AnswerStatement[]
  /** What the run proposes and has not established. */
  readonly hypothesis: readonly AnswerStatement[]
  /** What the run could not settle. */
  readonly unresolved: readonly AnswerStatement[]
}

/**
 * One research run: the question, every stage's durable state, and the answer
 * the epistemic review accepted.
 */
export interface ResearchRunRecord {
  /** Identity of this run. */
  readonly runId: string
  /** Session that owns the run. */
  readonly sessionId: string
  /** Kernel task this run answers to. */
  readonly taskId: string
  /** Class of the kernel task; a research run only starts under a research task. */
  readonly taskClass: TaskClass
  /** The question the run answers. */
  readonly question: string
  /** Every stage of the loop, in order, from run start. */
  readonly stages: readonly StageRecord[]
  /** The answer, once synthesis produced one. */
  readonly answer: ResearchAnswer | null
  /** ISO-8601 instant the run started. */
  readonly startedAt: string
  /** ISO-8601 instant the epistemic review accepted the answer; `null` until then. */
  readonly settledAt: string | null
}

/** What one stage provider produced. */
export interface StageOutcome {
  /** Lines the outcome states, in order. */
  readonly output: readonly string[]
  /** Observations the stage made; the controller records each as kernel evidence. */
  readonly observations?: readonly EvidenceInput[]
}

/** Everything one stage provider needs to perform its stage. */
export interface StageRequest {
  /** Run the stage belongs to. */
  readonly runId: string
  /** Stage to perform. */
  readonly stage: ResearchStage
  /** The run's question. */
  readonly question: string
  /** Sub-questions the decompose stage produced. */
  readonly subQuestions: readonly string[]
  /** Steps the research-plan stage produced. */
  readonly plan: readonly string[]
  /** Observations this run recorded before the stage, in order. */
  readonly evidence: readonly Evidence[]
  /** Claims this run asserted before the stage, in order. */
  readonly claims: readonly TaskClaim[]
}

/**
 * One implementation of a mechanism stage. A provider registered for a stage
 * is the only one: registering a second provider for the same stage is refused.
 */
export interface ResearchStageProvider {
  /** Stable identity recorded on every stage this provider performs. */
  readonly id: string
  /** Stages this provider performs. */
  readonly stages: readonly ResearchStage[]
  /**
   * Perform one stage.
   * @param request - the run's question, prior outputs, observations, and claims.
   * @param signal - cancellation of the call that is waiting for this stage.
   * @returns the stage's output and any observations it made.
   */
  run(request: StageRequest, signal: AbortSignal): Promise<StageOutcome>
}

/** One claim the claim-extraction stage asks the kernel to record. */
export interface ClaimInput {
  /** The statement the task asserts. */
  readonly statement: string
  /** Kernel evidence identities the claim cites. */
  readonly evidence: readonly string[]
  /** Stated confidence in `[0, 1]`. */
  readonly confidence: number
}

/** One answer statement the synthesis stage supplies. */
export interface SectionInput {
  /** Bucket the statement is stated in. */
  readonly bucket: AnswerBucket
  /** The statement itself. */
  readonly statement: string
  /** Kernel claim identities the statement rests on. */
  readonly claims: readonly string[]
}

/** One advancement of a run: everything any single stage may need. */
export interface AdvanceInput {
  /** Run to advance; omitted when starting a run at the question stage. */
  readonly runId?: string
  /** Stage to advance. */
  readonly stage: ResearchStage
  /**
   * Stage output lines, in order: the question for `question`, the
   * sub-questions for `decompose`, the steps for `research-plan`.
   */
  readonly items?: readonly string[]
  /** Claims for `claim-extraction`. */
  readonly claims?: readonly ClaimInput[]
  /** Answer statements for `synthesis`. */
  readonly sections?: readonly SectionInput[]
}

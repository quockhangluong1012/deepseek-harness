/**
 * Pure state transitions of one research run: the stage order and its gates,
 * the six-bucket answer, and the text a caller renders. Nothing here touches a
 * provider, a kernel record, or durable storage; the service in `index.ts`
 * performs those and hands the results to these functions.
 * @module @deepseek-ai/dsh-research-controller/src/pipeline
 */

import { assertNotBlank } from './caps.ts'
import { ResearchError } from './errors.ts'
import { RESEARCH_STAGES, STAGE_DEFINITIONS } from './stages.ts'
import type {
  AnswerBucket,
  AnswerStatement,
  ResearchAnswer,
  ResearchRunRecord,
  ResearchStage,
  SectionInput,
  StageRecord,
} from './types.ts'

/** Every bucket the final answer distinguishes, in the order the loop states them. */
export const ANSWER_BUCKETS: readonly AnswerBucket[] = [
  'documented',
  'observation',
  'interpretation',
  'inference',
  'hypothesis',
  'unresolved',
]

/** What one run starts from. */
export interface StartRunInput {
  /** Identity of the new run. */
  readonly runId: string
  /** Session that owns the run. */
  readonly sessionId: string
  /** Kernel task the run answers to. */
  readonly taskId: string
  /** The question the run answers. */
  readonly question: string
  /** ISO-8601 instant the run started. */
  readonly startedAt: string
}

/** What one settled stage contributed. */
export interface StageSettlement {
  /** Lines the stage produced, in order. */
  readonly output: readonly string[]
  /** Kernel evidence identities the stage recorded. */
  readonly evidence?: readonly string[]
  /** Kernel claim identities the stage asserted. */
  readonly claims?: readonly string[]
  /** Identity of the provider that performed the stage, when one did. */
  readonly provider?: string
  /** The answer, for the synthesis stage. */
  readonly answer?: ResearchAnswer
}

/**
 * Open one run: every stage pending except the question, which the caller
 * supplies settled.
 * @param input - run identity, the question, and the start instant.
 * @returns the new run record.
 */
export function startRun(input: StartRunInput): ResearchRunRecord {
  assertNotBlank('the research question', input.question)
  const stages: StageRecord[] = RESEARCH_STAGES.map(stage => stage === 'question'
    ? {
      stage,
      status: 'produced',
      output: [input.question],
      evidence: [],
      claims: [],
      provider: null,
      startedAt: input.startedAt,
      settledAt: input.startedAt,
      failure: null,
    }
    : {
      stage,
      status: 'pending',
      output: [],
      evidence: [],
      claims: [],
      provider: null,
      startedAt: input.startedAt,
      settledAt: null,
      failure: null,
    })
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    taskClass: 'research',
    question: input.question,
    stages,
    answer: null,
    startedAt: input.startedAt,
    settledAt: null,
  }
}

/**
 * Read one stage of a run.
 * @param run - the run to read.
 * @param stage - the stage to find.
 * @returns the stage's record.
 */
export function stageOf(run: ResearchRunRecord, stage: ResearchStage): StageRecord {
  const found = run.stages.find(record => record.stage === stage)
  if (found === undefined) throw new Error(`research: run ${run.runId} has no "${stage}" stage`)
  return found
}

/**
 * The stage the run may advance next: the first that has not produced. A
 * failed stage is the next one until it produces, which is how a stage is
 * retried rather than skipped.
 * @param run - the run to read.
 * @returns the next stage's record, or undefined when every stage has produced.
 */
export function nextStage(run: ResearchRunRecord): StageRecord | undefined {
  return run.stages.find(record => record.status !== 'produced')
}

/**
 * Refuse an advance that contradicts the run's stage order.
 * @param run - the run being advanced.
 * @param stage - the stage the caller asked to advance.
 * @throws ResearchError `run-settled` when the run already accepted its answer,
 *   `stage-out-of-order` when another stage must run first.
 */
export function assertAdvanceable(run: ResearchRunRecord, stage: ResearchStage): void {
  const next = nextStage(run)
  if (next === undefined) {
    throw new ResearchError(
      'run-settled',
      `research: run ${run.runId} has no stage left to advance; start a new run to research another question`,
    )
  }
  if (next.stage === stage) return
  // A refused answer is revised, then reviewed again: while the review is the
  // run's next stage and it failed, synthesis is admitted as the revision the
  // refusal asks for. Every other out-of-order advance is refused.
  const revision = next.stage === 'epistemic-review' && next.status === 'failed' && stage === 'synthesis'
  if (!revision) {
    throw new ResearchError(
      'stage-out-of-order',
      `research: run ${run.runId} is at stage "${next.stage}"; "${stage}" cannot run before it`,
    )
  }
}

/**
 * Record what one stage produced. Every other stage keeps its record.
 * @param run - the run being advanced.
 * @param stage - the settled stage.
 * @param settlement - its output, references, and answer.
 * @param at - ISO-8601 instant the stage settled.
 * @returns the updated run.
 */
export function settleStage(
  run: ResearchRunRecord,
  stage: ResearchStage,
  settlement: StageSettlement,
  at: string,
): ResearchRunRecord {
  const settled = run.stages.map(record => record.stage !== stage ? record : {
    stage,
    status: 'produced' as const,
    output: [...settlement.output],
    evidence: [...settlement.evidence ?? []],
    claims: [...settlement.claims ?? []],
    provider: settlement.provider ?? null,
    startedAt: record.startedAt,
    settledAt: at,
    failure: null,
  })
  // A revised answer re-opens the review that refused it: the violations a
  // refused answer produced describe an answer that no longer exists.
  const reopened = stage === 'synthesis' && stageOf(run, 'epistemic-review').status === 'failed'
    ? settled.map(record => record.stage !== 'epistemic-review' ? record : {
      ...record,
      status: 'pending' as const,
      output: [],
      settledAt: null,
      failure: null,
    })
    : settled
  return {
    ...run,
    stages: reopened,
    answer: settlement.answer ?? run.answer,
  }
}

/**
 * Record that one stage could not run, naming the missing referent. The run
 * stays at that stage: the next advance retries it.
 * @param run - the run being advanced.
 * @param stage - the stage that failed.
 * @param failure - what was missing.
 * @param at - ISO-8601 instant the stage settled.
 * @returns the updated run.
 */
export function failStage(run: ResearchRunRecord, stage: ResearchStage, failure: string, at: string): ResearchRunRecord {
  const stages = run.stages.map(record => record.stage !== stage ? record : {
    ...record,
    status: 'failed' as const,
    output: [],
    settledAt: at,
    failure,
  })
  return { ...run, stages }
}

/**
 * Group the synthesis stage's statements into the six epistemic buckets.
 * @param sections - the statements the model stated, in order.
 * @param knownClaims - claim identities this run recorded.
 * @returns the answer, grouped.
 * @throws ResearchError `stage-input-invalid` for a blank statement,
 *   `claim-missing` for a citation the run never recorded.
 */
export function buildAnswer(sections: readonly SectionInput[], knownClaims: readonly string[]): ResearchAnswer {
  const grouped: Record<AnswerBucket, AnswerStatement[]> = {
    documented: [],
    observation: [],
    interpretation: [],
    inference: [],
    hypothesis: [],
    unresolved: [],
  }
  for (const section of sections) {
    assertNotBlank('a synthesis statement', section.statement)
    for (const claimId of section.claims) {
      if (!knownClaims.includes(claimId)) {
        throw new ResearchError(
          'claim-missing',
          `research: the answer cites claim "${claimId}", which this run never recorded`,
        )
      }
    }
    grouped[section.bucket].push({ statement: section.statement, claims: [...section.claims] })
  }
  return grouped
}

/**
 * The contract the epistemic review enforces: an answer that states nothing is
 * not an answer, a statement outside `unresolved` must rest on a claim, and
 * every claim the run recorded must be stated in some bucket so a contradicting
 * or unsupported claim cannot disappear between extraction and the answer.
 * @param run - the run to review.
 * @returns one line per violation; empty when the answer is acceptable.
 */
export function reviewAnswer(run: ResearchRunRecord): readonly string[] {
  const answer = run.answer
  if (answer === null) return ['the run produced no answer to review']
  const findings: string[] = []
  const statements = ANSWER_BUCKETS.flatMap(bucket => answer[bucket])
  if (statements.length === 0) findings.push('the answer states nothing')
  for (const bucket of ANSWER_BUCKETS) {
    if (bucket === 'unresolved') continue
    for (const statement of answer[bucket]) {
      if (statement.claims.length === 0) {
        findings.push(`the ${bucket} statement "${statement.statement.slice(0, 80)}" rests on no claim`)
      }
    }
  }
  const cited = new Set(statements.flatMap(statement => statement.claims))
  for (const claimId of stageOf(run, 'claim-extraction').claims) {
    if (!cited.has(claimId)) findings.push(`claim "${claimId}" is stated in no bucket`)
  }
  return findings
}

/**
 * Describe one run and everything it has produced, for the model and for a
 * human reading the tool result.
 * @param run - the run to describe.
 * @returns the run as lines.
 */
export function renderRun(run: ResearchRunRecord): string {
  const produced = run.stages.filter(record => record.status === 'produced').length
  const lines = [`research run ${run.runId} (${String(produced)}/${String(RESEARCH_STAGES.length)} stages produced)`]
  if (run.question.trim().length > 0) lines.push(`question: ${run.question}`)
  for (const record of run.stages) {
    if (record.status === 'pending') continue
    lines.push(`- ${record.stage}: ${record.status}${record.provider === null ? '' : ` by ${record.provider}`}`)
    for (const line of record.output) lines.push(`  ${line}`)
    if (record.failure !== null) lines.push(`  ${record.failure}`)
  }
  const next = nextStage(run)
  const definition = next === undefined ? undefined : STAGE_DEFINITIONS.find(entry => entry.stage === next.stage)
  lines.push(next === undefined || definition === undefined
    ? 'next: none'
    : `next: ${next.stage} (${definition.producer}) — ${definition.purpose}`)
  if (run.answer !== null) {
    lines.push('answer:')
    for (const bucket of ANSWER_BUCKETS) {
      for (const statement of run.answer[bucket]) {
        lines.push(`  ${bucket}: ${statement.statement} [claims: ${statement.claims.join(', ')}]`)
      }
    }
  }
  return lines.join('\n')
}

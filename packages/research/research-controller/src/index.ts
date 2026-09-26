/**
 * Research controller (`ctx.research`): the research quality-control loop,
 * durable per-stage state, the stage-provider seam, and the six-way answer
 * contract.
 *
 * The loop's stage work is split by who can do it. The question, decompose,
 * research-plan, claim-extraction, evidence, synthesis, and epistemic-review
 * stages are the agent loop's: the model supplies each stage's output through
 * the `research_advance` tool. The search, source-triage, and
 * contradiction-search stages are mechanisms a package registers against
 * `ctx.research.registerStageProvider`; a run that reaches one with no
 * provider fails loud instead of skipping the stage.
 *
 * Observations and claims are the agent kernel's records: a stage provider's
 * observations are recorded with `ctx.agentKernel.recordEvidence`, the
 * claim-extraction stage records through `ctx.agentKernel.recordClaim`, and
 * nothing here keeps a second copy of either. Only the run's own state — the
 * question, each stage's status and output, and the accepted answer — is
 * durable, in the `research` storage domain.
 * @module @deepseek-ai/dsh-research-controller
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Evidence, EvidenceId, KernelView, TaskClaimId, TaskClass } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertBytesWithin, assertCountWithin, assertNotBlank } from './caps.ts'
import { ResearchError } from './errors.ts'
import {
  ANSWER_BUCKETS,
  assertAdvanceable,
  buildAnswer,
  failStage,
  renderRun,
  reviewAnswer,
  settleStage,
  stageOf,
  startRun,
} from './pipeline.ts'
import { researchDomainSpec } from './spec.ts'
import { PROVIDER_STAGES, RESEARCH_STAGES } from './stages.ts'
import type {
  AdvanceInput,
  ClaimInput,
  ResearchRunId,
  ResearchRunRecord,
  ResearchStage,
  ResearchStageProvider,
  SectionInput,
  StageOutcome,
  StageRequest,
} from './types.ts'

export { ResearchError, isResearchError } from './errors.ts'
export type { ResearchErrorCode } from './errors.ts'
export { PROVIDER_STAGES, RESEARCH_STAGES, STAGE_DEFINITIONS } from './stages.ts'
export { ANSWER_BUCKETS } from './pipeline.ts'
export { researchDomainSpec } from './spec.ts'
export type { ResearchRunRow } from './spec.ts'
export type {
  AdvanceInput,
  AnswerBucket,
  AnswerStatement,
  ClaimInput,
  ResearchAnswer,
  ResearchRunId,
  ResearchRunRecord,
  ResearchStage,
  ResearchStageProvider,
  SectionInput,
  StageDefinition,
  StageOutcome,
  StageProducer,
  StageRecord,
  StageRequest,
  StageStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable research runs, their stage order, and the stage-provider seam. */
    research: ResearchController
  }
}

/** Deployment-chosen caps on one run. */
export interface Config {
  /** Cap in UTF-8 bytes on any one stated text: the question, a stage line, a claim, an answer statement. */
  maxTextBytes: number
  /** Cap on one list: sub-questions, plan steps, stage output lines, claims, answer statements. */
  maxItems: number
  /** Settled runs retained per session; older settled runs are dropped as newer ones are stored. */
  maxRuns: number
}

/** Validated deployment caps; all three are explicit. */
export const Config: z<Config> = z.object({
  maxTextBytes: z.number().step(1).min(1).required(),
  maxItems: z.number().step(1).min(1).required(),
  maxRuns: z.number().step(1).min(1).required(),
})

/**
 * Durable research runs and the providers that perform their mechanism stages.
 */
export class ResearchController extends Service {
  static inject = ['storageDomain', 'tools', 'agentKernel']

  /** Deployment caps, as validated at load. */
  readonly config: Config

  private table!: KvTable<ResearchRunId, ResearchRunRecord>
  private readonly providers = new Map<ResearchStage, ResearchStageProvider>()

  /**
   * @param ctx - Host context carrying storage, the tool registry, and the kernel.
   * @param config - the caps a run is held to.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'research')
    this.config = config
  }

  /**
   * Register the provider that performs one or more mechanism stages. A stage
   * has exactly one provider, and only the stages whose work is a mechanism's
   * may be claimed.
   * @param provider - the provider to register.
   * @returns a disposer that removes the provider while it remains registered.
   * @throws When the provider declares no stage, an agent-loop stage, or a
   *   stage that already has a provider.
   */
  registerStageProvider(provider: ResearchStageProvider): () => void {
    if (provider.stages.length === 0) {
      throw new Error(`research: provider "${provider.id}" declares no stage`)
    }
    for (const stage of provider.stages) {
      if (!PROVIDER_STAGES.includes(stage)) {
        throw new Error(`research: provider "${provider.id}" claims the "${stage}" stage, whose work is the agent loop's`)
      }
      const existing = this.providers.get(stage)
      if (existing !== undefined) {
        throw new Error(`research: the "${stage}" stage already has provider "${existing.id}"`)
      }
    }
    for (const stage of provider.stages) this.providers.set(stage, provider)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const stage of provider.stages) this.providers.delete(stage)
    }
  }

  /**
   * Read the recorded research runs, newest first, for a reader that has no
   * live agent — an evaluation pass over what the loop recorded. The run
   * record is the whole durable state of a run; its evidence and claims are
   * kernel identities a caller resolves through the session log.
   * @param sessionId - restrict the read to one session's runs; every session's runs when omitted.
   * @returns the runs, newest first, each detached from the stored table.
   */
  runs(sessionId?: string): readonly ResearchRunRecord[] {
    return this.allRuns()
      .filter(run => sessionId === undefined || run.sessionId === sessionId)
      .map(run => structuredClone(run))
  }

  /**
   * Read the run a session is working on: the run named, else the session's
   * current run — its unsettled run, else its newest.
   * @param agent - the live agent whose session owns the run.
   * @param runId - identity of the run to read, when the caller names one.
   * @returns the run, or undefined when the session has none.
   * @throws ResearchError `run-not-found` when the named run does not exist or
   *   belongs to another session.
   */
  state(agent: Agent, runId?: string): ResearchRunRecord | undefined {
    const sessionId = String(agent.session.id)
    if (runId !== undefined) return this.requireRun(runId, sessionId)
    const runs = this.sessionRuns(sessionId)
    return runs.find(run => run.settledAt === null) ?? runs[0]
  }

  /**
   * Advance one run by exactly one stage, recording what the stage produced.
   * A stage that cannot run fails loud, naming the missing referent: a run
   * whose next stage is a provider's with no provider registered, or a stage
   * that requires an observation the session never recorded.
   * @param agent - the live agent whose session owns the run.
   * @param input - the stage to advance and the input only that stage takes.
   * @param signal - cancellation of the waiting call; it reaches a provider.
   * @returns the run after the stage settled or failed.
   * @throws ResearchError for every refusal, and the provider's own error when
   *   a provider fails.
   */
  async advance(agent: Agent, input: AdvanceInput, signal?: AbortSignal): Promise<ResearchRunRecord> {
    const sessionId = String(agent.session.id)
    const view = await this.ctx.agentKernel.snapshot(agent)
    if (view === undefined) {
      throw new ResearchError(
        'task-missing',
        `research: session ${sessionId} has no kernel task; a task is created at the session's first admitted step`,
      )
    }
    if (input.stage === 'question') {
      return await this.openRun(input, String(view.task.taskId), view.task.taskClass, sessionId)
    }

    const run = input.runId === undefined
      ? this.sessionRuns(sessionId).find(candidate => candidate.settledAt === null)
      : this.requireRun(input.runId, sessionId)
    if (run === undefined) {
      throw new ResearchError(
        'run-not-found',
        `research: session ${sessionId} has no research run; start one by advancing the question stage`,
      )
    }
    assertAdvanceable(run, input.stage)

    switch (input.stage) {
      case 'decompose':
      case 'research-plan':
        return await this.record(settleStage(run, input.stage, { output: this.lines(input.stage, input.items) }, this.now()))
      case 'search':
      case 'source-triage':
      case 'contradiction-search':
        return await this.providerStage(agent, run, input.stage, view, signal)
      case 'claim-extraction':
        return await this.claimStage(agent, run, view.evidence, input.claims)
      case 'evidence':
        return await this.evidenceStage(run, view.evidence)
      case 'synthesis':
        return await this.synthesisStage(run, input.sections)
      case 'epistemic-review':
        return await this.reviewStage(run)
    }
  }

  /** Open one run under the session's research task, or refuse when it has none. */
  private async openRun(
    input: AdvanceInput,
    taskId: string,
    taskClass: TaskClass | undefined,
    sessionId: string,
  ): Promise<ResearchRunRecord> {
    if (taskClass === undefined) {
      throw new ResearchError(
        'task-class-mismatch',
        'research: the session\'s kernel task records no class; a research run requires the research task class,'
        + ' which a deployment grants by naming a task class (the kernel `taskClass`) or an agent profile whose taskClass is research',
      )
    }
    if (taskClass !== 'research') {
      throw new ResearchError(
        'task-class-mismatch',
        `research: the session's kernel task is class "${taskClass}"; a research run requires the research task class,`
        + ' which a deployment grants by naming a task class (the kernel `taskClass`) or an agent profile whose taskClass is research',
      )
    }
    const unsettled = this.sessionRuns(sessionId).find(run => run.settledAt === null)
    if (unsettled !== undefined) {
      throw new ResearchError(
        'stage-out-of-order',
        `research: run ${unsettled.runId} is still at an unsettled stage; advance it before starting another question`,
      )
    }
    const items = this.lines('question', input.items)
    if (items.length !== 1) {
      throw new ResearchError(
        'stage-input-invalid',
        `research: the question stage takes exactly one line, not ${String(items.length)}`,
      )
    }
    return await this.record(startRun({
      runId: brandString<ResearchRunId>(randomUUID()),
      sessionId,
      taskId,
      question: items.join('\n'),
      startedAt: this.now(),
    }))
  }

  /** Perform one mechanism stage through its registered provider. */
  private async providerStage(
    agent: Agent,
    run: ResearchRunRecord,
    stage: ResearchStage,
    view: KernelView,
    signal?: AbortSignal,
  ): Promise<ResearchRunRecord> {
    const provider = this.providers.get(stage)
    if (provider === undefined) {
      throw new ResearchError(
        'stage-provider-missing',
        `research: no provider is registered for the "${stage}" stage; register one against ctx.research,`
        + ' or the run cannot leave this stage',
      )
    }
    const evidenceIds = new Set<string>(run.stages.flatMap(record => record.evidence))
    const claimIds = new Set<string>(run.stages.flatMap(record => record.claims))
    const request: StageRequest = {
      runId: run.runId,
      stage,
      question: run.question,
      subQuestions: stageOf(run, 'decompose').output,
      plan: stageOf(run, 'research-plan').output,
      evidence: view.evidence.filter(record => evidenceIds.has(record.evidenceId)),
      claims: view.claims.filter(record => claimIds.has(record.claimId)),
    }
    let outcome: StageOutcome
    try {
      outcome = await provider.run(request, signal ?? new AbortController().signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.record(failStage(run, stage, `the "${stage}" provider "${provider.id}" failed: ${message}`, this.now()))
      throw error
    }
    const observations = outcome.observations ?? []
    assertCountWithin(`the ${stage} observation count`, observations.length, this.config.maxItems)
    const lines = this.lines(stage, outcome.output)
    const recorded: EvidenceId[] = []
    for (const observation of observations) {
      assertNotBlank('an observation contentRef', observation.contentRef)
      recorded.push(this.ctx.agentKernel.recordEvidence(agent, observation).evidenceId)
    }
    return await this.record(settleStage(run, stage, {
      output: [...recorded.map(id => `${stage}: observation ${id}`), ...lines],
      evidence: recorded,
      provider: provider.id,
    }, this.now()))
  }

  /** Record the claims the model extracted, through the kernel's own records. */
  private async claimStage(
    agent: Agent,
    run: ResearchRunRecord,
    evidence: readonly Evidence[],
    claims: readonly ClaimInput[] | undefined,
  ): Promise<ResearchRunRecord> {
    const supplied = claims ?? []
    if (supplied.length === 0) {
      throw new ResearchError('stage-input-invalid', 'research: claim-extraction states at least one claim')
    }
    assertCountWithin('the claim count', supplied.length, this.config.maxItems)
    const recorded: TaskClaimId[] = []
    for (const claim of supplied) {
      assertNotBlank('a claim statement', claim.statement)
      assertBytesWithin('a claim statement', claim.statement, this.config.maxTextBytes)
      if (claim.evidence.length === 0) {
        throw new ResearchError(
          'evidence-missing',
          `research: the claim "${claim.statement.slice(0, 80)}" cites no observation; record one with record_evidence and cite it`,
        )
      }
      assertCountWithin('the evidence one claim cites', claim.evidence.length, this.config.maxItems)
      if (!Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) {
        throw new ResearchError('stage-input-invalid', `research: claim confidence ${String(claim.confidence)} is outside [0, 1]`)
      }
      for (const evidenceId of claim.evidence) {
        if (!evidence.some(record => record.evidenceId === evidenceId)) {
          throw new ResearchError(
            'evidence-missing',
            `research: the claim cites evidence "${evidenceId}", which this session never recorded`,
          )
        }
      }
      recorded.push(this.ctx.agentKernel.recordClaim(agent, {
        statement: claim.statement,
        evidence: claim.evidence.map(id => brandString<EvidenceId>(id)),
        confidence: claim.confidence,
      }).claimId)
    }
    return await this.record(settleStage(run, 'claim-extraction', {
      output: supplied.map(claim => claim.statement),
      claims: recorded,
    }, this.now()))
  }

  /** Collect the observations behind the answer, requiring one the run itself recorded. */
  private async evidenceStage(run: ResearchRunRecord, evidence: readonly Evidence[]): Promise<ResearchRunRecord> {
    const own = run.stages.flatMap(record => record.evidence)
    if (own.length === 0) {
      throw new ResearchError(
        'evidence-missing',
        `research: run ${run.runId} recorded no observation of its own; the evidence stage needs an observation from a stage that searched, not only evidence the model recalled`,
      )
    }
    const shown = evidence.slice(0, this.config.maxItems)
    const omitted = evidence.length - shown.length
    return await this.record(settleStage(run, 'evidence', {
      output: [
        ...shown.map(record => `${record.kind}: ${record.contentRef}`),
        ...omitted === 0 ? [] : [`${String(omitted)} further observations are not listed`],
      ],
      evidence: evidence.map(record => record.evidenceId),
      claims: stageOf(run, 'claim-extraction').claims,
    }, this.now()))
  }

  /** Group the answer statements and validate them against the run's claims. */
  private async synthesisStage(
    run: ResearchRunRecord,
    supplied: readonly SectionInput[] | undefined,
  ): Promise<ResearchRunRecord> {
    const sections = supplied ?? []
    if (sections.length === 0) {
      throw new ResearchError('stage-input-invalid', 'research: synthesis states at least one answer statement')
    }
    assertCountWithin('the answer statement count', sections.length, this.config.maxItems)
    for (const section of sections) {
      assertNotBlank('an answer statement', section.statement)
      assertBytesWithin('an answer statement', section.statement, this.config.maxTextBytes)
      assertCountWithin('the claims one statement cites', section.claims.length, this.config.maxItems)
    }
    const answer = buildAnswer(sections, stageOf(run, 'claim-extraction').claims)
    return await this.record(settleStage(run, 'synthesis', {
      output: sections.map(section => `${section.bucket}: ${section.statement}`),
      answer,
    }, this.now()))
  }

  /** Accept the answer, or refuse it with every violation the review found. */
  private async reviewStage(run: ResearchRunRecord): Promise<ResearchRunRecord> {
    const findings = reviewAnswer(run)
    const at = this.now()
    if (findings.length > 0) {
      const failure = `the answer was refused: ${findings.join('; ')}`
      await this.record(failStage(run, 'epistemic-review', failure, at))
      throw new ResearchError('review-rejected', `research: ${failure}`)
    }
    const accepted = stageOf(run, 'synthesis').output.length
    return await this.record({
      ...settleStage(run, 'epistemic-review', { output: [`accepted ${String(accepted)} answer statements`] }, at),
      settledAt: at,
    })
  }

  /** Read the run named by identity, scoped to one session. */
  private requireRun(runId: string, sessionId: string): ResearchRunRecord {
    const found = this.table.get(brandString<ResearchRunId>(runId))
    if (found === undefined || found.sessionId !== sessionId) {
      throw new ResearchError('run-not-found', `research: session ${sessionId} has no research run "${runId}"`)
    }
    return structuredClone(found)
  }

  /** One session's runs, newest first. */
  private sessionRuns(sessionId: string): ResearchRunRecord[] {
    return this.allRuns().filter(run => run.sessionId === sessionId)
  }

  /** Every recorded run, newest first. */
  private allRuns(): ResearchRunRecord[] {
    return [...this.table.entries()]
      .map(([, run]) => run)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  /** Validate one stage's supplied lines against the configured caps. */
  private lines(stage: ResearchStage, items: readonly string[] | undefined): string[] {
    const supplied = items ?? []
    if (supplied.length === 0) {
      throw new ResearchError('stage-input-invalid', `research: the ${stage} stage states at least one line`)
    }
    assertCountWithin(`the ${stage} line count`, supplied.length, this.config.maxItems)
    for (const line of supplied) {
      assertNotBlank(`a ${stage} line`, line)
      assertBytesWithin(`a ${stage} line`, line, this.config.maxTextBytes)
    }
    return [...supplied]
  }

  /** Store one run and drop this session's oldest settled runs over the retention cap. */
  private async record(run: ResearchRunRecord): Promise<ResearchRunRecord> {
    await this.table.put(brandString<ResearchRunId>(run.runId), run)
    const settled = this.sessionRuns(run.sessionId).filter(candidate => candidate.settledAt !== null)
    for (const candidate of settled.slice(this.config.maxRuns)) {
      await this.table.delete(brandString<ResearchRunId>(candidate.runId))
    }
    return run
  }

  /** Open the run domain and register the loop's tools. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(researchDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'research-controller.domainClose')
    this.table = domain.table('runs')

    this.ctx.tools.register(defineTool({
      name: 'research_advance',
      description: 'Advance the research quality-control loop by one stage and get the run back. '
        + 'The loop is question, decompose, research-plan, search, source-triage, claim-extraction, evidence, '
        + 'contradiction-search, synthesis, epistemic-review, in that order: a stage cannot be skipped, and a stage '
        + 'that failed is retried by advancing it again. An answer the review refused is revised by advancing '
        + 'synthesis again, which re-opens the review. State the model\'s own stages — items for question '
        + '(one line), decompose, and research-plan, claims for claim-extraction, sections for synthesis. '
        + 'The search, source-triage, and contradiction-search stages are the deployment\'s own work and take no input. '
        + 'Epistemic review accepts the run only when every claim is stated in one of the six buckets (documented, '
        + 'observation, interpretation, inference, hypothesis, unresolved) and no statement outside unresolved rests on no claim.',
      parameters: {
        runId: {
          type: 'string',
          description: 'Research run to advance. Omit to advance this session\'s current run; omit it on the question stage to start a new run.',
        },
        stage: {
          type: 'string',
          required: true,
          enum: [...RESEARCH_STAGES],
          description: 'Stage to advance. Stages run in the loop\'s order.',
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Output lines for the stage: the research question as one line for question, the sub-questions for decompose, the ordered steps for research-plan. Unused by every other stage.',
        },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              statement: { type: 'string', required: true, description: 'The statement the task asserts.' },
              evidence: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: 'Identities of observations already recorded with record_evidence.',
              },
              confidence: { type: 'number', required: true, description: 'Stated confidence in [0, 1].' },
            },
          },
          description: 'Claims for claim-extraction, each citing recorded observations.',
        },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              bucket: {
                type: 'string',
                required: true,
                enum: [...ANSWER_BUCKETS],
                description: 'Bucket the statement is stated in.',
              },
              statement: { type: 'string', required: true, description: 'The statement itself.' },
              claims: {
                type: 'array',
                items: { type: 'string' },
                description: 'Identities of claims this statement rests on; unresolved uncertainty may cite none.',
              },
            },
          },
          description: 'Answer statements for synthesis, each assigned to one bucket.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'string', required: true, description: 'Identity of the run.' },
            report: { type: 'string', required: true, description: 'The run as lines.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args, exec) => {
        if (exec.agent === undefined) {
          throw new ResearchError('agent-missing', 'research_advance requires an agent Session')
        }
        const run = await this.advance(exec.agent, {
          ...args.runId === undefined ? {} : { runId: args.runId },
          stage: args.stage,
          ...args.items === undefined ? {} : { items: args.items },
          ...args.claims === undefined ? {} : { claims: args.claims },
          ...args.sections === undefined
            ? {}
            : { sections: args.sections.map(section => ({ ...section, claims: section.claims ?? [] })) },
        }, exec.signal)
        return { runId: run.runId, report: renderRun(run) }
      },
    }))

    this.ctx.tools.register(defineTool({
      name: 'research_state',
      description: 'Read this session\'s research run: its question, which stages have produced, what each produced, '
        + 'the next stage to advance, and the accepted answer. Use it after a context break to recover the run before advancing it.',
      parameters: {
        runId: { type: 'string', description: 'Research run to read. Omit for this session\'s current run.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'string', description: 'Identity of the run, absent when the session has none.' },
            report: { type: 'string', required: true, description: 'The run as lines.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: (args, exec) => {
        if (exec.agent === undefined) {
          throw new ResearchError('agent-missing', 'research_state requires an agent Session')
        }
        const run = this.state(exec.agent, args.runId)
        return Promise.resolve(run === undefined
          ? { report: 'No research run in this session. Advance the question stage to start one.' }
          : { runId: run.runId, report: renderRun(run) })
      },
    }))
  }

  /** Current instant, ISO-8601. */
  private now(): string {
    return new Date().toISOString()
  }
}

export default ResearchController

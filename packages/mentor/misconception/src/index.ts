/**
 * The misconception engine (`ctx.misconception`): it judges a learner's stated
 * thesis against the deployment's pattern catalogue, records one evidence-backed
 * finding per occurrence — a kernel claim contradicted by the cited
 * observations, plus the learner record's own recurrence count — and drives each
 * occurrence through explain → counterexample → exercise → new case → reassess
 * over durable per-learner state. Nothing here calls a model: detection is the
 * catalogue matching a quoted thesis, and the correction text comes from the
 * pattern the deployment declared.
 * @module @deepseek-ai/dsh-misconception
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { EvidenceId } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConceptId, type CaseReference, type LearnerId } from '@deepseek-ai/dsh-learner-model'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { renderDirective } from './directive.ts'
import { boundText, matchPattern, patternSchema, resolveConfig } from './patterns.ts'
import type { ResolvedConfig } from './patterns.ts'
import { completeStage, exerciseOf, misconceptionIdOf, objectiveIdOf, waitingForOf } from './pipeline.ts'
import { misconceptionDomainSpec } from './spec.ts'
import type { MisconceptionPipelineRow } from './spec.ts'
import type {
  AdvanceRequest,
  MentorDirective,
  MisconceptionDetection,
  MisconceptionId,
  MisconceptionPattern,
  MisconceptionPipeline,
  MisconceptionStage,
  ThesisInput,
} from './types.ts'
import './events.ts'

export type * from './types.ts'
export { boundText, matchPattern, resolveConfig } from './patterns.ts'
export { directiveDigest, renderDirective } from './directive.ts'
export { completeStage, exerciseIdOf, exerciseOf, misconceptionIdOf, objectiveIdOf, waitingForOf } from './pipeline.ts'
export { MISCONCEPTION_STAGES } from './pipeline.ts'
export { misconceptionDomainSpec, misconceptionPipelineRow } from './spec.ts'
export type { CatalogueInput, ResolvedConfig } from './patterns.ts'
export type { MisconceptionStageChange } from './events.ts'

/** Deployment configuration for the misconception engine: the pattern catalogue and the text cap. */
export interface Config {
  /** The misconception patterns this deployment can detect, in the order the first match decides. */
  patterns: MisconceptionPattern[]
  /** Cap in UTF-16 characters on every learner-quoted or engine-rendered text the engine stores or emits. */
  maxTextChars?: number
}

/** Schemastery validation for {@link Config}; a missing or empty catalogue fails at load. */
export const Config: z<Config> = z.object({
  patterns: z.array(patternSchema).required(),
  maxTextChars: z.number().step(1).min(1).default(2_000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The evidence-backed misconception engine over durable per-learner pipelines. */
    misconception: MisconceptionEngine
  }
}

/**
 * The misconception engine over the `mentor_misconception` domain. The domain
 * opens at init and closes through `ctx.effect`; the learner record is a
 * required dependency, because a finding nobody owns would leave a learner's
 * recurrence count unwritten.
 */
export class MisconceptionEngine extends Service {
  static inject = ['storageDomain', 'learnerModel']

  private table?: KvTable<string, MisconceptionPipelineRow>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain and the learner record.
   * @param config - the deployment's misconception catalogue and text cap.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'misconception')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and keep the pipeline table. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(misconceptionDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'misconception.domainClose')
    this.table = domain.table('pipelines')
  }

  /**
   * The catalogued pattern one stated thesis matches.
   * @param thesis - the learner's stated thesis.
   * @returns the matching pattern, or undefined when the catalogue does not recognize the thesis.
   */
  match(thesis: string): MisconceptionPattern | undefined {
    return matchPattern(this.resolved.patterns, thesis)
  }

  /**
   * Judge one stated thesis, record the finding in the three places that own
   * it — the learner record's misconceptions and objectives, the pipeline
   * table, and the kernel's claim ledger — and announce it.
   * @param input - the thesis, the learner, the agent that asserts the finding, and the contradicting observations.
   * @returns the recorded detection, with the recurrence count read back from the learner record.
   * @throws when no catalogued pattern matches the thesis, or when no contradicting observation is cited.
   */
  async detect(input: ThesisInput): Promise<MisconceptionDetection> {
    const pattern = this.match(input.thesis)
    if (pattern === undefined) {
      throw new Error('misconception engine: no catalogued pattern matches the stated thesis')
    }
    if (input.evidence.length === 0) {
      throw new Error('misconception engine: a detection needs the observations that contradict the thesis')
    }
    const thesis = boundText(input.thesis, this.resolved.maxTextChars)
    const misconceptionId = misconceptionIdOf(input.learnerId, pattern.id)
    const now = new Date().toISOString()
    const learner = this.ctx.learnerModel
    await learner.recordMisconception(input.learnerId, {
      misconceptionId,
      statement: pattern.misconception,
      ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
      trust: 'trusted',
    })
    const entry = learner.misconceptions(input.learnerId)
      .find(candidate => candidate.misconceptionId === misconceptionId)
    await this.recordObjective(input.learnerId, misconceptionId, pattern)
    const table = this.requireTable()
    const existing = table.get(misconceptionId)
    const stage: MisconceptionStage = existing === undefined || existing.stage === 'complete'
      ? 'explain'
      : existing.stage
    const row: MisconceptionPipelineRow = {
      misconceptionId,
      learnerId: input.learnerId,
      patternId: pattern.id,
      thesis,
      stage,
      evidence: [...input.evidence],
      exercise: existing?.exercise ?? null,
      caseId: input.caseId ?? existing?.caseId ?? null,
      attempt: existing?.attempt ?? null,
      detectedAt: existing?.detectedAt ?? now,
      updatedAt: now,
    }
    await table.put(misconceptionId, row)
    const claim = this.ctx.get('agentKernel')?.recordClaim(input.agent, {
      statement: `Misconception: ${pattern.misconception}. Design error: ${pattern.designError}. Learner thesis: "${thesis}"`,
      evidence: input.evidence,
      confidence: 0,
      status: 'contradicted',
    })
    const detection: MisconceptionDetection = {
      misconceptionId,
      learnerId: input.learnerId,
      patternId: pattern.id,
      thesis,
      misconception: pattern.misconception,
      designError: pattern.designError,
      objective: pattern.objective,
      evidence: [...input.evidence],
      ...(claim === undefined ? {} : { claimId: claim.claimId }),
      occurrences: entry?.recurrences ?? 1,
      recurring: (entry?.recurrences ?? 1) > 1,
      stage,
      detectedAt: now,
    }
    this.ctx.emit('mentor/misconception-detected', detection)
    return detection
  }

  /**
   * One learner's pipeline for one misconception.
   * @param learnerId - the learner whose record carries the occurrence.
   * @param misconceptionId - the derived occurrence identity.
   * @returns the pipeline, or undefined when this learner never showed it.
   */
  pipeline(learnerId: LearnerId, misconceptionId: MisconceptionId): MisconceptionPipeline | undefined {
    const row = this.requireTable().get(misconceptionId)
    if (row === undefined || row.learnerId !== learnerId) return undefined
    return this.view(row)
  }

  /**
   * Every pipeline one learner holds, most recently written first.
   * @param learnerId - the learner whose pipelines are read.
   * @returns the pipelines, detached from the store.
   */
  pipelines(learnerId: LearnerId): readonly MisconceptionPipeline[] {
    return [...this.requireTable().entries()]
      .filter(([, row]) => row.learnerId === learnerId)
      .map(([, row]) => this.view(row))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * The instruction the mentor agent receives for a pipeline's current stage.
   * @param learnerId - the learner whose record carries the occurrence.
   * @param misconceptionId - the derived occurrence identity.
   * @param caseId - the case the learner works on, required from the new-case stage onward.
   * @returns the directive, or undefined when the cycle is complete and holds nothing to teach.
   * @throws when the learner holds no such pipeline, or when the pipeline reached the new-case stage without a case.
   */
  directive(
    learnerId: LearnerId,
    misconceptionId: MisconceptionId,
    caseId?: CaseReference,
  ): MentorDirective | undefined {
    const row = this.requireTable().get(misconceptionId)
    if (row === undefined || row.learnerId !== learnerId) {
      throw new Error(`misconception engine: learner '${learnerId}' holds no pipeline for '${misconceptionId}'`)
    }
    if (row.stage === 'complete') return undefined
    const pipeline = this.view(row)
    const pattern = this.requirePattern(row.patternId)
    return renderDirective(
      pipeline,
      pattern,
      pipeline.exercise,
      caseId ?? pipeline.caseId,
      this.resolved.maxTextChars,
    )
  }

  /**
   * Complete a pipeline's current stage with an observed fact and move to the
   * next. The learner record follows the transition: a repeated reassessment
   * counts the misconception's recurrence, and a resolved one leaves the
   * misconception resolved with its objective retired.
   * @param request - the occurrence and the fact that completes its current stage.
   * @returns the pipeline at its new stage.
   * @throws when the learner holds no such pipeline, or when the fact is not the kind the current stage accepts.
   */
  async advance(request: AdvanceRequest): Promise<MisconceptionPipeline> {
    const table = this.requireTable()
    const row = table.get(request.misconceptionId)
    if (row === undefined) {
      throw new Error(`misconception engine: no pipeline for misconception '${request.misconceptionId}'`)
    }
    const from = row.stage
    const to = completeStage(from, request.fact)
    const pattern = this.requirePattern(row.patternId)
    await table.put(request.misconceptionId, {
      ...row,
      stage: to,
      ...(to === 'exercise'
        ? { exercise: exerciseOf(request.misconceptionId, pattern.objective, pattern.exercise) }
        : {}),
      ...(request.fact.kind === 'attempted'
        ? { attempt: boundText(request.fact.attempt, this.resolved.maxTextChars) }
        : {}),
      ...(request.fact.kind === 'case-selected' ? { caseId: request.fact.caseId } : {}),
      updatedAt: new Date().toISOString(),
    })
    const learnerId = brandString<LearnerId>(row.learnerId)
    if (to === 'counterexample') {
      await this.ctx.learnerModel.setMisconceptionStatus(learnerId, request.misconceptionId, 'addressed')
    }
    if (to === 'explain') {
      // Only a repeated reassessment returns to `explain`, and that is the
      // learner showing the misconception again, so the record counts the
      // recurrence exactly as a second detection would.
      await this.ctx.learnerModel.recordMisconception(learnerId, {
        misconceptionId: request.misconceptionId,
        statement: pattern.misconception,
        ...(row.caseId === null ? {} : { caseId: brandString<CaseReference>(row.caseId) }),
        trust: 'trusted',
      })
    }
    if (to === 'complete') {
      await this.ctx.learnerModel.setMisconceptionStatus(learnerId, request.misconceptionId, 'resolved')
      await this.retireObjective(learnerId, request.misconceptionId)
    }
    const pipeline = this.view(table.get(request.misconceptionId) ?? row)
    this.ctx.emit('mentor/misconception-stage', {
      misconceptionId: request.misconceptionId,
      learnerId,
      from,
      to,
      fact: request.fact.kind,
      ...(pipeline.waitingFor === undefined ? {} : { waitingFor: pipeline.waitingFor }),
    })
    return pipeline
  }

  /**
   * Record the misconception's objective on the learner record unless that
   * objective is already there.
   * @param learnerId - the learner whose objectives are written.
   * @param misconceptionId - the occurrence the objective belongs to.
   * @param pattern - the pattern that declares the objective.
   */
  private async recordObjective(
    learnerId: LearnerId,
    misconceptionId: MisconceptionId,
    pattern: MisconceptionPattern,
  ): Promise<void> {
    const objectiveId = objectiveIdOf(misconceptionId)
    const learner = this.ctx.learnerModel
    const existing = learner.objectives(learnerId)
    if (existing.some(candidate => candidate.objectiveId === objectiveId)) return
    await learner.setObjectives(learnerId, [...existing, {
      objectiveId,
      statement: pattern.objective,
      concepts: [ConceptId(pattern.id)],
      trust: 'trusted',
    }])
  }

  /**
   * Drop the misconception's objective from the learner record, leaving every
   * other objective untouched, once the learner stopped showing it.
   * @param learnerId - the learner whose objectives are written.
   * @param misconceptionId - the occurrence whose objective is retired.
   */
  private async retireObjective(learnerId: LearnerId, misconceptionId: MisconceptionId): Promise<void> {
    const objectiveId = objectiveIdOf(misconceptionId)
    const learner = this.ctx.learnerModel
    const existing = learner.objectives(learnerId)
    const next = existing.filter(candidate => candidate.objectiveId !== objectiveId)
    if (next.length === existing.length) return
    await learner.setObjectives(learnerId, next)
  }

  /** Project one stored row onto the pipeline its reader sees, resolving the pattern's own text. */
  private view(row: MisconceptionPipelineRow): MisconceptionPipeline {
    const pattern = this.requirePattern(row.patternId)
    const exercise = row.exercise === null
      ? undefined
      : {
        exerciseId: row.exercise.exerciseId,
        misconceptionId: brandString<MisconceptionId>(row.exercise.misconceptionId),
        objective: row.exercise.objective,
        prompt: row.exercise.prompt,
      }
    const waitingFor = waitingForOf(row.stage, pattern.misconception, row.exercise?.exerciseId)
    return {
      misconceptionId: brandString<MisconceptionId>(row.misconceptionId),
      learnerId: brandString<LearnerId>(row.learnerId),
      patternId: row.patternId,
      thesis: row.thesis,
      misconception: pattern.misconception,
      designError: pattern.designError,
      objective: pattern.objective,
      stage: row.stage,
      evidence: row.evidence.map(id => brandString<EvidenceId>(id)),
      ...(waitingFor === undefined ? {} : { waitingFor }),
      ...(exercise === undefined ? {} : { exercise }),
      ...(row.caseId === null ? {} : { caseId: brandString<CaseReference>(row.caseId) }),
      ...(row.attempt === null ? {} : { attempt: row.attempt }),
      detectedAt: row.detectedAt,
      updatedAt: row.updatedAt,
    }
  }

  /** The pattern a stored row refers to; a row whose pattern left the catalogue fails loudly. */
  private requirePattern(patternId: string): MisconceptionPattern {
    const pattern = this.resolved.patterns.find(candidate => candidate.id === patternId)
    if (pattern === undefined) {
      throw new Error(`misconception engine: stored pipeline refers to pattern '${patternId}', which the catalogue no longer declares`)
    }
    return pattern
  }

  private requireTable(): KvTable<string, MisconceptionPipelineRow> {
    if (this.table === undefined) throw new Error('misconception engine is not started yet')
    return this.table
  }
}

export default MisconceptionEngine

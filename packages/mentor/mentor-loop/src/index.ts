/**
 * The mentor quality loop (`ctx.mentorLoop`): §20's OBSERVE → EVALUATE →
 * DEVIL ADVOCATE → MISCONCEPTION DETECTION → TEACH → EXERCISE → REASSESS →
 * LEARNER MODEL UPDATE as a plugin over the seams that already exist — the
 * agent loop's pre-step, the kernel's claims and evidence, the misconception
 * engine, and the learner record. It runs no agent loop, calls no model, and
 * keeps no state of its own: every position is derived from those seams, and
 * each step performs at most one durable action.
 *
 * A directive reaches the mentor agent as injected context on the next
 * admitted pre-step, carrying the digest of the engine directive it renders,
 * so one stage's instruction is delivered once and the next stage starts only
 * after the learner has spoken again.
 * @module @deepseek-ai/dsh-mentor-loop
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EvidenceId } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConceptId, LearnerId, type CaseReference } from '@deepseek-ai/dsh-learner-model'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {
  MentorDirective,
  MisconceptionFact,
  MisconceptionId,
  MisconceptionPipeline,
} from '@deepseek-ai/dsh-misconception'
import { observe } from './observe.ts'
import type { MentorObservation } from './observe.ts'
import { contradictingEvidence, deriveMentorPosition } from './position.ts'
import type { MentorLoopInputs } from './position.ts'
import { renderMentorDirective } from './render.ts'
import type { MentorLoopPosition } from './types.ts'
import './events.ts'

export type * from './types.ts'
export { MENTOR_STAGES, contradictingEvidence, deriveMentorPosition } from './position.ts'
export type { MentorLoopInputs, MentorLoopPipeline } from './position.ts'
export { observe } from './observe.ts'
export type { MentorObservation } from './observe.ts'
export { renderMentorDirective } from './render.ts'

/** Deployment configuration for the mentor loop. */
export interface Config {
  /** The learner whose record every session on this context mentors. */
  learnerId: string
  /** Cap in UTF-16 characters on one injected directive. */
  maxDirectiveChars?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  learnerId: z.string().required(),
  maxDirectiveChars: z.number().step(1).min(1).default(2_000),
})

/** Configuration the loop runs with. */
export interface ResolvedConfig {
  /** The learner the loop updates and reads. */
  readonly learnerId: LearnerId
  /** Cap in UTF-16 characters on one injected directive. */
  readonly maxDirectiveChars: number
}

/**
 * Resolve defaults and reject configuration the loop cannot act on.
 * @param config - the validated plugin configuration.
 * @returns the learner identity and the directive cap.
 * @throws when the learner id is blank, because a loop that mentors nobody would update no record.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (config.learnerId.trim().length === 0) {
    throw new Error('mentor loop: learnerId is blank, so no learner record could be updated')
  }
  return {
    learnerId: LearnerId(config.learnerId),
    maxDirectiveChars: config.maxDirectiveChars ?? 2_000,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The §20 mentor quality loop over the agent loop, the kernel, the misconception engine, and the learner record. */
    mentorLoop: MentorLoop
  }
}

/** One loop step's reading: the position, the owners' records it came from, and what a mutation needs. */
interface LoopRead {
  readonly position: MentorLoopPosition
  readonly observation: MentorObservation
  readonly pipeline?: MisconceptionPipeline
  readonly directive?: MentorDirective
  readonly counterEvidence: readonly EvidenceId[]
  readonly caseId?: CaseReference
}

/**
 * The mentor quality loop. It reads its position from the session log, the
 * kernel view, the misconception engine, and the learner record, and performs
 * at most one durable action per step. The kernel is optional, as it is for
 * the misconception engine: with no kernel mounted the loop waits at
 * devil-advocate, because the session holds no claim or observation to act on.
 */
export class MentorLoop extends Service {
  static inject = ['learnerModel', 'misconception']

  private readonly resolved: ResolvedConfig
  private readonly announced = new Map<string, string>()

  /**
   * @param ctx - host context carrying the learner record and the misconception engine, plus the kernel when one is mounted.
   * @param config - the learner this context mentors and the directive cap.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mentorLoop')
    this.resolved = resolveConfig(config)
  }

  /** Register the pre-step delivery and drop per-session announcement memory. */
  protected [Service.init](): void {
    this.ctx.effect(() => () => { this.announced.clear() }, 'mentor-loop.announcements')
    this.ctx.on('session/disposed', (session) => { this.announced.delete(String(session.id)) })
    this.ctx.effect(() => this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const directive = await this.nudge(agent)
      return directive === undefined ? decision : { ...decision, messages: [...decision.messages, directive] }
    }), 'mentor-loop.preStep')
  }

  /**
   * Where one mentor session stands in the loop, derived from the seams. It
   * mutates nothing.
   * @param agent - the mentor agent whose session is read.
   * @returns the stage, the action the loop would take, and the named wait when nothing can advance.
   */
  position(agent: Agent): MentorLoopPosition {
    return this.read(agent).position
  }

  /**
   * Perform the one action the position calls for — a detection or a stage
   * completion — and report the next position.
   * @param agent - the mentor agent whose session drives the loop.
   * @returns the position after the action; unchanged when the loop was waiting.
   * @throws when an owner refuses the write the action asks for.
   */
  async step(agent: Agent): Promise<MentorLoopPosition> {
    const read = this.read(agent)
    if (read.position.action === 'detect' && read.observation.analysis !== undefined) {
      await this.ctx.misconception.detect({
        agent,
        learnerId: this.resolved.learnerId,
        thesis: read.observation.analysis,
        evidence: read.counterEvidence,
      })
    }
    if (read.position.action === 'advance' && read.pipeline !== undefined) {
      const fact = this.factFor(read)
      await this.ctx.misconception.advance({ misconceptionId: read.pipeline.misconceptionId, fact })
      if (fact.kind === 'reassessed' && fact.outcome === 'repeated') await this.recordMistake(read.pipeline)
      if (fact.kind === 'reassessed' && fact.outcome === 'resolved') {
        // This step closed the cycle: the engine wrote the resolution and
        // retired the objective, so the loop reports the learner-model update
        // it just caused rather than the position the closed cycle leaves behind.
        const position = this.closedPosition(read.pipeline.misconceptionId)
        this.announce(agent, position)
        return position
      }
    }
    const position = this.position(agent)
    this.announce(agent, position)
    return position
  }

  /** The §20 stage a just-closed cycle reached, waiting when the learner record does not carry the resolution. */
  private closedPosition(misconceptionId: MisconceptionId): MentorLoopPosition {
    const resolved = this.ctx.learnerModel.misconceptions(this.resolved.learnerId)
      .find(entry => entry.misconceptionId === misconceptionId)
      ?.status === 'resolved'
    return {
      stage: 'learner-model-update',
      action: 'none',
      ...(resolved ? {} : { waitingFor: 'the learner record to carry the resolved misconception' }),
      pipelineStage: 'complete',
    }
  }

  /**
   * The message to inject when the position calls for delivery and the log
   * does not already carry that stage's directive.
   * @param agent - the mentor agent whose session receives the directive.
   * @returns the message to inject, or undefined when nothing is owed.
   */
  directiveMessage(agent: Agent): UserMessage | undefined {
    const read = this.read(agent)
    if (read.position.action !== 'deliver' || read.directive === undefined || read.pipeline === undefined) {
      return undefined
    }
    return createUserMessage({
      content: [{ type: 'text', text: renderMentorDirective(read.directive, this.resolved.maxDirectiveChars) }],
      source: {
        kind: 'mentor-loop',
        digest: read.directive.digest,
        misconceptionId: String(read.pipeline.misconceptionId),
        stage: read.directive.stage,
      },
    })
  }

  /**
   * Run one step for the pre-step listener and return the directive owed. A
   * failure here is contained and logged: a mentor-side fault never fails the
   * learner's turn.
   */
  private async nudge(agent: Agent): Promise<UserMessage | undefined> {
    try {
      const position = await this.step(agent)
      if (position.action !== 'deliver') return undefined
      return this.directiveMessage(agent)
    } catch (error) {
      this.ctx.logger.warn(`mentor loop: the loop step failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Read every seam this one derivation needs. */
  private read(agent: Agent): LoopRead {
    const session = agent.session
    const observation = observe(session.deriveMessages())
    const view = this.ctx.get('agentKernel')?.state.view(session)
    const learner = this.ctx.learnerModel.read(this.resolved.learnerId)
    const pipelines = this.ctx.misconception.pipelines(this.resolved.learnerId)
    const pattern = observation.analysis === undefined
      ? undefined
      : this.ctx.misconception.match(observation.analysis)
    // The newest directive this session delivered names the occurrence it
    // teaches, so a mid-cycle reply that does not restate the thesis still
    // resolves to that occurrence rather than to no occurrence at all.
    const delivered = observation.delivered?.misconceptionId
    const pipeline = (delivered === undefined
      ? undefined
      : pipelines.find(candidate => String(candidate.misconceptionId) === delivered))
      ?? (pattern === undefined ? undefined : pipelines.find(candidate => candidate.patternId === pattern.id))
    const caseId = this.pickCase(learner.caseHistory.map(entry => entry.caseId), pipeline)
    const directive = pipeline === undefined || (pipeline.stage === 'new-case' && caseId === undefined)
      ? undefined
      : this.ctx.misconception.directive(this.resolved.learnerId, pipeline.misconceptionId, caseId)
    const cited = (view?.claims ?? []).flatMap(claim => claim.evidence).map(String)
    const recorded = (view?.evidence ?? []).map(item => String(item.evidenceId))
    const inputs: MentorLoopInputs = {
      ...(observation.analysis === undefined ? {} : { analysis: observation.analysis }),
      matched: pattern !== undefined,
      claimed: (view?.claims ?? []).length > 0,
      citedEvidence: cited,
      recordedEvidence: recorded,
      ...(pipeline === undefined ? {} : {
        pipeline: {
          stage: pipeline.stage,
          ...(pipeline.waitingFor === undefined ? {} : { waitingFor: pipeline.waitingFor }),
          misconception: pipeline.misconception,
        },
      }),
      directiveDelivered: directive !== undefined && observation.delivered?.digest === directive.digest,
      learnerSpokeAfterDirective: observation.learnerSpokeAfterDirective,
      caseAvailable: caseId !== undefined,
    }
    return {
      position: deriveMentorPosition(inputs),
      observation,
      ...(pipeline === undefined ? {} : { pipeline }),
      ...(directive === undefined ? {} : { directive }),
      counterEvidence: contradictingEvidence(recorded, cited).map(id => brandString<EvidenceId>(id)),
      ...(caseId === undefined ? {} : { caseId }),
    }
  }

  /** The fact the session now shows for the pipeline's current stage. */
  private factFor(read: LoopRead): MisconceptionFact {
    const analysis = read.observation.analysis ?? ''
    switch (read.pipeline?.stage) {
      case 'explain':
      case 'counterexample':
        return { kind: 'delivered' }
      case 'exercise':
        return { kind: 'attempted', attempt: analysis }
      case 'new-case':
        if (read.caseId === undefined) {
          throw new Error('mentor loop: the new-case stage advanced without a case the learner has not used')
        }
        return { kind: 'case-selected', caseId: read.caseId }
      case 'reassess':
        return {
          kind: 'reassessed',
          outcome: this.ctx.misconception.match(analysis) === undefined ? 'resolved' : 'repeated',
        }
      default:
        throw new Error('mentor loop: the pipeline holds no stage the loop can advance')
    }
  }

  /** Record the learner's repeated mistake, which the learner record counts. */
  private async recordMistake(pipeline: MisconceptionPipeline): Promise<void> {
    await this.ctx.learnerModel.recordMistake(this.resolved.learnerId, {
      mistakeId: `${pipeline.misconceptionId}:mistake`,
      statement: pipeline.misconception,
      conceptIds: [ConceptId(pipeline.patternId)],
      ...(pipeline.caseId === undefined ? {} : { caseId: pipeline.caseId }),
      trust: 'trusted',
    })
  }

  /** The newest case the learner has worked that this cycle has not used. */
  private pickCase(cases: readonly CaseReference[], pipeline: MisconceptionPipeline | undefined): CaseReference | undefined {
    for (let index = cases.length - 1; index >= 0; index -= 1) {
      const candidate = cases[index]
      if (candidate !== undefined && candidate !== pipeline?.caseId) return candidate
    }
    return undefined
  }

  /** Announce the position when it differs from the last one announced for that session. */
  private announce(agent: Agent, position: MentorLoopPosition): void {
    const signature = `${position.stage}\n${position.action}\n${position.waitingFor ?? ''}\n${position.misconceptionId ?? ''}`
    const session = String(agent.session.id)
    if (this.announced.get(session) === signature) return
    this.announced.set(session, signature)
    this.ctx.emit('mentor/loop-position', { learnerId: this.resolved.learnerId, ...position })
  }
}

export default MentorLoop

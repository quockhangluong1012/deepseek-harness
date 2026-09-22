/**
 * Measured improvement scoring (`ctx.evolutionScorer`): run one recorded
 * scenario N times in fresh processes and report the metric triple — pass from
 * the workspace diff, billed tokens from the host token meter, and median
 * wall-clock time.
 *
 * Scoring reads fixtures already on disk. It always runs the recorded-session
 * replay tier from the snapshot harness, so it needs no API key and never
 * records: a scenario the corpus does not describe, or one whose recorded
 * fixture is absent, is reported as a skip. The pure scorer is exported
 * separately so specs drive the arithmetic without spawning anything.
 * @module @deepseek-ai/dsh-evolution-scorer
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { captureExpectedWorkspaceSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import type { RunOptions } from '@deepseek-ai/dsh-session-snapshot'
import type {} from '@deepseek-ai/dsh-evolution-evaluator-health'
import type {} from '@deepseek-ai/dsh-evolution-uncertainty'
import { measureRunTokens } from './sessions.ts'
import { loadScenarioPlan } from './scenario.ts'
import { scoreRun } from './score.ts'
import { checkBehaviorContract, checkBehaviorRouting, compareBehaviorReplay } from './behavior.ts'
import { evaluatorDisagreement } from './disagreement.ts'
import type {
  BehaviorEvalRequest,
  BehaviorEvaluation,
  EvaluateSkillRequest,
  ScoreAttempt,
  ScoreOutcome,
  ScoreRecord,
  ScoreRequest,
  SkillEvaluation,
} from './types.ts'

export type {
  BehaviorCatalogSkill,
  BehaviorContractGate,
  BehaviorEvalRequest,
  BehaviorEvaluation,
  BehaviorReplayGate,
  BehaviorRevision,
  BehaviorRoutingCheck,
  BehaviorRoutingGate,
  ChannelVerdict,
  DisagreementChannel,
  EvaluateSkillRequest,
  EvaluatorDisagreement,
  ScoreAttempt,
  ScoreInput,
  ScoreOutcome,
  ScoreRecord,
  ScoreRequest,
  ScenarioPlan,
  ScenarioPlanResult,
  ScenarioRunner,
  SkillEvaluation,
  SkillScore,
  TriggerThresholds,
  WorkspaceChange,
} from './types.ts'
export { processScenarioRunner } from './runner.ts'
export { loadScenarioPlan } from './scenario.ts'
export { scoreRun } from './score.ts'
export { measureRunTokens } from './sessions.ts'
export { medianOf } from './statistics.ts'
export { diffWorkspace } from './workspace.ts'
export { shouldOptimize } from './trigger.ts'
export { checkBehaviorContract, checkBehaviorRouting, compareBehaviorReplay } from './behavior.ts'
export { evaluatorDisagreement } from './disagreement.ts'

/**
 * Scoring-semantics version the optimizer stamps on every experiment row. Bump
 * when scoring changes what a triple means; rows stamped with an older version
 * were not measured under the same evaluator, so the ledger treats them as
 * incomparable rather than as history.
 */
export const SCORER_VERSION = 1

/**
 * Corpus location and attempt count are deployment choices: which corpus a
 * host scores against, and how many fresh processes the median covers.
 */
export interface Config {
  /** Absolute corpus root holding one directory per recorded scenario. */
  corpusDir: string
  /** Fresh-process attempts per score; the median is taken over their samples. */
  attempts?: number
  /** Recorded loads required before a failure rate triggers optimization. */
  triggerMinUses?: number
  /** Failure share a skill must exceed to trigger optimization, in 0..1. */
  triggerFailureRate?: number
}

/** Corpus location a host must name; there is no useful repository-independent default. */
const corpusDirField = z.string().required()

/** Attempts per score: three keeps one cold start from moving the median. */
const attemptsField = z.number().step(1).min(1).default(3)

/** Validated deployment choices; `corpusDir` is required. */
export const Config: z<Config> = z.object({
  corpusDir: corpusDirField,
  attempts: attemptsField,
  triggerMinUses: z.number().step(1).min(1).default(20),
  triggerFailureRate: z.number().min(0).max(1).default(0.3),
})

/** Normalized configuration used by the scorer. */
export interface ResolvedConfig {
  corpusDir: string
  attempts: number
  triggerMinUses: number
  triggerFailureRate: number
}

/**
 * Resolve defaults for the optional attempt count.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { corpusDir, attempts = 3, triggerMinUses = 20, triggerFailureRate = 0.3 } = config
  return { corpusDir, attempts, triggerMinUses, triggerFailureRate }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Measured improvement scorer. */
    evolutionScorer: EvolutionScorer
  }
}

/**
 * Recorded-session scorer. One score runs the scenario in `attempts` fresh
 * processes, measures each attempt's harvested sessions through
 * `ctx.tokenMeter`, and reduces the attempts to the metric triple. Nothing is
 * written: the runner's replay fixtures and the expected workspace are read-only
 * inputs.
 */
export class EvolutionScorer extends Service {
  static inject = ['tokenMeter']

  /**
   * Scoring-semantics version this instance measures under. The optimizer reads
   * it per run, so a mounted scorer that measures differently stamps its own
   * version instead of inheriting this package's.
   */
  readonly version: number = SCORER_VERSION

  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the token meter.
   * @param config - corpus root and attempt count.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'evolutionScorer')
    this.resolved = resolveConfig(config)
  }

  /**
   * Score one scenario against its recorded fixtures.
   *
   * Every attempt boots a fresh process through the caller's runner in the
   * keyless replay tier, and is scored against `workspace.expected/` when the
   * scenario ships one, or against its own initial workspace otherwise.
   * @param request - scenario name plus the agent composition and runner to boot it with.
   * @returns the metric triple, or the reason the scenario could not be scored.
   * @throws when the configured corpus does not exist, a shipped fixture cannot be parsed,
   * or the runner fails; only an unknown scenario and an absent fixture are skips.
   */
  async score(request: ScoreRequest): Promise<ScoreOutcome> {
    const planned = await loadScenarioPlan(this.resolved.corpusDir, request.scenario)
    if (planned.status === 'skipped') return { status: 'skipped', scenario: request.scenario, reason: planned.reason }
    const { plan } = planned
    const expected = plan.expectedWorkspaceDir === undefined
      ? undefined
      : await captureExpectedWorkspaceSnapshot(plan.expectedWorkspaceDir)
    const attempts: ScoreAttempt[] = []
    for (let index = 0; index < this.resolved.attempts; index += 1) {
      const options: RunOptions = {
        agent: request.agent,
        mode: 'replay',
        fixtureFile: plan.fixtureFile,
        ...plan.overrideFile === undefined ? {} : { overrideFile: plan.overrideFile },
        ...plan.childFiles.length === 0 ? {} : { childFiles: [...plan.childFiles] },
        ...plan.workspaceDir === undefined ? {} : { workspaceDir: plan.workspaceDir },
      }
      const startedAt = Date.now()
      const result = await request.run(plan.script, options)
      attempts.push({
        initial: result.initialWorkspace,
        final: result.finalWorkspace,
        tokens: measureRunTokens(this.ctx.tokenMeter, result.sessionLogs),
        wallTimeMs: Date.now() - startedAt,
      })
    }
    return {
      status: 'scored',
      score: scoreRun({
        scenario: plan.scenario,
        ...expected === undefined ? {} : { expected },
        attempts,
      }),
    }
  }

  /**
   * Evaluate one skill over its corpus scenarios and aggregate the metric
   * triple an optimizer selects on. Every scenario must score: a skipped
   * scenario means the corpus does not describe what the skill was asked to
   * prove, and optimizing on a partial evaluation would select on evidence
   * that is not there — so one skip skips the whole evaluation with its
   * reason attached.
   * @param request - skill name plus the scenarios, agent composition, and runner to score it with.
   * @returns the aggregated triple with per-scenario records, or the reason the skill could not be evaluated.
   */
  async evaluateSkill(request: EvaluateSkillRequest): Promise<SkillEvaluation> {
    if (request.scenarios.length === 0) {
      return { status: 'skipped', skill: request.skill, reason: `skill '${request.skill}' names no evaluation scenarios` }
    }
    const scores: ScoreRecord[] = []
    for (const scenario of request.scenarios) {
      const outcome = await this.score({ scenario, agent: request.agent, run: request.run })
      if (outcome.status === 'skipped') {
        return { status: 'skipped', skill: request.skill, reason: outcome.reason }
      }
      scores.push(outcome.score)
    }
    return {
      status: 'evaluated',
      score: {
        skill: request.skill,
        pass: scores.every(record => record.pass),
        tokens: scores.reduce((sum, record) => sum + record.tokens, 0),
        wallTimeMs: scores.reduce((sum, record) => sum + record.wallTimeMs, 0),
        scores,
      },
    }
  }

  /**
   * Evaluate one skill revision through the three behavior gates: the
   * frontmatter contract check, positive/negative trigger-query routing
   * through the real selector, and a baseline-vs-candidate replay over the
   * same scenarios. The cheap gates run first, so a candidate that cannot be
   * committed or routes where it must not never spends fresh processes; only
   * replay evidence approves. A skipped replay composition skips the whole
   * evaluation with its reason attached.
    * @param request - baseline and candidate replay compositions, the candidate
    * body, the routing catalog and queries, and the routing window.
    * @returns the gate verdicts with channel disagreement and approval, the gating reason, or the skip.
   */
  async evaluateBehavior(request: BehaviorEvalRequest): Promise<BehaviorEvaluation> {
    const skill = request.candidate.skill
    const contract = checkBehaviorContract(request.candidateBody.name, request.candidateBody.body)
    const routing = checkBehaviorRouting(
      request.candidateBody.name,
      request.catalog,
      request.positiveQueries,
      request.negativeQueries,
      request.routingTopK ?? 3,
      request.vectors,
    )
    if (!contract.ok || !routing.ok) {
      const behavior: BehaviorEvaluation = {
        status: 'gated',
        skill,
        contract,
        routing,
        disagreement: evaluatorDisagreement([
          { channel: 'contract', ok: contract.ok },
          { channel: 'routing', ok: routing.ok },
        ]),
        reason: !contract.ok ? `contract gate failed: ${contract.issues.join('; ')}` : 'routing gate failed',
      }
      await this.recordHealth(behavior)
      await this.recordUncertainty(behavior)
      return behavior
    }
    const baseline = await this.evaluateSkill(request.baseline)
    if (baseline.status === 'skipped') return { status: 'skipped', skill, reason: baseline.reason }
    const candidate = await this.evaluateSkill(request.candidate)
    if (candidate.status === 'skipped') return { status: 'skipped', skill, reason: candidate.reason }
    const replay = compareBehaviorReplay(baseline.score, candidate.score)
    const behavior: BehaviorEvaluation = {
      status: 'evaluated',
      skill,
      contract,
      routing,
      replay,
      disagreement: evaluatorDisagreement([
        { channel: 'contract', ok: contract.ok },
        { channel: 'routing', ok: routing.ok },
        { channel: 'replay', ok: replay.ok },
      ]),
      approved: replay.ok,
    }
    await this.recordHealth(behavior)
    await this.recordUncertainty(behavior)
    return behavior
  }

  /**
   * Record one judging verdict into the evaluator-health store when it is
   * mounted. A failing record must not fail the evaluation, so it logs a
   * warning instead.
   * @param behavior - the verdict just computed.
   */
  private async recordHealth(behavior: Extract<BehaviorEvaluation, { status: 'gated' | 'evaluated' }>): Promise<void> {
    const health = this.ctx.get('evolutionEvaluatorHealth')
    if (health === undefined) return
    try {
      await health.observe({
        skill: behavior.skill,
        unanimous: behavior.disagreement.unanimous,
        status: behavior.status,
        approved: behavior.status === 'evaluated' ? behavior.approved : false,
        approving: [...behavior.disagreement.approving],
        dissenting: [...behavior.disagreement.dissenting],
      })
    } catch (error) {
      this.ctx.logger.warn(`evolution scorer could not record evaluator health: ${String(error)}`)
    }
  }

  /**
   * Record one disagreement signal into the uncertainty store when mounted:
   * a split verdict is evidence the evaluation deserves another look (§44).
   * Unanimous verdicts and skipped evaluations produce no signal. A failing
   * record must not fail the evaluation, so it logs a warning instead.
   * @param behavior - the verdict just computed.
   */
  private async recordUncertainty(behavior: Extract<BehaviorEvaluation, { status: 'gated' | 'evaluated' }>): Promise<void> {
    if (behavior.disagreement.unanimous) return
    const uncertainty = this.ctx.get('evolutionUncertainty')
    if (uncertainty === undefined) return
    const total = behavior.disagreement.approving.length + behavior.disagreement.dissenting.length
    try {
      await uncertainty.record({
        signalId: randomUUID(),
        skill: behavior.skill,
        taskId: null,
        kind: 'disagreement',
        score: total === 0 ? 0 : behavior.disagreement.dissenting.length / total,
        detail: `evaluators disagree on '${behavior.skill}': ${behavior.disagreement.dissenting.join(', ')} dissenting`,
      })
    } catch (error) {
      this.ctx.logger.warn(`evolution scorer could not record uncertainty signal: ${String(error)}`)
    }
  }
}

export default EvolutionScorer

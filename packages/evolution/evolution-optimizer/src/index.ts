/**
 * Offline skill optimizer (`ctx.evolutionOptimizer`): gate one skill on its
 * recorded failure rate, mutate its SKILL.md body through the host LLM,
 * re-score baseline and variants under isolated DSH_HOME overlays, keep the
 * Pareto winner that beats the baseline, and stage it as a skill patch a
 * human approves. Nothing writes a skill directly: the staged entry waits in
 * the scope until `/skills approve` drops it after the human's own write.
 * @module @deepseek-ai/dsh-evolution-optimizer
 */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { processScenarioRunner, shouldOptimize } from '@deepseek-ai/dsh-evolution-scorer'
import type { SkillScore } from '@deepseek-ai/dsh-evolution-scorer'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-snapshot'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-skill'
import type { AgentUnderTest } from '@deepseek-ai/dsh-session-snapshot'
import { distributeCandidates, frameMutationInput, mutateOnce, resolveOperators } from './mutate.ts'
import { dominates, pickWinner, screenSurvivors } from './pareto.ts'
import { scoreVariant } from './evaluate.ts'
import {
  describeOutcome,
  experimentKey,
  experimentPage,
  hasResult,
  optimizerDomainSpec,
  repeatedExperiment,
  staleExperiments,
} from './experiments.ts'
import { noveltyOf } from './novelty.ts'
import { failureSignature, operatorRecords, orderPortfolio } from './surface.ts'
import { contaminatedHoldout } from './contamination.ts'
import { diffLineCounts } from './lineage.ts'
import type { MutationOperator } from './mutate.ts'
import type {
  EvaluatedVariant,
  RegressionFloor,
  ExperimentDraft,
  ExperimentRecord,
  ExperimentsQuery,
  HoldoutCheck,
  OptimizeReport,
  OptimizeRequest,
  PromotionConfidence,
} from './types.ts'

export {
  describeOutcome,
  experimentKey,
  experimentPage,
  hasResult,
  optimizerDomainSpec,
  repeatedExperiment,
  staleExperiments,
} from './experiments.ts'
export { noveltyOf } from './novelty.ts'
export { failureSignature, operatorRecords, orderPortfolio } from './surface.ts'
export { contaminatedHoldout } from './contamination.ts'
export { diffLineCounts } from './lineage.ts'
export type { LineChangeCounts } from './lineage.ts'
export type { OperatorRecord } from './surface.ts'
export type {
  EvaluatedVariant,
  ExperimentDraft,
  ExperimentRecord,
  ExperimentTriple,
  ExperimentsQuery,
  HoldoutCheck,
  OptimizeReport,
  OptimizeRequest,
  PromotionConfidence,
} from './types.ts'
export { dominates, paretoFrontier, pickWinner, screenSurvivors } from './pareto.ts'
export {
  distributeCandidates,
  frameMutationInput,
  MUTATION_OPERATORS,
  mutationInstructions,
  parseMutationResponse,
  resolveOperators,
} from './mutate.ts'
export type { MutationOperator } from './mutate.ts'

/**
 * Mutation breadth, framing budgets, the LLM route, the trigger copy, and the
 * default agent composition are deployment choices changeable from cordis.yml.
 */
export interface Config {
  /** Mutation candidates per run. */
  maxCandidates?: number
  /** Byte budget for one framed mutation request. */
  maxInputBytes?: number
  /** Output-token cap for one mutation request. */
  maxOutputTokens?: number
  /** Provider route for the mutation request; required to optimize. */
  provider?: string
  /** Model id for the mutation request; required to optimize. */
  model?: string
  /** Recorded loads required before a failure rate counts. */
  triggerMinUses?: number
  /** Failure share a record must exceed, in 0..1. */
  triggerFailureRate?: number
  /**
   * Corpus scenarios reserved for the promotion check. They are never scored
   * during search, and a winner the baseline dominates on them is refused.
   */
  holdoutScenarios?: string[]
  /** Billed tokens one run may spend on candidate scoring; 0 leaves it unbounded. */
  budgetTokens?: number
  /** Wall time in milliseconds one run may spend on candidate scoring; 0 leaves it unbounded. */
  budgetWallTimeMs?: number
  /**
   * Scenarios every candidate is screened on before the survivors are scored
   * in full; 0 disables screening.
   */
  screenScenarioCount?: number
  /**
   * Mutation operators the run draws its candidates from, in request order.
   * The candidate budget is split evenly across them.
   */
  operators?: string[]
  /**
   * Paired winner-versus-baseline comparisons a promotion must win; 1 keeps
   * the single comparison the search already made.
   */
  confirmationRuns?: number
  /**
   * Refuse a run whose exact hypothesis — same skill, evidence, scenarios,
   * operators, starting body, and route — already has a recorded outcome;
   * false re-runs it and pays for the same search again.
   */
  skipRepeatedExperiments?: boolean
  /**
   * Evaluated runs without a promotion that make a skill stagnant, at which
   * point a run draws its candidates from the operators those runs had not
   * used. 1 switches on the first failed run.
   */
  stagnationWindow?: number
  /**
   * Candidate-producing runs an operator needs under one failure signature
   * before its record orders the lineup: below it the operator is treated as
   * never seen there.
   */
  priorMinTries?: number
  /** Experiments one scope keeps, newest first; older rows are dropped as new ones land. */
  maxExperiments?: number
  /** Experiments one read returns, newest first. */
  experimentPageSize?: number
  /** Agent composition variant attempts boot with unless the request names one. */
  agent: {
    /** Source bin entry variant attempts boot. */
    binScript: string
    /**
     * Base config or profile patch the entry loads. A named profile layers it
     * over that profile; without one the entry boots the file alone, which only
     * a bin with its own config grammar accepts.
     */
    configPath: string
    /**
     * Named dsh profile every attempt boots. Set it whenever `binScript` is the
     * real `dsh` entry: the app boots profiles, not bare config files.
     */
    profile?: string
    /** Repo tsconfig resolving unbuilt workspace imports. */
    tsconfigPath: string
  }
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  maxCandidates: z.number().step(1).min(1).default(3),
  maxInputBytes: z.number().step(1).min(1).default(16384),
  maxOutputTokens: z.number().step(1).min(1).default(2048),
  provider: z.string(),
  model: z.string(),
  triggerMinUses: z.number().step(1).min(1).default(20),
  triggerFailureRate: z.number().min(0).max(1).default(0.3),
  holdoutScenarios: z.array(z.string()).default([]),
  budgetTokens: z.number().step(1).min(0).default(0),
  budgetWallTimeMs: z.number().step(1).min(0).default(0),
  screenScenarioCount: z.number().step(1).min(0).default(0),
  operators: z.array(z.string()).default(['rewrite']),
  confirmationRuns: z.number().step(1).min(1).default(1),
  skipRepeatedExperiments: z.boolean().default(true),
  stagnationWindow: z.number().step(1).min(1).default(5),
  priorMinTries: z.number().step(1).min(1).default(3),
  maxExperiments: z.number().step(1).min(1).default(200),
  experimentPageSize: z.number().step(1).min(1).default(20),
  agent: z.object({
    /** Source bin entry variant attempts boot. */
    binScript: z.string().required(),
    /** Base config or profile patch the entry loads. */
    configPath: z.string().required(),
    /** Named dsh profile every attempt boots; absent only for a fake bin. */
    profile: z.string(),
    /** Repo tsconfig resolving unbuilt workspace imports. */
    tsconfigPath: z.string().required(),
  }),
})

/** Normalized configuration used by the optimizer. */
export interface ResolvedConfig {
  maxCandidates: number
  maxInputBytes: number
  maxOutputTokens: number
  provider: string | undefined
  model: string | undefined
  triggerMinUses: number
  triggerFailureRate: number
  holdoutScenarios: readonly string[]
  budgetTokens: number
  budgetWallTimeMs: number
  screenScenarioCount: number
  operators: readonly MutationOperator[]
  confirmationRuns: number
  skipRepeatedExperiments: boolean
  stagnationWindow: number
  priorMinTries: number
  maxExperiments: number
  experimentPageSize: number
  agent: AgentUnderTest
}

/**
 * Resolve defaults for the optional mutation budgets, route, and trigger copy.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    maxCandidates = 3,
    maxInputBytes = 16384,
    maxOutputTokens = 2048,
    provider,
    model,
    triggerMinUses = 20,
    triggerFailureRate = 0.3,
    holdoutScenarios = [],
    budgetTokens = 0,
    budgetWallTimeMs = 0,
    screenScenarioCount = 0,
    operators = ['rewrite'],
    confirmationRuns = 1,
    skipRepeatedExperiments = true,
    stagnationWindow = 5,
    priorMinTries = 3,
    maxExperiments = 200,
    experimentPageSize = 20,
    agent,
  } = config
  return {
    maxCandidates,
    maxInputBytes,
    maxOutputTokens,
    provider,
    model,
    triggerMinUses,
    triggerFailureRate,
    holdoutScenarios,
    budgetTokens,
    budgetWallTimeMs,
    screenScenarioCount,
    operators: resolveOperators(operators),
    confirmationRuns,
    skipRepeatedExperiments,
    stagnationWindow,
    priorMinTries,
    maxExperiments,
    experimentPageSize,
    agent,
  }
}

/**
 * Offline skill optimizer. One run gates on the recorded failure rate,
 * mutates, screens and re-scores the variants under the same overlay harness,
 * checks the private holdout scenarios, and stages the Pareto winner. Every
 * dependency resolves at call time and fails loud: optimizing without a
 * scorer, telemetry, memory, skill catalog, or LLM route is a configuration
 * error, not a skip.
 */
export class EvolutionOptimizer extends Service {
  static inject = ['storageDomain']

  private readonly resolved: ResolvedConfig
  private table?: KvTable<string, ExperimentRecord>

  /**
   * @param ctx - host context carrying the optimizer's seams.
   * @param config - mutation budgets, route, trigger copy, governance, and agent composition.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'evolutionOptimizer')
    this.resolved = resolveConfig(config)
  }

  /**
   * Open the experiment domain every run records into.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(optimizerDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-optimizer.domainClose')
    this.table = domain.table('records')
  }

  /**
   * Optimize one skill and record the run: trigger-gate, mutate, screen,
   * score, check the holdout, confirm the winner, pick, stage.
   * @returns the run report; `staged` carries the staged entry id.
   * @throws when the scenario lists overlap or repeat, a holdout scenario was
   * already used for search for the skill, a required seam
   * (scorer, telemetry, memory, skills, llm) is missing, or the
   * provider/model route is missing.
   */
  async optimize(request: OptimizeRequest): Promise<OptimizeReport> {
    const outcome = await this.execute(request)
    if (outcome.draft !== undefined) {
      await this.record(request, outcome.report, outcome.draft)
    }
    return outcome.report
  }

  /**
   * Read one scope's recorded experiments, newest first.
   * @param scopeId - scope identity the runs staged into.
   * @param query - optional skill filter and page size.
   * @returns detached records, newest first.
   */
  experiments(scopeId: EvolutionScopeId, query: ExperimentsQuery = {}): readonly ExperimentRecord[] {
    const rows = [...this.requireTable().entries()].map(([, row]) => row)
    return experimentPage(rows, String(scopeId), query, this.resolved.experimentPageSize)
      .map(row => structuredClone(row))
  }

  /**
   * Append one run to the ledger and drop the scope's stale rows.
   * @param request - the run's staging identity.
   * @param report - what the run decided.
   * @param draft - what the run measured.
   */
  private async record(request: OptimizeRequest, report: OptimizeReport, draft: ExperimentDraft): Promise<void> {
    const triple = (score: { pass: boolean; tokens: number; wallTimeMs: number } | null) =>
      score === null ? null : { pass: score.pass, tokens: score.tokens, wallTimeMs: score.wallTimeMs }
    const row: ExperimentRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      scope: String(request.scopeId),
      skill: request.skill,
      evidence: draft.evidence,
      operators: [...draft.operators],
      portfolio: [...draft.portfolio],
      novelOperators: [...draft.novelOperators],
      scenarios: [...draft.scenarios],
      holdout: [...this.resolved.holdoutScenarios],
      baseline: triple(report.baseline),
      winner: draft.winner === null ? null : triple(draft.winner.score),
      confidence: report.confidence,
      samples: draft.samples,
      outcome: report.status,
      reason: report.reason,
      stagedId: report.stagedId,
      provider: draft.provider,
      model: draft.model,
      bodySha: digestOf(draft.body),
      scorerVersion: draft.scorerVersion,
      ...diffLineCounts(draft.body, draft.winner?.body ?? draft.body),
      winnerSha: draft.winner === null ? null : digestOf(draft.winner.body),
      winnerOperator: draft.winner?.operator ?? null,
    }
    try {
      const table = this.requireTable()
      await table.put(row.id, row)
      const rows = [...table.entries()].map(([, value]) => value).filter(entry => entry.scope === row.scope)
      for (const stale of staleExperiments(rows, this.resolved.maxExperiments)) {
        await table.delete(stale.id)
      }
    } catch (error) {
      // The run's own outcome is already decided; a ledger write that fails is
      // reported, not allowed to fail a promotion it did not make.
      this.ctx.logger.warn(`evolution optimizer could not record experiment for '${request.skill}': ${String(error)}`)
    }
  }

  /**
   * Choose the mutation lineup for one run, in the order this run draws from it.
   *
   * Stagnation first: a skill whose recent evaluated runs promoted nothing
   * repeats a search that already failed, so the lineup narrows to the
   * operators those runs did not produce a candidate with. When every
   * configured operator has already produced one, diversity is exhausted and
   * the configured lineup stands.
   *
   * Then the failure surface: the ledger's record of this failure — the
   * evidence's shape, its magnitudes folded away — orders that lineup so the
   * operators that have won this failure come first and the ones that only ever
   * lost there come last, with operators this failure has never seen in
   * between. The order decides who takes the remainder of the candidate budget.
   * @param request - the run's scope and skill.
   * @param evidence - the failure evidence the mutation addresses.
   * @returns whether the skill stagnates, and the operators to draw from.
   */
  private mutationStrategy(
    request: OptimizeRequest,
    evidence: string,
  ): { stagnant: boolean; portfolio: readonly MutationOperator[] } {
    const rows = this.experiments(request.scopeId, {
      skill: request.skill,
      limit: Math.max(this.resolved.stagnationWindow, this.resolved.maxExperiments),
    })
    const evaluated = rows.filter(hasResult)
    const window = evaluated.slice(0, this.resolved.stagnationWindow)
    const stagnant = window.length >= this.resolved.stagnationWindow
      && !window.some(row => row.outcome === 'staged')
    const tried = new Set(window.flatMap(row => row.operators))
    const unused = this.resolved.operators.filter(operator => !tried.has(operator.id))
    const chosen = stagnant && unused.length > 0 ? unused : this.resolved.operators
    return {
      stagnant,
      portfolio: orderPortfolio(chosen, operatorRecords(rows, failureSignature(evidence)), this.resolved.priorMinTries),
    }
  }

  /**
   * The strongest approved promotion a new winner must not be worse than:
   * recorded winners whose staged entry a human approved, measured on the same
   * skill, scenarios, route, and attempt count. Any approved triple that
   * dominates this run's winner blocks it, so the guard never depends on
   * picking one "best" result out of incomparable ones.
   * @param scopeId - scope the run stages into.
   * @param skill - skill being optimized.
   * @param signature - comparability key the run measured under.
   * @returns the dominating approved floor, or null when none applies.
   */
  private regressionFloor(scopeId: EvolutionScopeId, skill: string, signature: string): RegressionFloor | null {
    const record = this.ctx.evolutionMemory.read(scopeId)
    if (record === undefined) return null
    const approved = new Set(record.resolutions
      .filter(resolution => resolution.decision === 'approved' && resolution.kind === 'skill')
      .map(resolution => resolution.id))
    if (approved.size === 0) return null
    let floor: RegressionFloor | null = null
    for (const row of this.experiments(scopeId, { skill, limit: this.resolved.maxExperiments })) {
      // A row that promoted nothing — refused, unconfirmed, or a loser — has no result to defend.
      if (row.winner === null || row.stagedId === null) continue
      if (!approved.has(row.stagedId) || comparabilityKey(row) !== signature) continue
      // The newest approved row with this key is the strongest: a later run
      // whose winner was weaker than an approved floor could not have been
      // staged at all, so no older row can dominate the one found first.
      floor ??= { triple: row.winner, stagedId: row.stagedId, at: row.at }
    }
    return floor
  }

  /**
   * Read the open ledger table.
   * @returns the experiments table.
   * @throws when the domain was never opened.
   */
  private requireTable(): KvTable<string, ExperimentRecord> {
    const table = this.table
    if (table === undefined) throw new Error('evolution-optimizer: the experiments domain is not open')
    return table
  }

  /**
   * Run one optimization without recording it.
   * @param request - skill, scenarios, staging identity, and runner overrides.
   * @returns the run report plus what the run must record about itself.
   */
  private async execute(request: OptimizeRequest): Promise<{ report: OptimizeReport; draft?: ExperimentDraft }> {
    const holdout = this.resolved.holdoutScenarios
    const overlap = request.scenarios.filter(scenario => holdout.includes(scenario))
    if (overlap.length > 0) {
      throw new Error(`evolution-optimizer: holdout scenarios are also search scenarios: ${overlap.join(', ')}`)
    }
    if (new Set(request.scenarios).size !== request.scenarios.length || new Set(holdout).size !== holdout.length) {
      throw new Error('evolution-optimizer: a scenario list repeats a name')
    }
    const contaminated = contaminatedHoldout(
      this.experiments(request.scopeId, { skill: request.skill, limit: this.resolved.maxExperiments }),
      holdout,
    )
    if (contaminated.length > 0) {
      throw new Error(`evolution-optimizer: holdout scenarios were already used for search for '${request.skill}': ${contaminated.join(', ')}`)
    }
    let stagnant = false
    const report = (
      status: OptimizeReport['status'],
      fields: {
        baseline?: SkillScore | null
        candidates?: readonly EvaluatedVariant[]
        stagedId?: string | null
        reason?: string | null
        checked?: HoldoutCheck | null
        truncated?: boolean
        confirmed?: PromotionConfidence | null
        below?: RegressionFloor | null
        stagnant?: boolean
      } = {},
    ): OptimizeReport => ({
      skill: request.skill,
      status,
      baseline: fields.baseline ?? null,
      candidates: fields.candidates ?? [],
      stagedId: fields.stagedId ?? null,
      reason: fields.reason ?? null,
      holdout: fields.checked ?? null,
      truncated: fields.truncated ?? false,
      confidence: fields.confirmed ?? null,
      floor: fields.below ?? null,
      stagnant: fields.stagnant ?? stagnant,
    })
    const scorer = this.ctx.get('evolutionScorer')
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    const memory = this.ctx.get('evolutionMemory')
    const skills = this.ctx.get('skills')
    const llm = this.ctx.get('llm')
    if (scorer === undefined || telemetry === undefined || memory === undefined || skills === undefined || llm === undefined) {
      throw new Error('evolution-optimizer: optimize requires the scorer, telemetry, memory, skills, and llm seams')
    }
    const provider = this.resolved.provider
    const model = this.resolved.model
    if (provider === undefined || model === undefined) {
      throw new Error('evolution-optimizer: optimize requires a provider/model route')
    }
    const record = telemetry.entries().find(entry => entry.name === request.skill)
    if (record === undefined) {
      return { report: report('skipped', { reason: `skill '${request.skill}' has no telemetry record` }) }
    }
    const failures = record.usage.failureCount ?? 0
    const loads = record.usage.useCount + failures
    if (!shouldOptimize(record.usage, { minUses: this.resolved.triggerMinUses, failureRate: this.resolved.triggerFailureRate })) {
      return { report: report('skipped', { reason: `skill '${request.skill}' is below the optimization trigger` }) }
    }
    const definition = await skills.get(request.skill)
    const body = definition?.content
    if (body === undefined || body.length === 0) {
      return { report: report('skipped', { reason: `skill '${request.skill}' has no readable SKILL.md body` }) }
    }
    const agent = request.agent ?? this.resolved.agent
    const run = request.run ?? processScenarioRunner
    const evidence = request.evidence ?? `${failures} failures over ${loads} recorded loads`
    const signal = request.signal ?? new AbortController().signal
    const fork = { stream: (options: Parameters<typeof llm.stream>[0]) => llm.stream(options) }
    const strategy = this.mutationStrategy(request, evidence)
    stagnant = strategy.stagnant
    if (this.resolved.skipRepeatedExperiments) {
      const repeated = repeatedExperiment(
        this.experiments(request.scopeId, { skill: request.skill, limit: this.resolved.maxExperiments }),
        experimentKey({
          skill: request.skill,
          evidence,
          scenarios: request.scenarios,
          portfolio: strategy.portfolio.map(operator => operator.id),
          bodySha: digestOf(body),
          provider,
          model,
          scorerVersion: scorer.version,
        }),
      )
      if (repeated !== undefined) {
        return {
          report: report('skipped', {
            reason: `this experiment already ran at ${repeated.at}, and ${describeOutcome(repeated)}`,
          }),
        }
      }
    }
    const mutated: { body: string; operator: string; novelty: number }[] = []
    const seen = new Set<string>([body])
    for (const allocation of distributeCandidates(this.resolved.maxCandidates, strategy.portfolio)) {
      const framed = frameMutationInput(
        request.skill,
        body,
        evidence,
        allocation.count,
        this.resolved.maxInputBytes,
        allocation.operator.instruction,
      )
      const produced = await mutateOnce(
        fork,
        {
          provider,
          model,
          maxOutputTokens: this.resolved.maxOutputTokens,
          input: framed.text,
          signal,
        },
        body,
        allocation.count,
      )
      // Two operators can land on the same body; it is one candidate, first operator wins.
      for (const candidate of produced) {
        if (seen.has(candidate)) continue
        seen.add(candidate)
        // Novelty is a property of the text, measured once here against the
        // body the run started from, so the draft, the screen, and the report
        // all read the same number.
        mutated.push({ body: candidate, operator: allocation.operator.id, novelty: noveltyOf(candidate, body) })
      }
    }
    if (mutated.length === 0) {
      return { report: report('no-improvement', { reason: `mutation produced no usable bodies for '${request.skill}'` }) }
    }
    let samples = 0
    const draft = (winner: EvaluatedVariant | null): ExperimentDraft => ({
      evidence,
      operators: [...new Set(mutated.map(variant => variant.operator))],
      portfolio: strategy.portfolio.map(operator => operator.id),
      novelOperators: [...new Set(mutated
        .filter(variant => variant.novelty > 0)
        .map(variant => variant.operator))],
      scenarios: request.scenarios,
      provider,
      model,
      scorerVersion: scorer.version,
      body,
      winner,
      samples,
    })
    const deps = { scorer, skill: request.skill, scenarios: request.scenarios, agent, run }
    const spent = { tokens: 0, wallTimeMs: 0 }
    const spend = (score: SkillScore): void => {
      spent.tokens += score.tokens
      spent.wallTimeMs += score.wallTimeMs
    }
    const withinBudget = (): boolean =>
      (this.resolved.budgetTokens === 0 || spent.tokens < this.resolved.budgetTokens)
      && (this.resolved.budgetWallTimeMs === 0 || spent.wallTimeMs < this.resolved.budgetWallTimeMs)
    const baseline = await scoreVariant(deps, body)
    if (baseline.status !== 'evaluated') {
      return { report: report('skipped', { reason: baseline.reason }), draft: draft(null) }
    }
    spend(baseline.score)
    samples = samplesOf(baseline.score)
    const screenCount = this.resolved.screenScenarioCount
    let pool: readonly { index: number; body: string; operator: string; novelty: number }[] =
      mutated.map((variant, index) => ({
        index,
        body: variant.body,
        operator: variant.operator,
        novelty: variant.novelty,
      }))
    // The screen runs every candidate on the same short subset, so a shared
    // budget cannot strand half of them on an incomparable scale.
    if (screenCount > 0 && mutated.length > 1 && screenCount < request.scenarios.length) {
      const screened: EvaluatedVariant[] = []
      for (const [index, variant] of mutated.entries()) {
        const scored = await scoreVariant({ ...deps, scenarios: request.scenarios.slice(0, screenCount) }, variant.body)
        if (scored.status !== 'evaluated') {
          return {
            report: report('skipped', { baseline: baseline.score, candidates: screened, reason: scored.reason }),
            draft: draft(null),
          }
        }
        spend(scored.score)
        screened.push({
          index,
          body: variant.body,
          operator: variant.operator,
          novelty: variant.novelty,
          score: scored.score,
        })
      }
      pool = screenSurvivors(screened, Math.max(1, Math.ceil(mutated.length / 2)))
    }
    const candidates: EvaluatedVariant[] = []
    let truncated = false
    for (const survivor of pool) {
      if (!withinBudget()) {
        truncated = true
        break
      }
      const evaluated = await scoreVariant(deps, survivor.body)
      if (evaluated.status !== 'evaluated') {
        return {
          report: report('skipped', { baseline: baseline.score, candidates, truncated, reason: evaluated.reason }),
          draft: draft(null),
        }
      }
      spend(evaluated.score)
      candidates.push({
        index: survivor.index,
        body: survivor.body,
        operator: survivor.operator,
        novelty: survivor.novelty,
        score: evaluated.score,
      })
    }
    if (candidates.length === 0) {
      return {
        report: report('skipped', {
          baseline: baseline.score,
          truncated: true,
          reason: `the scoring budget was spent before any candidate was fully evaluated for '${request.skill}'`,
        }),
        draft: draft(null),
      }
    }
    const winner = pickWinner(baseline.score, candidates)
    if (winner === null) {
      return {
        report: report('no-improvement', {
          baseline: baseline.score,
          candidates,
          truncated,
          reason: `no variant beats the baseline for '${request.skill}'`,
        }),
        draft: draft(null),
      }
    }
    const floor = this.regressionFloor(
      request.scopeId,
      request.skill,
      comparabilityKey({ scenarios: request.scenarios, provider, model, samples, scorerVersion: scorer.version }),
    )
    if (floor !== null && dominates(floor.triple, winner.score)) {
      return {
        report: report('regressed', {
          baseline: baseline.score,
          candidates,
          truncated,
          below: floor,
          reason: `the winner for '${request.skill}' is dominated by the approved result from ${floor.at} (${floor.stagedId}) measured under the same conditions`,
        }),
        draft: draft(winner),
      }
    }
    let checked: HoldoutCheck | null = null
    if (holdout.length > 0) {
      const privateDeps = { ...deps, scenarios: holdout }
      const baselineHoldout = await scoreVariant(privateDeps, body)
      if (baselineHoldout.status !== 'evaluated') {
        return {
          report: report('skipped', { baseline: baseline.score, candidates, reason: baselineHoldout.reason }),
          draft: draft(winner),
        }
      }
      const winnerHoldout = await scoreVariant(privateDeps, winner.body)
      if (winnerHoldout.status !== 'evaluated') {
        return {
          report: report('skipped', { baseline: baseline.score, candidates, reason: winnerHoldout.reason }),
          draft: draft(winner),
        }
      }
      checked = { baseline: baselineHoldout.score, winner: winnerHoldout.score }
      if (dominates(baselineHoldout.score, winnerHoldout.score)) {
        return {
          report: report('holdout-rejected', {
            baseline: baseline.score,
            candidates,
            checked,
            reason: `the winner for '${request.skill}' is dominated by the baseline on the holdout scenarios`,
          }),
          draft: draft(winner),
        }
      }
    }
    // The search comparison already beat the baseline once; a promotion must
    // repeat that result on every further paired comparison the run was asked for.
    const confidence: PromotionConfidence = { runs: this.resolved.confirmationRuns, wins: 1 }
    while (confidence.wins < confidence.runs) {
      if (!withinBudget()) {
        return {
          report: report('skipped', {
            baseline: baseline.score,
            candidates,
            truncated: true,
            reason: `the scoring budget was spent during confirmation for '${request.skill}'`,
          }),
          draft: draft(winner),
        }
      }
      const repeatBaseline = await scoreVariant(deps, body)
      if (repeatBaseline.status !== 'evaluated') {
        return {
          report: report('skipped', { baseline: baseline.score, candidates, reason: repeatBaseline.reason }),
          draft: draft(winner),
        }
      }
      spend(repeatBaseline.score)
      const repeatWinner = await scoreVariant(deps, winner.body)
      if (repeatWinner.status !== 'evaluated') {
        return {
          report: report('skipped', { baseline: baseline.score, candidates, reason: repeatWinner.reason }),
          draft: draft(winner),
        }
      }
      spend(repeatWinner.score)
      if (!dominates(repeatWinner.score, repeatBaseline.score)) {
        return {
          report: report('unconfirmed', {
            baseline: baseline.score,
            candidates,
            checked,
            truncated,
            confirmed: confidence,
            reason: `the winner for '${request.skill}' repeated ${confidence.wins} of ${confidence.runs} paired comparisons`,
          }),
          draft: draft(winner),
        }
      }
      confidence.wins += 1
    }
    const slim = (score: { pass: boolean; tokens: number; wallTimeMs: number }) => ({
      pass: score.pass,
      tokens: score.tokens,
      wallTimeMs: score.wallTimeMs,
    })
    const staged = await memory.stageWrite({
      scopeId: request.scopeId,
      kind: 'skill',
      op: 'patch',
      payload: {
        skill: request.skill,
        body: winner.body,
        operator: winner.operator,
        baseline: slim(baseline.score),
        winner: slim(winner.score),
      },
      originSessionId: request.originSessionId,
      gist: `optimizer patch for '${request.skill}' by ${winner.operator}: pass ${String(winner.score.pass)}, ${winner.score.tokens} tokens`,
    })
    return {
      report: report('staged', {
        baseline: baseline.score,
        candidates,
        stagedId: staged.id,
        checked,
        truncated,
        confirmed: confidence,
      }),
      draft: draft(winner),
    }
  }
}

export default EvolutionOptimizer

/**
 * Attempts per scenario a triple was measured with. A run whose scenarios ran
 * different attempt counts has no single number, so the fewest any scored
 * scenario took is the count a comparison may rely on; a score with no
 * scenario records reports zero.
 * @param score - the aggregated triple.
 * @returns the attempt count two triples must share to be comparable.
 */
function samplesOf(score: SkillScore): number {
  const counts = score.scores.map(record => record.samples.length)
  return counts.length === 0 ? 0 : Math.min(...counts)
}

/**
 * Comparability key for one measured triple: its scenarios, route, attempt
 * count, and scoring-semantics version. Two triples with different keys were
 * not measured under the same conditions, so a regression guard must not
 * compare them.
 * @param measured - scenarios, route, attempt count, and scorer version of one measurement.
 * @returns the key.
 */
function comparabilityKey(measured: {
  scenarios: readonly string[]
  provider: string
  model: string
  samples: number
  scorerVersion: number
}): string {
  return JSON.stringify([[...measured.scenarios].sort(), measured.provider, measured.model, measured.samples, measured.scorerVersion])
}

/**
 * SHA-256 of one skill body, so the ledger identifies the exact text a run
 * scored without storing the body itself.
 * @param text - the body to digest.
 * @returns the lowercase hex digest.
 */
function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

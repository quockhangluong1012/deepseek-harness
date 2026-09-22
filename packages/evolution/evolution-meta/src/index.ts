/**
 * Automated evolution of the evolution engine (`ctx.evolutionMeta`): a durable
 * store of engine runs, each recorded under the engine configuration its
 * choices produced (§9), with the derived per-configuration summaries and the
 * recommendation of which engine configuration to run next on a task class.
 * The optimizer records each staged write's run with the operator portfolio,
 * scorer version, budget identity, and route actually used, and `/meta` reads
 * runs, summaries, and the recommendation. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-meta
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { recommendConfig, summarize } from './meta.ts'
import { metaDomainSpec } from './spec.ts'
import type { ConfigRecommendation, ConfigSummary, EngineConfig, EngineRun, EngineRunInput, MetaTaskClass } from './types.ts'

export type * from './types.ts'
export { configIdOf, ENGINE_COMPONENTS, recommendConfig, scoreOf, summarize, updatedSummary } from './meta.ts'
export { engineConfigRow, engineRunRow, metaDomainSpec } from './spec.ts'

/**
 * Deployment choices of the meta-evolution store; an omitted field takes its
 * default.
 */
export interface Config {
  /** Runs a configuration needs before it may be recommended; default 3. */
  minimumSamples?: number
  /**
   * Engine configuration used when a recorded run names no choice; default the
   * v1 choices of {@link DEFAULT_ENGINE_CONFIG}.
   */
  defaultConfig?: EngineConfig
}

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  /** Runs a configuration needs before it may be recommended. */
  minimumSamples: number
  /** Engine configuration used when a recorded run names no choice. */
  defaultConfig: EngineConfig
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { minimumSamples = 3, defaultConfig = DEFAULT_ENGINE_CONFIG } = config
  return { minimumSamples, defaultConfig: { ...defaultConfig } }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable engine runs with the engine-configuration recommendation. */
    evolutionMeta: EvolutionMeta
  }
}

/** The engine configuration a fresh mount starts with. */
const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  operators: 'portfolio-v1',
  evaluator: 'scorer-v1',
  budget: 'balanced-v1',
  routing: 'evidence-v1',
}

/**
 * Meta-evolution store over durable engine runs. Opens the `evolution_meta`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionMeta extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the recommendation and the default configuration. */
  static Config = z.object({
    minimumSamples: z.number().int().min(0).default(3),
    defaultConfig: z.object({
      operators: z.string().default('portfolio-v1'),
      evaluator: z.string().default('scorer-v1'),
      budget: z.string().default('balanced-v1'),
      routing: z.string().default('evidence-v1'),
    }).default(DEFAULT_ENGINE_CONFIG),
  })

  private readonly resolved: ResolvedConfig

  private runTable?: KvTable<string, EngineRun>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - recommendation and default choices; omitted fields take defaults.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionMeta')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(metaDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-meta.domainClose')
    this.runTable = domain.table('runs')
  }

  /**
   * Record one engine run, completing its configuration with the default
   * choices where the caller named none. The stored instant is now.
   * @param input - the run and its (possibly partial) configuration.
   * @returns the stored run.
   */
  async record(input: EngineRunInput): Promise<EngineRun> {
    const run: EngineRun = {
      runId: input.runId,
      taskClass: input.taskClass,
      config: {
        operators: input.config.operators ?? this.resolved.defaultConfig.operators,
        evaluator: input.config.evaluator ?? this.resolved.defaultConfig.evaluator,
        budget: input.config.budget ?? this.resolved.defaultConfig.budget,
        routing: input.config.routing ?? this.resolved.defaultConfig.routing,
      },
      pass: input.pass,
      tokens: input.tokens,
      wallTimeMs: input.wallTimeMs,
      at: new Date().toISOString(),
    }
    await this.requireRuns().put(run.runId, run)
    return structuredClone(run)
  }

  /**
   * List recorded engine runs, optionally filtered by task class, newest
   * first with run-id ascending tie-break.
   * @param taskClass - optional task-class filter.
   * @returns the runs, detached from the store.
   */
  runs(taskClass?: MetaTaskClass): readonly EngineRun[] {
    const rows = [...this.requireRuns().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => taskClass === undefined || row.taskClass === taskClass)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.runId.localeCompare(right.runId))
    return rows
  }

  /**
   * The derived per-configuration summaries, optionally filtered by task
   * class, grouped by task class and best configuration first.
   * @param taskClass - optional task-class filter.
   * @returns the summaries, detached from the store.
   */
  summaries(taskClass?: MetaTaskClass): readonly ConfigSummary[] {
    const rows = taskClass === undefined
      ? this.runs()
      : this.runs(taskClass)
    return summarize([...rows], this.resolved.minimumSamples)
  }

  /**
   * The engine configuration to run next on one task class: the best-scored
   * configuration with at least `minimumSamples` runs, or undefined while no
   * configuration has that much evidence.
   * @param taskClass - the task class to recommend for.
   * @returns the recommended configuration, or undefined.
   */
  recommend(taskClass: MetaTaskClass): ConfigRecommendation | undefined {
    return recommendConfig([...this.summaries(taskClass)], taskClass, this.resolved.minimumSamples)
  }

  private requireRuns(): KvTable<string, EngineRun> {
    if (this.runTable === undefined) throw new Error('evolution meta store is not started yet')
    return this.runTable
  }
}

export default EvolutionMeta
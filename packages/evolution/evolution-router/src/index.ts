/**
 * Routing self-optimization (`ctx.evolutionRouter`): a durable store of route
 * outcomes measured per task class and role (§28), with the derived
 * effectiveness and the ranked recommendation of which route a task class and
 * role should use. The optimizer records each staged write's evaluation route
 * and outcome through the optional recorder seam, and `/router` reads the
 * outcomes, the effectiveness, and the recommendation. Nothing here calls a
 * model.
 * @module @deepseek-ai/dsh-evolution-router
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-uncertainty'
import z from 'zod'
import { routeDisagreement, routeDisagreements } from './disagreement.ts'
import { rankRoutes, recommendRoute, ROUTING_ROLES, routeKey, updatedEffectiveness } from './router.ts'
import { routerDomainSpec } from './spec.ts'
import type { RouteDisagreement } from './disagreement.ts'
import type { RouteEffectiveness, RouteOutcome, RouteOutcomeInput, RouteRankingEntry, RouterTaskClass, RoutingRole } from './types.ts'

export type * from './types.ts'
export type { RouteDisagreement } from './disagreement.ts'
export { routeDisagreement, routeDisagreements } from './disagreement.ts'
export { rankRoutes, recommendRoute, ROUTING_ROLES, routeKey, scoreOf, updatedEffectiveness } from './router.ts'
export { routeOutcomeRow, routerDomainSpec } from './spec.ts'

/**
 * Validated configuration of the routing self-optimization store; an omitted
 * field takes its default.
 */
export interface Config {
  /** Outcomes a route needs before it may be recommended; defaults to 3. */
  minimumSamples?: number
  /** Outcomes a route needs before the disagreement comparison measures it; defaults to 3. */
  disagreementMinimumRuns?: number
  /** Pass-rate gap at which two routes disagree strongly; defaults to 0.5. */
  disagreementThreshold?: number
}

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  /** Outcomes a route needs before it may be recommended. */
  minimumSamples: number
  /** Outcomes a route needs before the disagreement comparison measures it. */
  disagreementMinimumRuns: number
  /** Pass-rate gap at which two routes disagree strongly. */
  disagreementThreshold: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { minimumSamples = 3, disagreementMinimumRuns = 3, disagreementThreshold = 0.5 } = config
  return { minimumSamples, disagreementMinimumRuns, disagreementThreshold }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable route outcomes with per-task-class route effectiveness. */
    evolutionRouter: EvolutionRouter
  }
}

/**
 * Routing self-optimization store over durable outcomes. Opens the
 * `evolution_router` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionRouter extends Service {
  static inject = ['storageDomain']

  /** Deployment choice of the recommendation's minimum outcomes. */
  static Config = z.object({
    minimumSamples: z.number().int().min(0).default(3),
    disagreementMinimumRuns: z.number().int().min(0).default(3),
    disagreementThreshold: z.number().min(0).max(1).default(0.5),
  })

  private readonly resolved: ResolvedConfig

  private outcomeTable?: KvTable<string, RouteOutcome>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - recommendation minimum-outcome choice.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionRouter')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(routerDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-router.domainClose')
    this.outcomeTable = domain.table('outcomes')
  }

  /**
   * Record one measured outcome of a route serving one role on one task class.
   * The stored instant is now. When the outcome leaves the best-measured routes
   * of its task class and role strongly disagreeing, the §44 disagreement is
   * recorded as an uncertainty signal through the optional store seam — this is
   * the one producer of a `disagreement` signal that starts from route
   * outcomes. A failing record must not fail the observation.
   * @param outcome - the route, role, task class, and measured triple.
   * @returns the stored outcome.
   */
  async observe(outcome: RouteOutcomeInput): Promise<RouteOutcome> {
    const stored: RouteOutcome = {
      ...outcome,
      at: new Date().toISOString(),
    }
    await this.requireOutcomes().put(randomUUID(), stored)
    await this.recordDisagreement(outcome.taskClass, outcome.role)
    return structuredClone(stored)
  }

  /**
   * List measured outcomes, optionally filtered by task class and role,
   * newest first with record-key ascending tie-break.
   * @param taskClass - optional task-class filter.
   * @param role - optional role filter.
   * @returns the outcomes, detached from the store.
   */
  outcomes(taskClass?: RouterTaskClass, role?: RoutingRole): readonly RouteOutcome[] {
    const rows = [...this.requireOutcomes().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row =>
        (taskClass === undefined || row.taskClass === taskClass)
        && (role === undefined || row.role === role))
    rows.sort((left, right) => right.at.localeCompare(left.at))
    return rows
  }

  /**
   * The derived effectiveness of every route, optionally filtered by task
   * class and role, in task-class then role-topology then provider/model
   * order.
   * @param taskClass - optional task-class filter.
   * @param role - optional role filter.
   * @returns the effectiveness rows, detached from the store.
   */
  effectiveness(taskClass?: RouterTaskClass, role?: RoutingRole): readonly RouteEffectiveness[] {
    const grouped = new Map<string, RouteEffectiveness>()
    for (const [, row] of this.requireOutcomes().entries()) {
      if (taskClass !== undefined && row.taskClass !== taskClass) continue
      if (role !== undefined && row.role !== role) continue
      const key = routeKey(row.taskClass, row.role, row.provider, row.model)
      grouped.set(key, updatedEffectiveness(grouped.get(key), row))
    }
    const rows = [...grouped.values()]
    rows.sort((left, right) =>
      left.taskClass.localeCompare(right.taskClass)
      || ROUTING_ROLES.indexOf(left.role) - ROUTING_ROLES.indexOf(right.role)
      || left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model))
    return rows
  }

  /**
   * The route to use for one task class and role: the best-ranked route with
   * at least `minimumSamples` measured outcomes, or undefined while no route
   * has that much evidence.
   * @param taskClass - the task class to recommend for.
   * @param role - the role to recommend for.
   * @returns the recommended route, or undefined.
   */
  recommend(taskClass: RouterTaskClass, role: RoutingRole): RouteRankingEntry | undefined {
    const rows = this.effectiveness(taskClass, role)
    return recommendRoute(rankRoutes(rows, taskClass, role, this.resolved.minimumSamples), this.resolved.minimumSamples)
  }

  /**
   * The §44 route disagreements among the recorded outcomes: per task class and
   * role, the two best-measured routes whose pass rates diverge by more than the
   * configured threshold, strongest gap first.
   * @param taskClass - optional task-class filter.
   * @param role - optional role filter.
   * @returns the disagreements, strongest first.
   */
  disagreements(taskClass?: RouterTaskClass, role?: RoutingRole): readonly RouteDisagreement[] {
    return routeDisagreements(
      this.effectiveness(taskClass, role),
      this.resolved.disagreementMinimumRuns,
      this.resolved.disagreementThreshold,
    )
  }

  /**
   * Record the §44 disagreement of one task class and role as a `disagreement`
   * uncertainty signal when the store is mounted. The signal identity is
   * derived from the task class, role, and the two routes, so re-recording the
   * same disagreement updates one signal instead of piling up copies — a pass
   * that drains it and a later pass that re-records it converge.
   * @param taskClass - the task class to check.
   * @param role - the role to check.
   */
  private async recordDisagreement(taskClass: RouterTaskClass, role: RoutingRole): Promise<void> {
    const uncertainty = this.ctx.get('evolutionUncertainty')
    if (uncertainty === undefined) return
    const disagreement = routeDisagreement(
      this.effectiveness(taskClass, role),
      taskClass,
      role,
      this.resolved.disagreementMinimumRuns,
      this.resolved.disagreementThreshold,
    )
    if (disagreement === undefined) return
    try {
      await uncertainty.record({
        signalId: `route-disagreement:${taskClass}\0${role}\0${disagreement.leader.provider}/${disagreement.leader.model}`
          + `|${disagreement.trailer.provider}/${disagreement.trailer.model}`,
        skill: taskClass,
        taskId: null,
        kind: 'disagreement',
        score: disagreement.gap,
        detail: disagreement.detail,
      })
    } catch (error) {
      this.ctx.logger.warn(`evolution router could not record route disagreement: ${String(error)}`)
    }
  }

  private requireOutcomes(): KvTable<string, RouteOutcome> {
    if (this.outcomeTable === undefined) throw new Error('evolution router store is not started yet')
    return this.outcomeTable
  }
}

export default EvolutionRouter

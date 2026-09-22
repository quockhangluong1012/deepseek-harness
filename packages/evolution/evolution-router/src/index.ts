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
import z from 'zod'
import { rankRoutes, recommendRoute, ROUTING_ROLES, routeKey, updatedEffectiveness, scoreOf } from './router.ts'
import { routerDomainSpec } from './spec.ts'
import type { RouteEffectiveness, RouteOutcome, RouteRankingEntry, RouterTaskClass, RoutingRole } from './types.ts'

export type * from './types.ts'
export { rankRoutes, recommendRoute, ROUTING_ROLES, routeKey, scoreOf, updatedEffectiveness } from './router.ts'
export { routeOutcomeRow, routerDomainSpec } from './spec.ts'

/** Validated configuration of the routing self-optimization store. */
export interface RouterConfig {
  /** Outcomes a route needs before it may be recommended. */
  minimumSamples: number
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
  })

  /** Deployment choice of the routing store. */
  readonly config: RouterConfig

  private outcomeTable?: KvTable<string, RouteOutcome>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated recommendation choices.
   */
  constructor(ctx: Context, config: RouterConfig) {
    super(ctx, 'evolutionRouter')
    this.config = config
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(routerDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-router.domainClose')
    this.outcomeTable = domain.table('outcomes')
  }

  /**
   * Record one measured outcome of a route serving one role on one task class.
   * The stored instant is now.
   * @param outcome - the route, role, task class, and measured triple.
   * @returns the stored outcome.
   */
  async observe(outcome: RouteOutcome): Promise<RouteOutcome> {
    const stored: RouteOutcome = {
      ...outcome,
      at: new Date().toISOString(),
    }
    await this.requireOutcomes().put(randomUUID(), stored)
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
    const roleOrder = Object.fromEntries(ROUTING_ROLES.map((entry, index) => [entry, index]))
    rows.sort((left, right) =>
      left.taskClass.localeCompare(right.taskClass)
      || roleOrder[left.role] - roleOrder[right.role]
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
    return recommendRoute(rankRoutes(rows, taskClass, role, this.config.minimumSamples), this.config.minimumSamples)
  }

  private requireOutcomes(): KvTable<string, RouteOutcome> {
    if (this.outcomeTable === undefined) throw new Error('evolution router store is not started yet')
    return this.outcomeTable
  }
}

export default EvolutionRouter
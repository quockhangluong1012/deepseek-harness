/**
 * Adaptive model routing (`ctx.evolutionModelRoutes`): a durable store of
 * per-role route assignments over the evolutionary role topology (§28) — task
 * execution, reflection, candidate generation, evaluation, and final
 * promotion review each may run on a different model — with measured evidence
 * behind each route. The optimizer records every candidate-generation run's
 * route and outcome through the optional recorder seam, operators pin
 * assignments through /routes, and `recommend` answers which route a role
 * should use: the pinned assignment when one exists, otherwise the route with
 * the strongest recorded evidence. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-model-routes
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { bestRoute, EVOLUTION_ROLES, mergeEvidence, routeKey } from './routes.ts'
import { modelRoutesDomainSpec } from './spec.ts'
import type { EvolutionRole, ModelRoute, RouteEvidence, RouteEvidenceInput, RouteOrigin, RouteRow, RouteSummary } from './types.ts'

export type * from './types.ts'
export { bestRoute, EVOLUTION_ROLES, mergeEvidence, ROUTE_ORIGINS, routeKey } from './routes.ts'
export { modelRoutesDomainSpec, routeEvidenceRow, routeRow } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-role model route assignments with measured evidence. */
    evolutionModelRoutes: EvolutionModelRoutes
  }
}

/** The storage key of one assignment: role and route joined with separators. */
function assignmentKey(role: EvolutionRole, route: ModelRoute): string {
  return `${role}\0${routeKey(route)}`
}

/**
 * Adaptive model-routing store over durable assignments and evidence. Opens
 * the `evolution_model_routes` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionModelRoutes extends Service {
  static inject = ['storageDomain']

  private routesTable?: KvTable<string, RouteRow>
  private evidenceTable?: KvTable<string, RouteEvidence>

  /**
   * @param ctx - host context carrying the storage domain.
   */
  constructor(ctx: Context) {
    super(ctx, 'evolutionModelRoutes')
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(modelRoutesDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-model-routes.domainClose')
    this.routesTable = domain.table('routes')
    this.evidenceTable = domain.table('evidence')
  }

  /**
   * Record one measured outcome of a route used in a role, upserting the route
   * as `observed` unless it is already pinned (a pin outlives its evidence).
   * @param input - the role, route, and measured triple.
   * @returns the stored evidence row.
   */
  async observe(input: RouteEvidenceInput): Promise<RouteEvidence> {
    const now = new Date().toISOString()
    await this.requireRoutes().put(assignmentKey(input.role, input.route), {
      role: input.role,
      provider: input.route.provider,
      model: input.route.model,
      origin: this.currentOrigin(input.role, input.route),
      at: now,
    })
    const evidence: RouteEvidence = {
      id: randomUUID(),
      role: input.role,
      provider: input.route.provider,
      model: input.route.model,
      pass: input.triple.pass,
      tokens: input.triple.tokens,
      wallTimeMs: input.triple.wallTimeMs,
      at: now,
    }
    await this.requireEvidence().put(evidence.id, evidence)
    return structuredClone(evidence)
  }

  /**
   * Pin one route for one role: the operator's explicit assignment outranks
   * every observed route in `recommend`. Pinning an existing route flips its
   * origin; pinning a fresh route creates the row.
   * @param role - the role to assign.
   * @param provider - provider half of the route.
   * @param model - model half of the route.
   * @returns the stored assignment.
   */
  async pin(role: EvolutionRole, provider: string, model: string): Promise<RouteRow> {
    const route: ModelRoute = { provider, model }
    const row: RouteRow = {
      role,
      provider,
      model,
      origin: 'pinned',
      at: new Date().toISOString(),
    }
    await this.requireRoutes().put(assignmentKey(role, route), row)
    return structuredClone(row)
  }

  /**
   * List route assignments merged with their evidence as per-route summaries,
   * optionally for one role, in role-topology order then provider/model order.
   * @param role - optional role filter.
   * @returns the summaries, detached from the store.
   */
  routes(role?: EvolutionRole): readonly RouteSummary[] {
    const rows = [...this.requireRoutes().entries()].map(([, row]) => structuredClone(row))
    const evidence = [...this.requireEvidence().entries()].map(([, row]) => structuredClone(row))
    const roles = role === undefined ? EVOLUTION_ROLES : [role]
    const order = Object.fromEntries(EVOLUTION_ROLES.map((entry, index) => [entry, index]))
    return roles.flatMap(r => mergeEvidence(rows, evidence, r))
      .sort((left, right) =>
        order[left.role] - order[right.role]
        || left.provider.localeCompare(right.provider)
        || left.model.localeCompare(right.model))
  }

  /**
   * List recorded evidence, newest first, optionally filtered by role and
   * route.
   * @param role - optional role filter.
   * @param route - optional route filter.
   * @returns the evidence rows, detached from the store.
   */
  evidence(role?: EvolutionRole, route?: ModelRoute): readonly RouteEvidence[] {
    const rows = [...this.requireEvidence().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row =>
        (role === undefined || row.role === role)
        && (route === undefined || (row.provider === route.provider && row.model === route.model)))
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id))
    return rows
  }

  /**
   * Recommend the route for one role: the pinned assignment when one exists,
   * otherwise the route with the strongest recorded evidence. Yields undefined
   * when the role has neither.
   * @param role - the role to recommend for.
   * @returns the recommended route, or undefined.
   */
  recommend(role: EvolutionRole): ModelRoute | undefined {
    const rows = [...this.requireRoutes().entries()].map(([, row]) => structuredClone(row))
    const evidence = [...this.requireEvidence().entries()].map(([, row]) => structuredClone(row))
    return bestRoute(rows, mergeEvidence(rows, evidence, role), role)
  }

  private currentOrigin(role: EvolutionRole, route: ModelRoute): RouteOrigin {
    return this.requireRoutes().get(assignmentKey(role, route))?.origin ?? 'observed'
  }

  private requireRoutes(): KvTable<string, RouteRow> {
    if (this.routesTable === undefined) throw new Error('evolution model routes are not started yet')
    return this.routesTable
  }

  private requireEvidence(): KvTable<string, RouteEvidence> {
    if (this.evidenceTable === undefined) throw new Error('evolution model routes are not started yet')
    return this.evidenceTable
  }
}

export default EvolutionModelRoutes

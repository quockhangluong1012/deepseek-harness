/**
 * Adaptive model routing (`ctx.evolutionModelRoutes`): a durable store of
 * per-role route assignments over the evolutionary role topology (§28) — task
 * execution, reflection, candidate generation, evaluation, and final
 * promotion review each may run on a different model — with measured evidence
 * behind each route. The optimizer records every candidate-generation run's
 * route and outcome through the optional recorder seam, operators pin
 * assignments through /routes, and `recommend` answers which route a role
 * should use: the pinned assignment when one exists, otherwise the route with
 * the strongest recorded evidence. The same store records which identity filled
 * each role of one run and answers §53's separation of duties over that pair,
 * refusing a promotion or a verdict whose judging identity is the producing
 * one. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-model-routes
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { dutyKey, separationOfDuties } from './duties.ts'
import { bestRoute, EVOLUTION_ROLES, mergeEvidence, roleConflicts, routeKey } from './routes.ts'
import { modelRoutesDomainSpec } from './spec.ts'
import type { DutyDecision, DutyInput, DutyRecord, DutyVerdict, EvolutionRole, ModelRoute, RoleConflict, RouteEvidence, RouteEvidenceInput, RouteOrigin, RouteRow, RouteSummary } from './types.ts'

export type * from './types.ts'
export { dutyKey, SEPARATED_DUTIES, separationOfDuties } from './duties.ts'
export type { DutySeparation } from './duties.ts'
export { bestRoute, EVOLUTION_ROLES, JUDGING_ROLES, mergeEvidence, PRODUCING_ROLES, ROUTE_ORIGINS, roleConflicts, routeKey } from './routes.ts'
export { dutyRow, modelRoutesDomainSpec, routeEvidenceRow, routeRow } from './spec.ts'

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
 * Adaptive model-routing store over durable assignments, evidence, and the
 * identities that filled a run's evolutionary roles. Opens the
 * `evolution_model_routes` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionModelRoutes extends Service {
  static inject = ['storageDomain']

  private routesTable?: KvTable<string, RouteRow>
  private evidenceTable?: KvTable<string, RouteEvidence>
  private dutiesTable?: KvTable<string, DutyRecord>

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
    this.dutiesTable = domain.table('duties')
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
    return roles.flatMap(r => mergeEvidence(rows, evidence, r))
      .sort((left, right) =>
        EVOLUTION_ROLES.indexOf(left.role) - EVOLUTION_ROLES.indexOf(right.role)
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

  /**
   * The §28 topology conflicts in the current assignment set: routes that both
   * produce work and judge it, which make the judging role's verdicts
   * non-independent by construction. Recorded, never enforced — the assignment
   * set still answers `recommend` exactly as recorded.
   * @returns the conflicts, ordered by provider then model.
   */
  conflicts(): readonly RoleConflict[] {
    return roleConflicts([...this.requireRoutes().entries()].map(([, row]) => structuredClone(row)))
  }

  /**
   * Record the identity that filled one evolutionary role of one run, so §53's
   * separation of duties has the pair to compare. Recording a role twice for
   * one run replaces its identity: the newest fill wins.
   * @param input - the run, the role, and the identity that filled it.
   * @returns the stored duty row.
   */
  async recordDuty(input: DutyInput): Promise<DutyRecord> {
    const row: DutyRecord = {
      runId: input.runId,
      role: input.role,
      identity: input.identity,
      at: new Date().toISOString(),
    }
    await this.requireDuties().put(dutyKey(input.runId, input.role), row)
    return structuredClone(row)
  }

  /**
   * List one run's recorded role fills, in role-topology order.
   * @param runId - the run to list.
   * @returns the duty rows, detached from the store.
   */
  duties(runId: string): readonly DutyRecord[] {
    return [...this.requireDuties().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => row.runId === runId)
      .sort((left, right) => EVOLUTION_ROLES.indexOf(left.role) - EVOLUTION_ROLES.indexOf(right.role))
  }

  /**
   * §53's separation of duties for one decision over one run: whether the
   * judging role's recorded identity differs from the producing role's. The
   * store records what a caller filled each role with and refuses on what it
   * read, so a decision taken without recording both identities is refused as
   * unknown rather than assumed independent.
   * @param runId - the run the decision concerns.
   * @param decision - the decision being taken.
   * @returns the verdict, whose refusal names both roles.
   */
  checkDuties(runId: string, decision: DutyDecision): DutyVerdict {
    return separationOfDuties(this.duties(runId), runId, decision)
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

  private requireDuties(): KvTable<string, DutyRecord> {
    if (this.dutiesTable === undefined) throw new Error('evolution model routes are not started yet')
    return this.dutiesTable
  }
}

export default EvolutionModelRoutes

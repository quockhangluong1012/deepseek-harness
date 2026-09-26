/**
 * Model routing (`ctx.evolutionModelRoutes`): the durable history owner for
 * which provider/model each evolutionary role (§28) — task execution,
 * reflection, candidate generation, evaluation, and final promotion review —
 * ran on, how each route measured, and which identity filled each role of a
 * run. The optimizer records every staged write's route and outcome through the
 * optional recorder seam, operators pin assignments through /routes, and
 * `recommend` answers which route a role should use: the pinned assignment when
 * one exists, otherwise the route the recorded runs rank first. The same store
 * answers §53's separation of duties over the recorded role fills, refusing a
 * promotion or a verdict whose judging identity is the producing one, and §44's
 * route disagreement as an uncertainty signal. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-model-routes
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-uncertainty'
import z from 'zod'
import { dutyKey, separationOfDuties } from './duties.ts'
import { routeDisagreement, routeDisagreements } from './disagreement.ts'
import {
  assignmentKey,
  effectivenessRows,
  EVOLUTION_ROLES,
  mergeEvidence,
  rankRoutes,
  roleConflicts,
} from './routes.ts'
import { legacyRouterDomainSpec, modelRoutesDomainSpec } from './spec.ts'
import type {
  DutyDecision,
  DutyInput,
  DutyRecord,
  DutyVerdict,
  EvolutionRole,
  ModelRoute,
  RoleConflict,
  RouteDisagreement,
  RouteEffectiveness,
  RouteEvidence,
  RouteEvidenceInput,
  RouteRankingEntry,
  RouteRow,
  RouteSummary,
  RouteTaskClass,
} from './types.ts'

export type * from './types.ts'
export { dutyKey, SEPARATED_DUTIES, separationOfDuties } from './duties.ts'
export type { DutySeparation } from './duties.ts'
export { routeDisagreement, routeDisagreements } from './disagreement.ts'
export {
  assignmentKey,
  effectivenessKey,
  effectivenessRows,
  EVOLUTION_ROLES,
  JUDGING_ROLES,
  mergeEvidence,
  PRODUCING_ROLES,
  rankRoutes,
  ROUTE_ORIGINS,
  roleConflicts,
  routeKey,
  scoreOf,
  updatedEffectiveness,
} from './routes.ts'
export {
  dutyRow,
  legacyRouterDomainSpec,
  modelRoutesDomainSpec,
  routeEvidenceRow,
  routeRow,
} from './spec.ts'

/**
 * Validated configuration of the model-routing store; an omitted field takes
 * its default.
 */
export interface Config {
  /**
   * Runs a route needs before it may be recommended; defaults to 1, so a role
   * with one observed run is still named. Raise it to demand a wider margin
   * before an unmeasured deployment starts following thin evidence.
   */
  minimumRuns?: number
  /** Runs a route needs before the disagreement comparison measures it; defaults to 3. */
  disagreementMinimumRuns?: number
  /** Pass-rate gap at which two routes disagree strongly; defaults to 0.5. */
  disagreementThreshold?: number
}

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  /** Runs a route needs before it may be recommended. */
  minimumRuns: number
  /** Runs a route needs before the disagreement comparison measures it. */
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
  const { minimumRuns = 1, disagreementMinimumRuns = 3, disagreementThreshold = 0.5 } = config
  return { minimumRuns, disagreementMinimumRuns, disagreementThreshold }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-role model route assignments with measured evidence. */
    evolutionModelRoutes: EvolutionModelRoutes
  }
}

/**
 * Model-routing store over durable assignments, evidence, and the identities
 * that filled a run's evolutionary roles. Opens the `evolution_model_routes`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionModelRoutes extends Service {
  static inject = ['storageDomain']

  /** Evidence gates for the recommendation and the §44 disagreement. */
  // `optional()` so a mount that names no config still takes the gates'
  // defaults, which is how the shipped profile mounts this store.
  static Config = z.object({
    minimumRuns: z.number().int().min(0).default(1),
    disagreementMinimumRuns: z.number().int().min(0).default(3),
    disagreementThreshold: z.number().min(0).max(1).default(0.5),
  }).optional()

  private readonly resolved: ResolvedConfig

  private routesTable?: KvTable<string, RouteRow>
  private evidenceTable?: KvTable<string, RouteEvidence>
  private dutiesTable?: KvTable<string, DutyRecord>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - evidence gates.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionModelRoutes')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain, import the retired router domain's outcomes, and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(modelRoutesDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-model-routes.domainClose')
    this.routesTable = domain.table('routes')
    this.evidenceTable = domain.table('evidence')
    this.dutiesTable = domain.table('duties')
    await this.importRouterOutcomes()
  }

  /**
   * Record one measured outcome of a route used in a role, upserting the route
   * as `observed` unless it is already pinned (a pin outlives its evidence).
   * When the outcome leaves the best-measured routes of its task class and role
   * strongly disagreeing, the §44 disagreement is recorded as an uncertainty
   * signal through the optional store seam. A failing disagreement record must
   * not fail the observation.
   * @param input - the role, route, task class, and measured triple.
   * @returns the stored evidence row.
   */
  async observe(input: RouteEvidenceInput): Promise<RouteEvidence> {
    const now = new Date().toISOString()
    const route: ModelRoute = { provider: input.route.provider, model: input.route.model }
    if (this.requireRoutes().get(assignmentKey(input.role, route)) === undefined) {
      await this.requireRoutes().put(assignmentKey(input.role, route), {
        role: input.role,
        provider: route.provider,
        model: route.model,
        origin: 'observed',
        at: now,
      })
    }
    const evidence: RouteEvidence = {
      id: randomUUID(),
      role: input.role,
      provider: route.provider,
      model: route.model,
      pass: input.triple.pass,
      tokens: input.triple.tokens,
      wallTimeMs: input.triple.wallTimeMs,
      at: now,
      taskClass: input.taskClass,
    }
    await this.requireEvidence().put(evidence.id, evidence)
    if (input.taskClass !== undefined) {
      await this.recordDisagreement(input.taskClass, input.role)
    }
    return structuredClone(evidence)
  }

  /**
   * Pin one route for one role: the operator's explicit assignment outranks
   * every measured route in `recommend`. Pinning an existing route flips its
   * origin; pinning a fresh route creates the row.
   * @param role - the role to assign.
   * @param provider - provider half of the route.
   * @param model - model half of the route.
   * @returns the stored assignment.
   */
  async pin(role: EvolutionRole, provider: string, model: string): Promise<RouteRow> {
    const row: RouteRow = {
      role,
      provider,
      model,
      origin: 'pinned',
      at: new Date().toISOString(),
    }
    await this.requireRoutes().put(assignmentKey(role, { provider, model }), row)
    return structuredClone(row)
  }

  /**
   * List route assignments merged with their evidence as per-route summaries
   * pooled over the role's task classes, optionally for one role, in
   * role-topology order then provider/model order.
   * @param role - optional role filter.
   * @returns the summaries, detached from the store.
   */
  routes(role?: EvolutionRole): readonly RouteSummary[] {
    const rows = this.routeRows()
    const evidence = this.evidence()
    const roles = role === undefined ? EVOLUTION_ROLES : [role]
    return roles.flatMap(candidate => mergeEvidence(rows, evidence, candidate))
      .sort((left, right) =>
        EVOLUTION_ROLES.indexOf(left.role) - EVOLUTION_ROLES.indexOf(right.role)
        || left.provider.localeCompare(right.provider)
        || left.model.localeCompare(right.model))
  }

  /**
   * List recorded outcomes, newest first, optionally filtered by role and
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
   * The derived effectiveness of every route on a task class, optionally
   * filtered by task class and role, in task-class then role-topology then
   * provider/model order. Outcomes recorded without a task class measured the
   * role as a whole and feed `routes` instead.
   * @param taskClass - optional task-class filter.
   * @param role - optional role filter.
   * @returns the effectiveness rows, detached from the store.
   */
  effectiveness(taskClass?: RouteTaskClass, role?: EvolutionRole): readonly RouteEffectiveness[] {
    return effectivenessRows(this.evidence(), this.routeRows(), { taskClass, role })
  }

  /**
   * The route one role should use: the pinned assignment when one exists,
   * otherwise the best-ranked route with at least `minimumRuns` recorded runs.
   * Without a `taskClass` the ranking pools the role's runs across its task
   * classes; with one it ranks only that class's routes. Yields undefined while
   * the role has neither a pin nor a route measured that well.
   * @param role - the role to recommend for.
   * @param taskClass - optional task class to rank within.
   * @returns the recommended route with the numbers behind it, or undefined.
   */
  recommend(role: EvolutionRole, taskClass?: RouteTaskClass): RouteRankingEntry | undefined {
    const measured = taskClass === undefined
      ? this.routes(role)
      : this.effectiveness(taskClass, role)
    const ranked = rankRoutes(measured, this.resolved.minimumRuns)
    return ranked.find(entry => entry.origin === 'pinned')
      ?? ranked.find(entry => entry.runs >= this.resolved.minimumRuns)
  }

  /**
   * The §44 route disagreements among the recorded outcomes: per task class and
   * role, the two best-measured routes whose pass rates diverge by more than the
   * configured threshold, strongest gap first.
   * @param taskClass - optional task-class filter.
   * @param role - optional role filter.
   * @returns the disagreements, strongest first.
   */
  disagreements(taskClass?: RouteTaskClass, role?: EvolutionRole): readonly RouteDisagreement[] {
    return routeDisagreements(
      this.effectiveness(taskClass, role),
      this.resolved.disagreementMinimumRuns,
      this.resolved.disagreementThreshold,
    )
  }

  /**
   * The §28 topology conflicts in the current assignment set: routes that both
   * produce work and judge it, which make the judging role's verdicts
   * non-independent by construction. Recorded, never enforced — the assignment
   * set still answers `recommend` exactly as recorded.
   * @returns the conflicts, ordered by provider then model.
   */
  conflicts(): readonly RoleConflict[] {
    return roleConflicts(this.routeRows())
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

  /**
   * Copy the outcomes the retired `evolution_router` domain recorded into this
   * store's evidence, each under its original record key so a repeated startup
   * converges on the same rows. An assignment is written only when the route
   * has none, so a later pin is never reverted to `observed`. The retired unit
   * itself is left untouched.
   */
  private async importRouterOutcomes(): Promise<void> {
    // ponytail: the retired unit is reopened and re-read on every startup. It
    // costs one empty-directory scan once the import has run; drop this block
    // with the version-1 compatibility window.
    const legacy = await this.ctx.storageDomain.open(legacyRouterDomainSpec)
    try {
      for (const [key, outcome] of legacy.table('outcomes').entries()) {
        if (this.requireEvidence().get(key) !== undefined) continue
        const route: ModelRoute = { provider: outcome.provider, model: outcome.model }
        if (this.requireRoutes().get(assignmentKey(outcome.role, route)) === undefined) {
          await this.requireRoutes().put(assignmentKey(outcome.role, route), {
            role: outcome.role,
            provider: route.provider,
            model: route.model,
            origin: 'observed',
            at: outcome.at,
          })
        }
        await this.requireEvidence().put(key, {
          id: key,
          role: outcome.role,
          provider: route.provider,
          model: route.model,
          pass: outcome.pass,
          tokens: outcome.tokens,
          wallTimeMs: outcome.wallTimeMs,
          at: outcome.at,
          taskClass: outcome.taskClass,
        })
      }
    } finally {
      await legacy.close()
    }
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
  private async recordDisagreement(taskClass: RouteTaskClass, role: EvolutionRole): Promise<void> {
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
      this.ctx.logger.warn(`evolution model routes could not record route disagreement: ${String(error)}`)
    }
  }

  private routeRows(): RouteRow[] {
    return [...this.requireRoutes().entries()].map(([, row]) => structuredClone(row))
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

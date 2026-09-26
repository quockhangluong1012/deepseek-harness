/**
 * Public type vocabulary of the model-routing history owner: the evolutionary
 * role topology, the route assignment set, the measured evidence behind each
 * route with the effectiveness and ranking derived from it, the §44 route
 * disagreement, and the identities that filled a run's roles. Types only — no
 * runtime code.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/types
 */

/**
 * One evolutionary role from the spec's adaptive-routing topology (§28): task
 * execution, reflection, candidate generation, evaluation, and final
 * promotion review each may run on a different model.
 */
export type EvolutionRole =
  | 'task-execution'
  | 'reflection'
  | 'candidate-generation'
  | 'evaluation'
  | 'promotion-review'

/** One task class a route is measured on, e.g. a skill name. */
export type RouteTaskClass = string

/** One provider/model route, mirroring the optimizer's route config shape. */
export interface ModelRoute {
  /** Provider identity, as the optimizer's `provider` config resolves it. */
  provider: string
  /** Model identity under that provider. */
  model: string
}

/** How a route entered the assignment set. */
export type RouteOrigin = 'observed' | 'pinned'

/** One route assignment for one role. */
export interface RouteRow {
  /** Role the route serves. */
  role: EvolutionRole
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** How the route entered the set; pinned assignments outrank observed ones. */
  origin: RouteOrigin
  /** ISO-8601 instant the assignment was last touched. */
  at: string
}

/** The measured triple of one routed run. */
export interface RouteTriple {
  /** Whether the run passed its corpus. */
  pass: boolean
  /** Billed tokens the run consumed. */
  tokens: number
  /** Wall time of the run, in milliseconds. */
  wallTimeMs: number
}

/** One measured outcome of a route used in a role. */
export interface RouteEvidence {
  /** Evidence row identity. */
  id: string
  /** Role the route served. */
  role: EvolutionRole
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** Whether the run passed its corpus. */
  pass: boolean
  /** Billed tokens the run consumed. */
  tokens: number
  /** Wall time of the run, in milliseconds. */
  wallTimeMs: number
  /** ISO-8601 instant the outcome was measured. */
  at: string
  /**
   * The task class the outcome was measured on. Absent on outcomes recorded
   * before the store learned task classes, which read as measured for the role
   * as a whole: they feed the per-role summary and never a per-class ranking.
   */
  taskClass?: RouteTaskClass | undefined
}

/** One measured outcome offered for recording. */
export interface RouteEvidenceInput {
  /** Role the route served. */
  role: EvolutionRole
  /** The route that served the role. */
  route: ModelRoute
  /** The measured triple of the run. */
  triple: RouteTriple
  /** The task class the run measured, or absent to record a role-wide outcome. */
  taskClass?: RouteTaskClass | undefined
}

/**
 * The numbers every route reading derives, whether pooled across a role's task
 * classes or scoped to one of them. Ranking reads this shape, so a pooled
 * summary and a per-class effectiveness row rank by the same rule.
 */
export interface RouteMeasurement {
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** How the route entered the assignment set. */
  origin: RouteOrigin
  /** Recorded runs of this route. */
  runs: number
  /** Passing runs among the recorded runs. */
  passes: number
  /** Passing runs as a share of recorded runs; 0 when none are recorded. */
  passRate: number
  /** Mean billed tokens per recorded run; 0 when none are recorded. */
  meanTokens: number
  /** Mean wall time per recorded run, in milliseconds; 0 when none are recorded. */
  meanWallTimeMs: number
}

/** Aggregated per-route evidence within one role, pooled over its task classes. */
export interface RouteSummary extends RouteMeasurement {
  /** Role the route served. */
  role: EvolutionRole
  /** Newest evidence `at`, or null when none is recorded. */
  lastAt: string | null
}

/** Derived effectiveness of one route on one task class and role. */
export interface RouteEffectiveness extends RouteMeasurement {
  /** The task class the route was measured on. */
  taskClass: RouteTaskClass
  /** The role the route served. */
  role: EvolutionRole
  /** ISO-8601 instant of the last measured outcome. */
  lastAt: string
}

/** One ranked route with the numbers behind its rank. */
export interface RouteRankingEntry {
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** How the route entered the assignment set. */
  origin: RouteOrigin
  /** Recorded runs of the route. */
  runs: number
  /** Passing runs as a share of recorded runs. */
  passRate: number
  /** Mean billed tokens per recorded run. */
  meanTokens: number
  /** Mean wall time per recorded run, in milliseconds. */
  meanWallTimeMs: number
  /** The sample-confidence-adjusted score that ranks the route. */
  score: number
  /** Why the route ranks here, naming the numbers. */
  reason: string
}

/**
 * One strong disagreement between the two best-measured routes of one task
 * class and role (§44).
 */
export interface RouteDisagreement {
  /** The task class the routes were measured on. */
  taskClass: RouteTaskClass
  /** The role the routes served. */
  role: EvolutionRole
  /** The route with the higher recorded pass rate. */
  leader: ModelRoute
  /** The route with the lower recorded pass rate. */
  trailer: ModelRoute
  /** Recorded pass rate of the leader. */
  leaderPassRate: number
  /** Recorded pass rate of the trailer. */
  trailerPassRate: number
  /** The pass-rate gap between them, in 0..1. */
  gap: number
  /** Runs behind each route, leader then trailer. */
  runs: readonly [number, number]
  /** What was observed, naming both routes and their rates. */
  detail: string
}

/**
 * One §28 topology conflict: a route that both produces work and judges it, so
 * every verdict from it is the candidate's own model judging itself.
 */
export interface RoleConflict {
  /** The route serving both sides. */
  route: ModelRoute
  /** Producing roles the route serves, in topology order. */
  producing: EvolutionRole[]
  /** Judging roles the route serves, in topology order. */
  judging: EvolutionRole[]
  /** Whether an operator pinned the conflicting assignment. */
  pinned: boolean
  /** What was observed, naming the roles. */
  detail: string
}

/**
 * The decision §53's separation of duties guards: who may review a promotion,
 * who may evaluate a candidate, and who may apply a curator consolidation
 * verdict a different identity proposed.
 */
export type DutyDecision = 'promotion' | 'verdict' | 'consolidation'

/**
 * One identity that filled one evolutionary role for one run. §53's separation
 * of duties reads two of these per decision: the role that generated the
 * candidate and the role that judged it.
 */
export interface DutyRecord {
  /** The run the role belongs to. */
  runId: string
  /** Role the identity filled. */
  role: EvolutionRole
  /** Identity that filled the role. */
  identity: string
  /** ISO-8601 instant the fill was recorded. */
  at: string
}

/** One role fill offered for recording. */
export interface DutyInput {
  /** The run the role belongs to. */
  runId: string
  /** Role the identity filled. */
  role: EvolutionRole
  /** Identity that filled the role. */
  identity: string
}

/** How §53's separation of duties refused a decision. */
export type DutyRefusal =
  /** A role the decision separates carries no recorded identity for the run. */
  | 'unknown-identity'
  /** One identity filled both the producing and the judging role. */
  | 'same-identity'

/**
 * The separation-of-duties verdict for one decision over one run: allowed, or
 * refused with the kind of refusal and the reason naming both roles.
 */
export type DutyVerdict =
  | { allowed: true }
  | { allowed: false; refusal: DutyRefusal; reason: string }

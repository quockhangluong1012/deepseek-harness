/**
 * Public type vocabulary of the adaptive model-routing store: the evolutionary
 * role topology, the route assignment set, and the measured evidence behind
 * each route. Types only — no runtime code.
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
}

/** One measured outcome offered for recording. */
export interface RouteEvidenceInput {
  /** Role the route served. */
  role: EvolutionRole
  /** The route that served the role. */
  route: ModelRoute
  /** The measured triple of the run. */
  triple: { pass: boolean; tokens: number; wallTimeMs: number }
}

/** Aggregated per-route evidence within one role. */
export interface RouteSummary {
  /** Role the route served. */
  role: EvolutionRole
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** How the route entered the assignment set. */
  origin: RouteOrigin
  /** Recorded runs of this route in this role. */
  runs: number
  /** Passing runs as a share of recorded runs; 0 when none are recorded. */
  passRate: number
  /** Mean billed tokens per recorded run; 0 when none are recorded. */
  meanTokens: number
  /** Newest evidence `at`, or null when none are recorded. */
  lastAt: string | null
}

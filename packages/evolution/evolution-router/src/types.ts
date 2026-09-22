/**
 * Public type vocabulary of the routing self-optimization store: the
 * evolutionary role topology, one route outcome measured on a task class, the
 * derived per-route effectiveness, and the ranked recommendation of which
 * route a task class and role should use (§28). Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-router/src/types
 */

/** The §28 evolutionary roles a route may serve. */
export type RoutingRole = 'task-execution' | 'reflection' | 'candidate-generation' | 'evaluation' | 'promotion-review'

/** One task class a route is judged on, e.g. a skill name. */
export type RouterTaskClass = string

/** One measured outcome of a route serving one role on one task class. */
export interface RouteOutcome {
  /** The task class the outcome was measured on. */
  taskClass: RouterTaskClass
  /** The role the route served. */
  role: RoutingRole
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** Whether the routed run passed. */
  pass: boolean
  /** Tokens the routed run spent. */
  tokens: number
  /** Wall time the routed run spent, in milliseconds. */
  wallTimeMs: number
  /** ISO-8601 instant the outcome was measured. */
  at: string
}

/** Derived effectiveness of one route on one task class and role. */
export interface RouteEffectiveness {
  /** The task class the route was measured on. */
  taskClass: RouterTaskClass
  /** The role the route served. */
  role: RoutingRole
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** Outcomes measured for the route. */
  samples: number
  /** Outcomes that passed. */
  passes: number
  /** Share of outcomes that passed. */
  passRate: number
  /** Mean tokens per outcome. */
  meanTokens: number
  /** Mean wall time per outcome, in milliseconds. */
  meanWallTimeMs: number
  /** ISO-8601 instant of the last measured outcome. */
  lastAt: string
}

/** One ranked route with the numbers behind its rank. */
export interface RouteRankingEntry {
  /** Provider half of the route. */
  provider: string
  /** Model half of the route. */
  model: string
  /** Outcomes measured for the route. */
  samples: number
  /** Share of outcomes that passed. */
  passRate: number
  /** Mean tokens per outcome. */
  meanTokens: number
  /** Mean wall time per outcome, in milliseconds. */
  meanWallTimeMs: number
  /** The sample-confidence-adjusted score that ranks the route. */
  score: number
  /** Why the route ranks here, naming the numbers. */
  reason: string
}
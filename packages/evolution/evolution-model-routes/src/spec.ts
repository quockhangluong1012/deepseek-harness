/**
 * The evolution-model-routes domain declarations: the durable route
 * assignments, their measured evidence, and the identity that filled each role
 * of a run — plus the retired `evolution_router` domain whose recorded
 * outcomes version 2 imports. Zod validates the shipped format at the
 * durability boundary.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { EVOLUTION_ROLES, ROUTE_ORIGINS } from './routes.ts'
import type { DutyRecord, RouteEvidence, RouteRow } from './types.ts'

/** Durable shape of one route assignment. */
export const routeRow = z.object({
  role: z.enum(EVOLUTION_ROLES),
  provider: z.string(),
  model: z.string(),
  origin: z.enum(ROUTE_ORIGINS),
  at: z.string(),
})

/**
 * Durable shape of one measured outcome. Version 2 adds the task class the
 * outcome was measured on; version-1 rows carry no task class and read as
 * measured for the role as a whole.
 */
export const routeEvidenceRow = z.object({
  id: z.string(),
  role: z.enum(EVOLUTION_ROLES),
  provider: z.string(),
  model: z.string(),
  pass: z.boolean(),
  tokens: z.number(),
  wallTimeMs: z.number(),
  at: z.string(),
  taskClass: z.string().optional(),
})

/** Durable shape of one role fill. */
export const dutyRow = z.object({
  runId: z.string(),
  role: z.enum(EVOLUTION_ROLES),
  identity: z.string(),
  at: z.string(),
})

/** One stored assignment, inferred from {@link routeRow}. */
export type RouteRowRow = z.infer<typeof routeRow>

/** One stored outcome, inferred from {@link routeEvidenceRow}. */
export type RouteEvidenceRow = z.infer<typeof routeEvidenceRow>

/**
 * The evolution-model-routes domain spec: a `routes` table keyed by role+route,
 * an `evidence` table keyed by evidence identity, and a `duties` table keyed by
 * run+role. `per-record` because assignments, outcomes, and role fills are
 * independent. Version 2 adds the task class to an outcome, and reads the
 * outcomes the retired `evolution_router` domain recorded — see
 * {@link legacyRouterDomainSpec}. Invalid rows fail the domain open loudly:
 * routes and duties back model selection and its separation of duties, not
 * disposable derived data.
 */
export const modelRoutesDomainSpec = defineDomain({
  name: 'evolution_model_routes',
  version: 2,
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    routes: domainTable<string, RouteRow>(routeRow),
    evidence: domainTable<string, RouteEvidence>(routeEvidenceRow),
    duties: domainTable<string, DutyRecord>(dutyRow),
  },
})

/**
 * The retired `evolution_router` domain, read once at startup so the outcomes
 * it recorded before the merge stay in this store's history. Its own unit is
 * never written again and never deleted; the import copies each outcome under
 * its original record key, so re-running the import is idempotent.
 */
export const legacyRouterDomainSpec = defineDomain({
  name: 'evolution_router',
  version: 1,
  layout: 'per-record',
  tables: {
    outcomes: domainTable<string, LegacyRouteOutcome>(z.object({
      taskClass: z.string(),
      role: z.enum(EVOLUTION_ROLES),
      provider: z.string(),
      model: z.string(),
      pass: z.boolean(),
      tokens: z.number(),
      wallTimeMs: z.number(),
      at: z.string(),
    })),
  },
})

/** One outcome as the retired `evolution_router` domain recorded it. */
export interface LegacyRouteOutcome {
  /** The task class the outcome was measured on. */
  taskClass: string
  /** The role the route served. */
  role: (typeof EVOLUTION_ROLES)[number]
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

/**
 * The evolution-model-routes domain declaration: durable per-role route
 * assignments, their measured evidence, and the identity that filled each role
 * of a run. Zod validates the shipped format at the durability boundary.
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

/** Durable shape of one measured outcome. */
export const routeEvidenceRow = z.object({
  id: z.string(),
  role: z.enum(EVOLUTION_ROLES),
  provider: z.string(),
  model: z.string(),
  pass: z.boolean(),
  tokens: z.number(),
  wallTimeMs: z.number(),
  at: z.string(),
})

/** One stored assignment, inferred from {@link routeRow}. */
export type RouteRowRow = z.infer<typeof routeRow>

/** One stored outcome, inferred from {@link routeEvidenceRow}. */
export type RouteEvidenceRow = z.infer<typeof routeEvidenceRow>

/** Durable shape of one role fill. */
export const dutyRow = z.object({
  runId: z.string(),
  role: z.enum(EVOLUTION_ROLES),
  identity: z.string(),
  at: z.string(),
})

/**
 * The evolution-model-routes domain spec: a `routes` table keyed by
 * role+route, an `evidence` table keyed by evidence identity, and a `duties`
 * table keyed by run+role. `per-record` because assignments, outcomes, and role
 * fills are independent. Invalid rows fail the domain open loudly: routes and
 * duties back model selection and its separation of duties, not disposable
 * derived data.
 */
export const modelRoutesDomainSpec = defineDomain({
  name: 'evolution_model_routes',
  version: 1,
  layout: 'per-record',
  tables: {
    routes: domainTable<string, RouteRow>(routeRow),
    evidence: domainTable<string, RouteEvidence>(routeEvidenceRow),
    duties: domainTable<string, DutyRecord>(dutyRow),
  },
})

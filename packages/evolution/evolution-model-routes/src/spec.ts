/**
 * The evolution-model-routes domain declaration: durable per-role route
 * assignments and their measured evidence. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { EVOLUTION_ROLES, ROUTE_ORIGINS } from './routes.ts'
import type { RouteEvidence, RouteRow } from './types.ts'

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

/**
 * The evolution-model-routes domain spec: one `routes` table keyed by
 * role+route and one `evidence` table keyed by evidence identity.
 * `per-record` because assignments and outcomes are independent. Invalid rows
 * fail the domain open loudly: routes back model selection, not disposable
 * derived data.
 */
export const modelRoutesDomainSpec = defineDomain({
  name: 'evolution_model_routes',
  version: 1,
  layout: 'per-record',
  tables: {
    routes: domainTable<string, RouteRow>(routeRow),
    evidence: domainTable<string, RouteEvidence>(routeEvidenceRow),
  },
})

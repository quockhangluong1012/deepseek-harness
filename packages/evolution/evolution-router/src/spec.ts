/**
 * The evolution-router domain declaration: durable route outcomes measured on
 * task classes and roles. Zod validates the shipped format at the durability
 * boundary.
 * @module @deepseek-ai/dsh-evolution-router/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RouteOutcome } from './types.ts'

/** Durable shape of one route outcome. */
export const routeOutcomeRow = z.object({
  taskClass: z.string(),
  role: z.enum([
    'task-execution',
    'reflection',
    'candidate-generation',
    'evaluation',
    'promotion-review',
  ]),
  provider: z.string(),
  model: z.string(),
  pass: z.boolean(),
  tokens: z.number(),
  wallTimeMs: z.number(),
  at: z.string(),
})

/** One stored outcome, inferred from {@link routeOutcomeRow}. */
export type RouteOutcomeRow = z.infer<typeof routeOutcomeRow>

/**
 * The evolution-router domain spec: an `outcomes` table keyed by a per-record
 * identity. `per-record` because outcomes are append-only events; effectiveness
 * derives from them at read time. Invalid rows fail the domain open loudly:
 * routing trust depends on the numbers it reads.
 */
export const routerDomainSpec = defineDomain({
  name: 'evolution_router',
  version: 1,
  layout: 'per-record',
  tables: {
    outcomes: domainTable<string, RouteOutcome>(routeOutcomeRow),
  },
})
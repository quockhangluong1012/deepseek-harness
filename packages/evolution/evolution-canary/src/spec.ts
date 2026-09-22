/**
 * The evolution-canary domain declaration: durable deployment states of staged
 * skill patches. Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-canary/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { DEPLOYMENT_STATES } from './stages.ts'
import type { DeploymentRecord } from './types.ts'

/** Durable shape of one deployment record. */
export const deploymentRecordRow = z.object({
  id: z.string(),
  skill: z.string(),
  state: z.enum(DEPLOYMENT_STATES),
  triple: z
    .object({
      pass: z.boolean(),
      tokens: z.number(),
      wallTimeMs: z.number(),
    })
    .nullable(),
  at: z.string(),
  enteredAt: z.string(),
  decidedAt: z.string().nullable(),
})

/** One stored deployment, inferred from {@link deploymentRecordRow}. */
export type DeploymentRecordRow = z.infer<typeof deploymentRecordRow>

/**
 * The evolution-canary domain spec: one `deployments` table keyed by staged
 * write identity. `per-record` because deployments are independent. Invalid
 * rows fail the domain open loudly: deployments back rollout decisions, not
 * disposable derived data.
 */
export const canaryDomainSpec = defineDomain({
  name: 'evolution_canary',
  version: 1,
  layout: 'per-record',
  tables: {
    deployments: domainTable<string, DeploymentRecord>(deploymentRecordRow),
  },
})

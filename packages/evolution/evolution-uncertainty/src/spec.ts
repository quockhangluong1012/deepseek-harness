/**
 * The evolution-uncertainty domain declaration: durable uncertainty signals of
 * the five §43 kinds. Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-uncertainty/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { UNCERTAINTY_KINDS } from './uncertainty.ts'
import type { UncertaintySignal } from './types.ts'

/** Durable shape of one uncertainty signal. */
export const uncertaintySignalRow = z.object({
  signalId: z.string(),
  skill: z.string(),
  taskId: z.string().nullable(),
  kind: z.enum(UNCERTAINTY_KINDS),
  score: z.number(),
  detail: z.string(),
  at: z.string(),
})

/** One stored signal, inferred from {@link uncertaintySignalRow}. */
export type UncertaintySignalRow = z.infer<typeof uncertaintySignalRow>

/**
 * The evolution-uncertainty domain spec: one `signals` table keyed by signal
 * identity. `per-record` because signals are independent. Invalid rows fail the
 * domain open loudly: the queue prioritizes evaluation work off these signals.
 */
export const uncertaintyDomainSpec = defineDomain({
  name: 'evolution_uncertainty',
  version: 1,
  layout: 'per-record',
  tables: {
    signals: domainTable<string, UncertaintySignal>(uncertaintySignalRow),
  },
})

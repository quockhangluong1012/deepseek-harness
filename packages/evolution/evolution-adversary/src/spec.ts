/**
 * The evolution-adversary domain declaration: durable adversarial probes and
 * the evaluator-gaming defense checklist. Zod validates the shipped format
 * at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-adversary/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { ADVERSARIAL_CATEGORIES, GAMING_DEFENSES } from './adversary.ts'
import type { AdversarialProbe } from './types.ts'

/** Durable shape of one adversarial probe. */
export const adversarialProbeRow = z.object({
  probeId: z.string(),
  skill: z.string(),
  category: z.enum(ADVERSARIAL_CATEGORIES),
  probe: z.string(),
  foundWeakness: z.boolean(),
  repaired: z.boolean(),
  at: z.string(),
})

/** One stored probe, inferred from {@link adversarialProbeRow}. */
export type AdversarialProbeRow = z.infer<typeof adversarialProbeRow>

/** Durable shape of one gaming-defense checklist row. */
export const defenseRow = z.object({
  defense: z.enum(GAMING_DEFENSES),
  satisfied: z.boolean(),
  at: z.string(),
})

/** One stored defense row, inferred from {@link defenseRow}. */
export type DefenseRow = z.infer<typeof defenseRow>

/**
 * The evolution-adversary domain spec: a `probes` table keyed by probe
 * identity and a `defenses` table keyed by defense. `per-record` because
 * probes and checklist rows are independent. Invalid rows fail the domain
 * open loudly: probes steer adversarial repair and the checklist guards the
 * evaluators against gaming.
 */
export const adversaryDomainSpec = defineDomain({
  name: 'evolution_adversary',
  version: 1,
  layout: 'per-record',
  tables: {
    probes: domainTable<string, AdversarialProbe>(adversarialProbeRow),
    defenses: domainTable<string, DefenseRow>(defenseRow),
  },
})

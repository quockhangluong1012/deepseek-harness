/**
 * Adversarial evolution (`ctx.evolutionAdversary`): durable adversarial
 * probes across the eight §45 weakness categories — edge cases, prompt
 * injection, stale memory, retrieval traps, contradictory evidence, tool
 * failure, ambiguous instructions, evaluator gaming — plus the §46
 * evaluator-gaming defense checklist (multiple evaluators, hidden holdout,
 * behavioral metrics, adversarial tests, randomized tests, evaluator
 * rotation). The challenge names the next category to probe so no weakness
 * family goes untested; the checklist shows which automatable defenses still
 * stand open, while human spot checks stay operator-side. Nothing here calls
 * a model; operators record probes and read the challenge through the store
 * (§58.12).
 * @module @deepseek-ai/dsh-evolution-adversary
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { GAMING_DEFENSES, defenseGaps as openGaps, nextChallenge } from './adversary.ts'
import { adversaryDomainSpec } from './spec.ts'
import type { AdversarialProbe, Challenge, DefenseStatus, GamingDefense, ProbeInput } from './types.ts'
import type { DefenseRow } from './spec.ts'

export type * from './types.ts'
export { ADVERSARIAL_CATEGORIES, categoryCoverage, defenseGaps, GAMING_DEFENSES, nextChallenge, uncoveredCategories, weaknessRate } from './adversary.ts'
export { adversarialProbeRow, adversaryDomainSpec, defenseRow } from './spec.ts'
export type { AdversarialProbeRow, DefenseRow } from './spec.ts'

/** Validated configuration of the adversary store. */
export interface AdversaryConfig {
  /** Probes per category and skill before the category counts as covered. */
  minProbesPerCategory: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Adversary store growing per-skill probes and the defense checklist. */
    evolutionAdversary: EvolutionAdversary
  }
}

/**
 * Adversary store over durable probes and defense rows. Opens the
 * `evolution_adversary` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionAdversary extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the adversary store; the default probes every category once. */
  static Config = z.object({
    minProbesPerCategory: z.number().int().min(1).default(1),
  })

  /** Deployment choices of the adversary store. */
  readonly config: AdversaryConfig

  private probeTable?: KvTable<string, AdversarialProbe>
  private defenseTable?: KvTable<string, DefenseRow>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated adversary choices.
   */
  constructor(ctx: Context, config: AdversaryConfig) {
    super(ctx, 'evolutionAdversary')
    this.config = config
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(adversaryDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-adversary.domainClose')
    this.probeTable = domain.table('probes')
    this.defenseTable = domain.table('defenses')
  }

  /**
   * Record one adversarial probe, unrepaired: repair is a separate explicit
   * step so a recorded weakness is never silently marked fixed.
   * @param input - the probe to record.
   * @returns the stored probe.
   */
  async probe(input: ProbeInput): Promise<AdversarialProbe> {
    const table = this.requireProbes()
    const stored: AdversarialProbe = {
      probeId: input.probeId,
      skill: input.skill,
      category: input.category,
      probe: input.probe,
      foundWeakness: input.foundWeakness,
      repaired: false,
      at: new Date().toISOString(),
    }
    await table.put(stored.probeId, stored)
    return structuredClone(stored)
  }

  /**
   * Mark one probe repaired — or unrepaired again when a fix regresses.
   * @param probeId - the probe to update.
   * @param repaired - the repaired flag to set.
   * @returns the updated probe.
   */
  async setRepaired(probeId: string, repaired: boolean = true): Promise<AdversarialProbe> {
    const table = this.requireProbes()
    const current = table.get(probeId)
    if (current === undefined) {
      throw new Error(`evolution-adversary: unknown probe '${probeId}'`)
    }
    const next: AdversarialProbe = { ...current, repaired }
    await table.put(probeId, next)
    return structuredClone(next)
  }

  /**
   * List every probe, optionally filtered by skill, newest first.
   * @param skill - optional skill filter.
   * @returns the probes, detached from the store.
   */
  probes(skill?: string): readonly AdversarialProbe[] {
    const rows = [...this.requireProbes().entries()]
      .map(([, probe]) => structuredClone(probe))
      .filter(probe => skill === undefined || probe.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.probeId.localeCompare(right.probeId))
    return rows
  }

  /**
   * The next probing challenge of one skill under the configured probe
   * minimum: the first uncovered category, or the least-probed category once
   * every category is covered.
   * @param skill - the skill to challenge.
   * @returns the challenge naming the next category.
   */
  challenge(skill: string): Challenge {
    const rows = [...this.requireProbes().entries()].map(([, probe]) => structuredClone(probe))
    return nextChallenge(rows, skill, this.config.minProbesPerCategory)
  }

  /**
   * Set one gaming defense on the checklist.
   * @param defense - the defense to set.
   * @param satisfied - whether the defense is satisfied.
   * @returns the checklist status.
   */
  async setDefense(defense: GamingDefense, satisfied: boolean): Promise<DefenseStatus> {
    const row: DefenseRow = { defense, satisfied, at: new Date().toISOString() }
    await this.requireDefenses().put(defense, row)
    return { ...row }
  }

  /**
   * The full defense checklist in canonical order; a defense never set reads
   * unsatisfied with a null instant.
   * @returns the checklist, detached from the store.
   */
  defenses(): readonly DefenseStatus[] {
    const table = this.requireDefenses()
    return GAMING_DEFENSES.map((defense) => {
      const row = table.get(defense)
      if (row === undefined) return { defense, satisfied: false, at: null }
      return { defense, satisfied: row.satisfied, at: row.at }
    })
  }

  /**
   * The defenses still open, in canonical order.
   * @returns the open defenses.
   */
  defenseGaps(): GamingDefense[] {
    return openGaps(this.defenses())
  }

  private requireProbes(): KvTable<string, AdversarialProbe> {
    if (this.probeTable === undefined) throw new Error('evolution adversary store is not started yet')
    return this.probeTable
  }

  private requireDefenses(): KvTable<string, DefenseRow> {
    if (this.defenseTable === undefined) throw new Error('evolution adversary store is not started yet')
    return this.defenseTable
  }
}

export default EvolutionAdversary

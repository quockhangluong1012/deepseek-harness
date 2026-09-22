/**
 * Controlled self-model (`ctx.evolutionSelfModel`): a durable per-skill
 * capability record — strengths, weaknesses, uncertain areas, failure modes,
 * preferred tools, evaluator blindspots — feeding a weakest-first capability
 * frontier that says what to learn next (§42, §33). Each skill's assessment
 * is an upserted revision tick; each capability entry tracks its running pass
 * rate, confidence from the observation count, newest-first failure notes,
 * and the covering skills in first-seen order. The frontier ranks weakest
 * first — lower pass rate, then thinner evidence, then fewer covering skills
 * — so the loop learns the least-known weak capability next. Record-only:
 * nothing here calls a model, and nothing enforces what the loop must learn
 * (§58.12: trust is recorded, not enforced).
 * @module @deepseek-ai/dsh-evolution-self-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { frontierGaps, mergeModel, nextToLearn as weakestFirst, observeCapability } from './selfmodel.ts'
import { selfModelDomainSpec } from './spec.ts'
import type {
  CapabilityEntry,
  CapabilityObservation,
  FrontierGap,
  SelfModel,
  SelfModelInput,
} from './types.ts'

export type * from './types.ts'
export { frontierGaps, mergeModel, nextToLearn, observeCapability } from './selfmodel.ts'
export { capabilityEntryRow, selfModelDomainSpec, selfModelRow } from './spec.ts'

/** Deployment choices of the self-model store; omitted fields take their defaults. */
export interface Config {
  /** Observations that earn a capability entry full confidence; defaults to 10. */
  maxObservations?: number
  /** Newest failure notes kept per capability entry; defaults to 10. */
  maxFailures?: number
}

/** Normalized configuration used by the self-model store. */
export interface ResolvedConfig {
  /** Observations that earn a capability entry full confidence. */
  maxObservations: number
  /** Newest failure notes kept per capability entry. */
  maxFailures: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { maxObservations = 10, maxFailures = 10 } = config
  return { maxObservations, maxFailures }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Self-model store growing per-skill assessments and capability entries. */
    evolutionSelfModel: EvolutionSelfModel
  }
}

/**
 * Self-model store over durable assessments and capability entries. Opens
 * the `evolution_selfmodel` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionSelfModel extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the store; defaults assume an ordinary cadence. */
  static Config = z.object({
    maxObservations: z.number().int().min(1).default(10),
    maxFailures: z.number().int().min(1).default(10),
  })

  /** Normalized deployment choices of the self-model store. */
  private readonly resolved: ResolvedConfig

  private modelTable?: KvTable<string, SelfModel>
  private capabilityTable?: KvTable<string, CapabilityEntry>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - user-facing plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionSelfModel')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(selfModelDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-self-model.domainClose')
    this.modelTable = domain.table('models')
    this.capabilityTable = domain.table('capabilities')
  }

  /**
   * Record one skill's self-assessment, replacing its previous whole
   * self-view and ticking the revision one past it (1 for the first).
   * @param input - the assessment to record.
   * @returns the stored assessment.
   */
  async record(input: SelfModelInput): Promise<SelfModel> {
    const table = this.requireModels()
    const prev = table.get(input.skill) ?? null
    const model = mergeModel(prev, input, new Date().toISOString())
    await table.put(model.skill, model)
    return structuredClone(model)
  }

  /**
   * Read one skill's assessment, detached from the store.
   * @param skill - the skill to inspect.
   * @returns the assessment, or undefined without one.
   */
  assessment(skill: string): SelfModel | undefined {
    const found = this.requireModels().get(skill)
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * List every assessment by skill name, detached from the store.
   * @returns the assessments, skill ascending.
   */
  assessments(): readonly SelfModel[] {
    const rows = [...this.requireModels().entries()].map(([, model]) => structuredClone(model))
    rows.sort((left, right) => left.skill.localeCompare(right.skill))
    return rows
  }

  /**
   * Fold one capability observation into the capability's entry, creating
   * the entry on the first observation of its capability.
   * @param obs - the observation to record.
   * @returns the stored entry.
   */
  async observe(obs: CapabilityObservation): Promise<CapabilityEntry> {
    const table = this.requireCapabilities()
    const prev = table.get(obs.capability) ?? null
    const entry = observeCapability(prev, obs, new Date().toISOString(), this.resolved.maxObservations, this.resolved.maxFailures)
    await table.put(entry.capability, entry)
    return structuredClone(entry)
  }

  /**
   * Read one capability's entry, detached from the store.
   * @param name - the capability to inspect.
   * @returns the entry, or undefined without one.
   */
  capability(name: string): CapabilityEntry | undefined {
    const found = this.requireCapabilities().get(name)
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * List every capability entry by capability name, detached from the store.
   * @returns the entries, capability ascending.
   */
  capabilities(): readonly CapabilityEntry[] {
    const rows = [...this.requireCapabilities().entries()].map(([, entry]) => structuredClone(entry))
    rows.sort((left, right) => left.capability.localeCompare(right.capability))
    return rows
  }

  /**
   * Rank every capability weakest first: lower pass rate, then thinner
   * evidence, then fewer covering skills, then the capability name.
   * @returns the frontier gaps, weakest first.
   */
  gaps(): readonly FrontierGap[] {
    const entries = [...this.requireCapabilities().entries()].map(([, entry]) => structuredClone(entry))
    return frontierGaps(entries)
  }

  /**
   * The capability to learn next: the weakest gap, or null with no entries.
   * @returns the weakest gap, or null when empty.
   */
  nextToLearn(): FrontierGap | null {
    const entries = [...this.requireCapabilities().entries()].map(([, entry]) => structuredClone(entry))
    return weakestFirst(entries)
  }

  private requireModels(): KvTable<string, SelfModel> {
    if (this.modelTable === undefined) throw new Error('evolution self-model store is not started yet')
    return this.modelTable
  }

  private requireCapabilities(): KvTable<string, CapabilityEntry> {
    if (this.capabilityTable === undefined) throw new Error('evolution self-model store is not started yet')
    return this.capabilityTable
  }
}

export default EvolutionSelfModel

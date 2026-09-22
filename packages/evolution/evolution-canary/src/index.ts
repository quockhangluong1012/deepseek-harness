/**
 * Shadow/canary deployment tracking (`ctx.evolutionCanary`): a durable
 * rollout-state store over staged skill patches (§18, §51). Every staged
 * optimizer write enters in `shadow` through the optional recorder seam —
 * recorded, never gated: nothing changes user-visible behavior. Operators then
 * roll a shadow patch to `canary` and `promoted` through /canary, or exit a
 * staged rollout to `rejected` or `rolled-back`; terminal states never leave.
 * The same package carries §49's risk model (`assessRisk`): the pure
 * class-and-route decision the actuator's rollout monitor consults before it
 * promotes anything. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-canary
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { canaryDomainSpec } from './spec.ts'
import { DEPLOYMENT_STATES, transitionAllowed } from './stages.ts'
import type { DeploymentInput, DeploymentRecord, DeploymentState } from './types.ts'

export type * from './types.ts'
export type * from './risk.ts'
export { DEPLOYMENT_STATES, nextStage, transitionAllowed } from './stages.ts'
export { assessRisk } from './risk.ts'
export { canaryDomainSpec, deploymentRecordRow } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable rollout states of staged skill patches. */
    evolutionCanary: EvolutionCanary
  }
}

/** A deployment summary: per-state counts, optionally scoped. */
export interface DeploymentSummary {
  /** Total deployments in the summary scope. */
  total: number
  /** Deployments per state, ladder first then exits; zeros never omitted. */
  byState: Record<DeploymentState, number>
}

/**
 * Canary deployment store over durable rollout records. Opens the
 * `evolution_canary` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionCanary extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, DeploymentRecord>

  /**
   * @param ctx - host context carrying the storage domain.
   */
  constructor(ctx: Context) {
    super(ctx, 'evolutionCanary')
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(canaryDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-canary.domainClose')
    this.table = domain.table('deployments')
  }

  /**
   * Record one deployment entering shadow. Each staged write starts exactly
   * one deployment, so an existing id rejects loudly instead of silently
   * re-entering shadow.
   * @param input - the deployment to record.
   * @returns the stored record.
   */
  async enter(input: DeploymentInput): Promise<DeploymentRecord> {
    const table = this.requireTable()
    if (table.get(input.id) !== undefined) {
      throw new Error(`evolution-canary: deployment '${input.id}' already exists`)
    }
    const now = new Date().toISOString()
    const record: DeploymentRecord = {
      id: input.id,
      skill: input.skill,
      state: 'shadow',
      triple: input.triple === null ? null : { ...input.triple },
      at: now,
      enteredAt: now,
      decidedAt: null,
    }
    await table.put(record.id, record)
    return structuredClone(record)
  }

  /**
   * Move one deployment to another state. The ladder advances one step per
   * call, each staged rollout may exit to its terminal state, a same-state
   * call resolves without writing, and terminal states never leave. Unknown
   * ids and illegal transitions reject loudly.
   * @param id - deployment identity.
   * @param to - requested state.
   * @returns the stored record after the transition.
   */
  async advance(id: string, to: DeploymentState): Promise<DeploymentRecord> {
    const table = this.requireTable()
    const current = table.get(id)
    if (current === undefined) throw new Error(`evolution-canary: unknown deployment '${id}'`)
    if (current.state === to) return structuredClone(current)
    if (!transitionAllowed(current.state, to)) {
      throw new Error(`evolution-canary: illegal transition ${current.state} → ${to} for '${id}'`)
    }
    const now = new Date().toISOString()
    const terminal = to === 'promoted' || to === 'rolled-back' || to === 'rejected'
    const next: DeploymentRecord = {
      ...current,
      state: to,
      at: now,
      decidedAt: terminal ? now : current.decidedAt,
    }
    await table.put(id, next)
    return structuredClone(next)
  }

  /**
   * List every deployment, optionally filtered by state and skill, newest
   * first in the ladder order then by `at`.
   * @param state - optional state filter.
   * @param skill - optional skill filter.
   * @returns the records, detached from the store.
   */
  deployments(state?: DeploymentState, skill?: string): readonly DeploymentRecord[] {
    const rows = [...this.requireTable().entries()]
      .map(([, record]) => structuredClone(record))
      .filter(record =>
        (state === undefined || record.state === state)
        && (skill === undefined || record.skill === skill))
    rows.sort((left, right) =>
      DEPLOYMENT_STATES.indexOf(left.state) - DEPLOYMENT_STATES.indexOf(right.state)
      || right.at.localeCompare(left.at))
    return rows
  }

  /**
   * Summarize deployments, optionally for one skill: the total and per-state
   * counts with every state present, so absent states read as zero.
   * @param skill - optional skill filter; omitted summarizes the whole store.
   * @returns the summary.
   */
  summary(skill?: string): DeploymentSummary {
    const rows = this.deployments(undefined, skill)
    const byState = Object.fromEntries(DEPLOYMENT_STATES.map(state => [state, 0])) as Record<DeploymentState, number>
    for (const record of rows) byState[record.state] += 1
    return { total: rows.length, byState }
  }

  private requireTable(): KvTable<string, DeploymentRecord> {
    if (this.table === undefined) throw new Error('evolution canary is not started yet')
    return this.table
  }
}

export default EvolutionCanary

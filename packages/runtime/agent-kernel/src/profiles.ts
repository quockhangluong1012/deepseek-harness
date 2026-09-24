/**
 * The agent-profile registry: the roles one deployment defines, resolved by the
 * name a task contract records.
 *
 * A profile narrows what an agent may do. The permission document decides what
 * the deployment permits; the profile decides what the role is for, and an
 * action outside the role's capability grant is refused even when a rule would
 * allow it. Registering the same id twice replaces the earlier profile, so a
 * deployment can refine a role from a later configuration layer.
 *
 * @module @deepseek-ai/dsh-agent-kernel/profiles
 */

import type { AgentProfile, AgentProfileRegistry } from './types.ts'

/** The registry `ctx.agentKernel.profiles` names. */
export class KernelProfileRegistry implements AgentProfileRegistry {
  /** Registered profiles by id, in registration order. */
  private readonly profiles = new Map<string, AgentProfile>()

  /**
   * Register one role.
   * @param profile - the profile; an empty id is a configuration defect and fails loud.
   * @returns a disposer that removes this registration while it is still current.
   * @throws When the profile id is empty.
   */
  register(profile: AgentProfile): () => void {
    if (profile.id === '') throw new Error('agent-kernel: an agent profile needs a nonempty id')
    this.profiles.set(profile.id, profile)
    return () => {
      if (this.profiles.get(profile.id) === profile) this.profiles.delete(profile.id)
    }
  }

  /**
   * Resolve one role by the name a task records.
   * @param id - the profile id.
   * @returns the profile, or undefined when this deployment registered none.
   */
  resolve(id: string): AgentProfile | undefined {
    return this.profiles.get(id)
  }

  /** Every registered profile, in registration order. */
  get list(): readonly AgentProfile[] {
    return [...this.profiles.values()]
  }
}

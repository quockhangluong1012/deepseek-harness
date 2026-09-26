/**
 * The declarative preset row: one analyst profile declared over the
 * agent-preset seam. A composition inserts one row per profile it offers, and
 * the row registers the profile's preset, whose persona row carries the
 * contract prompt. Removing the row retires that preset.
 * @module @deepseek-ai/dsh-analyst-profiles/preset
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { getProfile, profilePreset } from './profiles.ts'

/** Cordis plugin name. */
export const name = 'analyst-profile-preset'

/** The preset registry this row declares into. */
export const inject = ['agentPresets']

/** Plugin config: which declared profile this row offers as a preset. */
export interface Config {
  /** Profile id to declare; an undeclared id rejects at load, naming the declared ids. */
  profile: string
}

/** Runtime schema for the analyst preset row. */
export const Config: z<Config> = z.object({
  profile: z.string().required(),
})

/**
 * Register this profile's preset declaration and return its unregister disposer.
 * @param ctx - the declaring context, which must reach `ctx.agentPresets`.
 * @param config - the profile id this row declares.
 * @returns The registry's unregister function, which Cordis runs when the row unloads.
 * @throws When no declared profile matches `config.profile`.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  return await ctx.agentPresets.register(profilePreset(getProfile(config.profile)))
}

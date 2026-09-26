/**
 * Real Loader composition: the package's two published rows are declared in a
 * test-only `cordis.yml`, so the preset seam, the profile prompt the preset
 * installs, and the row's disposal are exercised as a deployment composes them.
 */

import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as Persona from '@deepseek-ai/dsh-persona'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { expect, it, onTestFinished } from 'vitest'
import AnalystProfiles from '../src/index.ts'
import * as presetRow from '../src/preset.ts'
import { getProfile, profilePrompt } from '../src/profiles.ts'

const DEPLOYMENT_PERSONA = 'You are the deployment agent.'
const advocate = getProfile('devil-advocate')
const ict = getProfile('ict-analyst')

/** A loader stub carrying the modules a fixture row may import; `EntryTree.import` reads only `import`. */
function moduleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoader {
  return Object.assign(Object.create(null) as ModuleLoader, {
    version: 'v2' as const,
    import: async (specifier: string) => {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`Unexpected Loader import: ${specifier}`)
      return module
    },
  })
}

/** Boot the test-only composition through the Loader's include row. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = moduleLoader(new Map<string, unknown>([
    ['@deepseek-ai/dsh-analyst-profiles', AnalystProfiles],
    ['@deepseek-ai/dsh-analyst-profiles/preset', presetRow],
    ['@deepseek-ai/dsh-persona', Persona],
  ]))
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: DEPLOYMENT_PERSONA })
  await ctx.plugin(AgentPresets, { default: advocate.id })
  await ctx.loader.create({ name: 'cordis:include', config: { path: './presets.yml' } })
  await ctx.loader.await()
  return ctx
}

/** The persona prefix one preset's scope assembles, or undefined when it contributes none. */
async function personaPrefix(ctx: Context, presetId: string): Promise<string | undefined> {
  await using lease = await ctx.agentPresets.acquireScope(presetId)
  const assembly = await ctx.systemPrompt.assemble({ scope: lease.key })
  return assembly.sections.find(section => section.name === PERSONA_PREFIX_SECTION)?.text
}

it('declares the profile preset the composition configured, with the contract as its persona', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())

  const roster = await ctx.agentPresets.list()
  expect(roster.map(row => row.id)).toEqual([advocate.id])
  expect(roster[0]).toMatchObject({ name: advocate.title, description: advocate.description })
  expect(roster[0]?.broken).toBeUndefined()
  expect(ctx.analystProfiles.list()).toEqual([ict.id, advocate.id])

  expect(await personaPrefix(ctx, advocate.id)).toBe(profilePrompt(advocate))
  const deployment = await ctx.systemPrompt.assemble()
  expect(deployment.sections.find(section => section.name === PERSONA_PREFIX_SECTION)?.text).toBe(DEPLOYMENT_PERSONA)

  expect(ctx.analystProfiles.validate(advocate.id, {
    profile: advocate.id,
    confidence: 0.6,
    sections: advocate.sections.map(section => ({
      heading: section.heading,
      claims: [{ statement: `${section.heading} holds`, basis: section.basis }],
    })),
  })).toEqual({ ok: true })
})

it('adds and removes a profile preset when its declaring row loads and unloads', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())

  const fiber = await ctx.plugin(presetRow, { profile: ict.id })
  expect((await ctx.agentPresets.list()).map(row => row.id).sort()).toEqual([advocate.id, ict.id])
  expect(await personaPrefix(ctx, ict.id)).toBe(profilePrompt(ict))

  await fiber.dispose()
  expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual([advocate.id])
  await expect(ctx.agentPresets.acquireScope(ict.id)).rejects.toThrow(`Unknown agent preset: ${ict.id}`)
})

it('rejects a row naming no declared profile, declaring no preset', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())

  await expect(ctx.plugin(presetRow, { profile: 'ict-analysts' }))
    .rejects.toThrow('Unknown analyst profile "ict-analysts"; declared profiles: ict-analyst, devil-advocate')
  expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual([advocate.id])
})

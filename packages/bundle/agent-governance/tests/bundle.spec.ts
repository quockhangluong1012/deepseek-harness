/**
 * The bundle's substance is its patch file plus the composition it claims: the
 * manifest must name a real, parseable patch list, and the rows it lists must
 * mount through Cordis — a composed kernel with the built-in declarations its
 * policy needs, and a guard listening on the tool pipeline.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import { BUILTIN_DECLARATIONS } from '@deepseek-ai/dsh-agent-kernel-builtins'
import { apply as applyGuard, Config as GuardConfig } from '@deepseek-ai/dsh-prompt-injection'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** The rows this bundle inserts, in declaration order. */
function rows(): { id?: string; name?: string; config?: Record<string, unknown> }[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'), { schema: entryListSchema })
  expect(Array.isArray(parsed)).toBe(true)
  const inserted = (parsed as { insert?: { id?: string; name?: string; config?: Record<string, unknown> }[] }[])
    .flatMap(patch => patch.insert ?? [])
  for (const row of inserted) expect(manifest.dependencies).toHaveProperty(row.name!)
  return inserted
}

describe('dsh-agent-governance bundle', () => {
  it('declares the control plane as one parseable patch list, every row resolved by a dependency', () => {
    const inserted = rows()

    expect(inserted.map(row => row.id)).toEqual(['agent-kernel', 'agent-kernel-builtins', 'tool-evidence', 'prompt-injection'])
    expect(inserted.every(row => row.config?.['mode'] === undefined || row.config['mode'] === 'shadow')).toBe(true)
    expect(inserted.find(row => row.id === 'agent-kernel')?.config).toEqual({ mode: 'shadow' })
    expect(inserted.find(row => row.id === 'prompt-injection')?.config).toEqual({ mode: 'shadow' })
  })

  it('composes a kernel whose policy can evaluate shipped tools, and a guard on the tool pipeline', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    // The bundle's rows, mounted as a profile would mount them.
    await ctx.plugin(AgentKernel, { mode: 'shadow' })
    await ctx.plugin({ name: 'agent-kernel-builtins', apply: (inner: Context) => {
      const disposers = BUILTIN_DECLARATIONS.map(declaration => inner.agentKernel.capabilities.register(declaration))
      inner.effect(() => () => { for (const dispose of disposers) dispose() }, 'test.builtins')
    }, inject: ['agentKernel'] })
    await ctx.plugin({ name: 'prompt-injection', apply: applyGuard, inject: ['tools'] }, GuardConfig({ mode: 'shadow' }))

    expect(ctx.agentKernel.capabilities.resolve('bash', { command: 'git status' })).toEqual([
      { capability: 'process.exec', resource: 'git status' },
    ])
    expect(ctx.agentKernel.capabilities.size).toBe(BUILTIN_DECLARATIONS.length)
  })
})

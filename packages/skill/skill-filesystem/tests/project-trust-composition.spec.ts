/**
 * Project trust through a real profile: an accepted answer is written into the
 * profile patch and reloads as configuration on the next start.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

/** The live Agent identity the provider must attribute the question to. */
const AGENT = { id: 'trust-agent' }

let home: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

/** Import mapped source modules without claiming support for Node's HMR internals. */
function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

/**
 * Boot the profile that mounts the skill registry and this provider.
 * @param reuseHome - existing installation to restart from, or `undefined` for a fresh one.
 * @param withInitiator - whether a live Initiator answers; a restarted run has none.
 * @returns the booted context and its profile patch path.
 */
async function bootProfile(reuseHome: string | undefined, withInitiator: boolean): Promise<{ ctx: Context; patchPath: string }> {
  home = reuseHome ?? await mkdtemp(join(tmpdir(), 'dsh-skill-trust-'))
  const install = home
  const rowsPath = join(install, 'rows.patch.yml')
  await writeFile(rowsPath, [
    '- id: skill',
    "  name: '@deepseek-ai/dsh-skill'",
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    `    dshHome: ${JSON.stringify(join(install, '.dsh'))}`,
    `    agentsHome: ${JSON.stringify(join(install, '.agents'))}`,
    `    claudeHome: ${JSON.stringify(join(install, '.claude'))}`,
    '    watch: false',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(install).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-skill-filesystem', SkillFileSystem],
  ])
  await Promise.all([...modules.keys()].map(async (packageName) => {
    const packageDir = join(install, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.1.0', type: 'module' })}\n`)
  }))
  ctx.loader.internal = sourceModuleLoader(async (specifier) => {
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  })
  const patchPath = await profileComposition(ctx, install, rowsPath)
  await ctx.plugin(UserQuestions)
  ctx.provide('agents', {
    currentInitiator: () => withInitiator ? AGENT : undefined,
    get: (id: string) => id === AGENT.id ? AGENT : undefined,
    roots: () => [AGENT],
  } as never)
  return { ctx, patchPath }
}

describe('project trust through a real profile', () => {
  it('records an accepted answer in the profile patch, which reloads as configured trust', async () => {
    const project = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-trust-project-')))
    try {
      await mkdir(join(project, '.git'), { recursive: true })
      await mkdir(join(project, '.dsh/skills/trusted-skill'), { recursive: true })
      await writeFile(
        join(project, '.dsh/skills/trusted-skill/SKILL.md'),
        '---\nname: trusted-skill\ndescription: Trusted project skill\n---\n\nBody.\n',
      )

      const first = await bootProfile(undefined, true)
      first.ctx.on('user-questions/request', (request) => {
        const question = request.questions[0]
        if (question === undefined) throw new Error('expected one question')
        expect(question.question).toBe('Trust this folder?')
        return Promise.resolve({ answers: [{ id: question.id, selected: ['Trust this folder'] }] })
      })
      expect((await first.ctx.skills.list({ cwd: project })).map(skill => skill.name)).toEqual(['trusted-skill'])

      // Durable: the accepted answer reaches this plugin's own config row.
      const rows = parse(await readFile(first.patchPath, 'utf8')) as Array<{
        id?: string
        config?: { trustedProjectDirs?: string[] }
      }>
      expect(rows.find(row => row.id === 'skill-filesystem')?.config?.trustedProjectDirs).toEqual([project])

      // Restart: the same installation, no initiator and no answerer.
      await first.ctx.fiber.dispose()
      const restarted = await bootProfile(home, false)
      expect((await restarted.ctx.skills.list({ cwd: project })).map(skill => skill.name)).toEqual(['trusted-skill'])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

/** Project-trust question: the human answer decides whether project skills load. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '../src/index.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`)
}

/** One user-question request as this provider issues it. */
interface RecordedQuestion {
  questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }>
  agent?: unknown
}

/** The live Agent identity the provider must attribute the question to. */
const AGENT = { id: 'trust-agent' }

/** Answerer stub: records every request and selects one option label. */
function answerWith(label: string): { requests: RecordedQuestion[]; ask: (request: RecordedQuestion) => Promise<unknown> } {
  const requests: RecordedQuestion[] = []
  return {
    requests,
    ask: async (request) => {
      requests.push(request)
      const question = request.questions[0]
      if (question === undefined) throw new Error('expected one question')
      return { answers: [{ id: question.id, selected: [label] }] }
    },
  }
}

/**
 * Mount the provider over one home, with an untrusted project root holding one
 * project skill, and return the context plus the direct provider.
 */
async function setupTrust(home: string, project: string): Promise<{
  ctx: Context
  list: () => Promise<string[]>
}> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    claudeHome: join(home, '.claude'),
    watch: false,
  })
  let provider!: SkillFileSystem.FileSystemSkillProvider
  ctx.skills.registerProvider((control) => {
    provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, SkillFileSystem.Config({
      providerName: 'trust-subject',
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      claudeHome: join(home, '.claude'),
      watch: false,
    }))
    return provider
  })
  return {
    ctx,
    list: async () => {
      const found = await provider.list({ cwd: project })
      return (Array.isArray(found) ? found : found.candidates).map(candidate => candidate.name)
    },
  }
}

describe('project trust question', () => {
  it('loads project skills after the human trusts the folder, asking once per root', async () => {
    const home = await tempDir('trust-home')
    const project = await tempDir('trust-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill')
    const { ctx, list } = await setupTrust(home, project)
    const answerer = answerWith('Trust this folder')
    ctx.provide('userQuestions', { ask: answerer.ask } as never)
    ctx.provide('agents', { currentInitiator: () => AGENT } as never)

    expect(await list()).toEqual(['project-skill'])
    expect(await list()).toEqual(['project-skill'])
    expect(answerer.requests).toHaveLength(1)
    expect(answerer.requests[0]?.agent).toBe(AGENT)
    expect(answerer.requests[0]?.questions[0]?.id).toBe('project-skills-trust')
    expect(answerer.requests[0]?.questions[0]?.question).toBe('Trust this folder?')
    expect(answerer.requests[0]?.questions[0]?.options?.map(option => option.label))
      .toEqual(['Trust this folder', 'Skip'])
  })

  it('keeps project skills unloaded when the human declines', async () => {
    const home = await tempDir('decline-home')
    const project = await tempDir('decline-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill')
    const { ctx, list } = await setupTrust(home, project)
    const answerer = answerWith('Skip')
    ctx.provide('userQuestions', { ask: answerer.ask } as never)
    ctx.provide('agents', { currentInitiator: () => AGENT } as never)

    expect(await list()).toEqual([])
    expect(await list()).toEqual([])
    expect(answerer.requests).toHaveLength(1)
  })

  it('keeps project skills unloaded without an answerer and records why', async () => {
    const home = await tempDir('no-answerer-home')
    const project = await tempDir('no-answerer-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill')
    const { ctx, list } = await setupTrust(home, project)
    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      expect(await list()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no answerer is available to ask for trust'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps project skills unloaded when only an agent is absent', async () => {
    const home = await tempDir('no-agent-home')
    const project = await tempDir('no-agent-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill')
    const { ctx, list } = await setupTrust(home, project)
    const answerer = answerWith('Trust this folder')
    ctx.provide('userQuestions', { ask: answerer.ask } as never)

    expect(await list()).toEqual([])
    expect(answerer.requests).toEqual([])
  })

  it('applies an accepted root for the session when no profile entry can record it', async () => {
    const home = await tempDir('no-entry-home')
    const project = await tempDir('no-entry-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill')
    const { ctx, list } = await setupTrust(home, project)
    const answerer = answerWith('Trust this folder')
    ctx.provide('userQuestions', { ask: answerer.ask } as never)
    ctx.provide('agents', { currentInitiator: () => AGENT } as never)
    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      // A directly constructed context has no Loader entry, so no settings
      // namespace exists: the answer still applies and its durability is logged.
      expect(await list()).toEqual(['project-skill'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('for this session only'))
    } finally {
      warn.mockRestore()
    }
  })

  it('treats a custom answer as no grant and keeps the fail-closed skip', async () => {
    const home = await tempDir('custom-home')
    const project = await tempDir('custom-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill')
    const { ctx, list } = await setupTrust(home, project)
    ctx.provide('userQuestions', {
      ask: async () => ({ answers: [{ id: 'project-skills-trust', selected: [], custom: 'later' }] }),
    } as never)
    ctx.provide('agents', { currentInitiator: () => AGENT } as never)

    expect(await list()).toEqual([])
  })

  it('keeps the fail-closed skip when the question cannot be delivered', async () => {
    const home = await tempDir('undeliverable-home')
    const project = await tempDir('undeliverable-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill')
    const { ctx, list } = await setupTrust(home, project)
    ctx.provide('userQuestions', {
      ask: async () => { throw new Error('no user-questions answerer accepted the request') },
    } as never)
    ctx.provide('agents', { currentInitiator: () => AGENT } as never)
    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      expect(await list()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the trust question went unanswered'))
    } finally {
      warn.mockRestore()
    }
  })
})

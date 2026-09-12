import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expandSkillTemplates, skillDirForSkillPath } from '../src/template.ts'

const testToolSignal = new AbortController().signal

let previousDshHome: string | undefined
let isolatedHome = ''

beforeAll(async () => {
  previousDshHome = process.env['DSH_HOME']
  isolatedHome = await mkdtemp(join(tmpdir(), 'dsh-tool-skill-template-'))
  process.env['DSH_HOME'] = isolatedHome
})

afterAll(async () => {
  if (previousDshHome === undefined) {
    delete process.env['DSH_HOME']
  } else {
    process.env['DSH_HOME'] = previousDshHome
  }
  await rm(isolatedHome, { recursive: true, force: true })
})

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(home: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkill, {})
  return ctx
}

function sessionAgent(session: Session, id = 'tool-skill-template-agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('template test must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function agentWithSession(sessionId: string, cwd: string): Agent {
  const id = SessionId(sessionId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  return sessionAgent(session, `${sessionId}-agent`)
}

function textOf(message: UserMessage): string {
  const block = message.content[0]
  if (block?.type !== 'text') throw new Error('expected text message content')
  return block.text
}

describe('expandSkillTemplates', () => {
  it('leaves content without variables unchanged', () => {
    expect(expandSkillTemplates('plain instructions', {})).toBe('plain instructions')
  })

  it('expands both variables when values exist', () => {
    expect(expandSkillTemplates('dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}', {
      skillDir: '/skills/demo',
      sessionId: 'session-1',
    })).toBe('dir=/skills/demo session=session-1')
  })

  it('leaves the skill directory verbatim when the skill has no path', () => {
    expect(expandSkillTemplates('dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}', {
      sessionId: 'session-1',
    })).toBe('dir=${DSH_SKILL_DIR} session=session-1')
  })

  it('leaves the session id verbatim when no agent loads the skill', () => {
    expect(expandSkillTemplates('dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}', {
      skillDir: '/skills/demo',
    })).toBe('dir=/skills/demo session=${DSH_SESSION_ID}')
  })

  it('leaves both variables verbatim when both values are absent', () => {
    expect(expandSkillTemplates('dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}', {})).toBe(
      'dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}',
    )
  })

  it('leaves explicit undefined values verbatim', () => {
    expect(expandSkillTemplates('${DSH_SKILL_DIR}/${DSH_SESSION_ID}', {
      skillDir: undefined,
      sessionId: undefined,
    })).toBe('${DSH_SKILL_DIR}/${DSH_SESSION_ID}')
  })

  it('leaves any other placeholder verbatim beside known variables', () => {
    expect(expandSkillTemplates('${OTHER} ${DSH_SKILL_DIR_EXTRA} ${} ${DSH_SESSION_ID_SUFFIX} ${DSH_SKILL_DIR}', {
      skillDir: '/skills/demo',
      sessionId: 'session-1',
    })).toBe('${OTHER} ${DSH_SKILL_DIR_EXTRA} ${} ${DSH_SESSION_ID_SUFFIX} /skills/demo')
  })

  it('expands every occurrence of a repeated variable', () => {
    expect(expandSkillTemplates('${DSH_SESSION_ID} and ${DSH_SESSION_ID}', {
      sessionId: 'session-1',
    })).toBe('session-1 and session-1')
  })
})

describe('skillDirForSkillPath', () => {
  it('derives the skill directory from an absolute SKILL.md path', () => {
    const home = resolve(tmpdir(), 'dsh-skill-dir-check')
    expect(skillDirForSkillPath(resolve(home, 'demo', 'SKILL.md'))).toBe(resolve(home, 'demo'))
  })

  it('returns undefined for virtual skills without a path', () => {
    expect(skillDirForSkillPath(undefined)).toBeUndefined()
  })
})

describe('skill template loading', () => {
  it('expands both variables through the skill tool for a filesystem skill', async () => {
    const home = await tempDir('template-tool-file')
    const skillsRoot = join(home, '.dsh/skills')
    await writeSkill(skillsRoot, 'tpl-skill', 'Template skill', 'dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID} other=${OTHER}')
    const ctx = await setup(home)
    const agent = agentWithSession('tpl-session-1', home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('tpl-file'),
      name: 'skill',
      arguments: { name: 'tpl-skill' },
      agent,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    const loaded = await ctx.skills.get('tpl-skill', { cwd: home })
    if (loaded?.path === undefined) throw new Error('expected filesystem skill path')
    const expectedDir = dirname(loaded.path)
    const value = result.value as { content?: unknown }
    expect(value.content).toBe(`dir=${expectedDir} session=tpl-session-1 other=\${OTHER}`)
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text tool result')
    expect(block.text).toContain(`dir=${expectedDir} session=tpl-session-1 other=\${OTHER}`)
    expect(block.text).toContain('<skill_instructions>')
  })

  it('leaves the skill directory verbatim for a virtual skill through the skill tool', async () => {
    const home = await tempDir('template-tool-virtual')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'virtual-skill',
      description: 'Virtual skill',
      source: 'runtime',
      content: 'dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}',
    })
    const agent = agentWithSession('tpl-session-2', home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('tpl-virtual'),
      name: 'skill',
      arguments: { name: 'virtual-skill' },
      agent,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    const value = result.value as { content?: unknown }
    expect(value.content).toBe('dir=${DSH_SKILL_DIR} session=tpl-session-2')
  })

  it('leaves the session id verbatim without a loading agent through the skill tool', async () => {
    const home = await tempDir('template-tool-no-agent')
    const skillsRoot = join(home, '.dsh/skills')
    await writeSkill(skillsRoot, 'no-agent-skill', 'No agent skill', 'dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}')
    const ctx = await setup(home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('tpl-no-agent'),
      name: 'skill',
      arguments: { name: 'no-agent-skill' },
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    const loaded = await ctx.skills.get('no-agent-skill', { cwd: home })
    if (loaded?.path === undefined) throw new Error('expected filesystem skill path')
    const expectedDir = dirname(loaded.path)
    const value = result.value as { content?: unknown }
    expect(value.content).toBe(`dir=${expectedDir} session=\${DSH_SESSION_ID}`)
  })

  it('expands both variables in the user-explicit pre-step injection', async () => {
    const home = await tempDir('template-prestep-file')
    const skillsRoot = join(home, '.agents/skills')
    await writeSkill(skillsRoot, 'prestep-skill', 'Prestep skill', 'dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}')
    const ctx = await setup(home)
    const agent = agentWithSession('tpl-session-3', home)
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: '/prestep-skill go' }], source: { kind: 'user' } }),
    ]

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )

    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injection = decision.messages.find(message => (message.source as { kind?: string }).kind === 'skill-invocation')
    if (injection === undefined) throw new Error('expected skill-invocation injection')
    const loaded = await ctx.skills.get('prestep-skill', { cwd: home })
    if (loaded?.path === undefined) throw new Error('expected filesystem skill path')
    const expectedDir = dirname(loaded.path)
    expect(textOf(injection)).toContain(`dir=${expectedDir} session=tpl-session-3`)
  })

  it('leaves the skill directory verbatim for a virtual skill in the pre-step injection', async () => {
    const home = await tempDir('template-prestep-virtual')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'virtual-prestep',
      description: 'Virtual prestep skill',
      source: 'runtime',
      content: 'dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID}',
    })
    const agent = agentWithSession('tpl-session-4', home)
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: '/virtual-prestep go' }], source: { kind: 'user' } }),
    ]

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )

    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injection = decision.messages.find(message => (message.source as { kind?: string }).kind === 'skill-invocation')
    if (injection === undefined) throw new Error('expected skill-invocation injection')
    expect(textOf(injection)).toContain('dir=${DSH_SKILL_DIR} session=tpl-session-4')
  })
})

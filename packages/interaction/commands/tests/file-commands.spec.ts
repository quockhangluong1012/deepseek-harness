import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as fileCommands from '@deepseek-ai/dsh-commands/file-commands'
import type { Config } from '@deepseek-ai/dsh-commands/file-commands'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Write one fixture tree below a fresh temporary root. */
async function fixtureRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-commands-'))
  created.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return root
}

/** Point every root inside the fixture tree so no test reads the real user home. */
function configFor(root: string, overrides: Partial<Config> = {}): Config {
  return {
    projectDshCommands: join(root, 'project/.dsh/commands'),
    projectClaudeCommands: join(root, 'project/.claude/commands'),
    dshHome: join(root, 'home/.dsh'),
    claudeHome: join(root, 'home/.claude'),
    ...overrides,
  }
}

/** Minimal global tool: the restriction seam validates every named tool against the mounted set. */
function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (): Promise<string> => Promise.resolve(name),
  }
}

/** Mount the services a file command reaches through its agent, without the loader. */
async function mountServices(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  for (const name of ['read', 'grep', 'write']) ctx.tools.register(tool(name))
  await ctx.plugin(CommandRuntime)
  return ctx
}

/** Load the command plane onto an already mounted context. */
async function loadCommands(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(fileCommands, config)
}

/** Mount the services and the loader in one step for tests that inspect no diagnostic. */
async function mount(config: Config): Promise<Context> {
  const ctx = await mountServices()
  await loadCommands(ctx, config)
  return ctx
}

interface CommandAgent {
  agent: Agent
  /** Messages the command submitted to the receiving agent. */
  submitted: UserMessage[]
  /** Let the pending run reach quiescence. */
  finish: () => void
}

/** Mint a scoped agent whose submission and quiescence this test controls. */
async function mountAgent(
  ctx: Context,
  name: string,
  options: { failSubmission?: boolean; rejectIdle?: boolean } = {},
): Promise<CommandAgent> {
  const session = ctx.sessions.create(SessionId(name))
  const subject = { id: session.id } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, subject) },
    { inject: ['systemPrompt', 'tools'] }))
  const submitted: UserMessage[] = []
  // Annotated binding (not `withResolvers<void>()`): no-invalid-void-type
  // rejects the explicit type argument in call position.
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const agent = Object.assign(subject, {
    session,
    ctx: scope.ctx,
    followup(message: UserMessage): void {
      if (options.failSubmission === true) throw new Error('followup failed')
      submitted.push(message)
    },
    whenIdle: () => options.rejectIdle === true ? Promise.reject(new Error('idle failed')) : idle.promise,
  }) as Agent
  return { agent, submitted, finish: () => { idle.resolve() } }
}

/** The single text block one submitted message carries. */
function submittedText(message: UserMessage | undefined): string {
  const block = message?.content[0]
  return block?.type === 'text' ? block.text : ''
}

/** Let the fire-and-forget restriction release run after quiescence. */
function flush(): Promise<void> {
  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(resolve, 0)
  return promise
}

const PROJECT_COMMAND = [
  '---',
  'description: Deploy the service',
  'argument-hint: <environment>',
  'allowed-tools: read, grep',
  '---',
  '',
  'Deploy $ARGUMENTS and report the result.',
  '',
].join('\n')

describe('file-defined commands', () => {
  it('registers a project command with its frontmatter and submits the body', async () => {
    const root = await fixtureRoot({ 'project/.dsh/commands/deploy.md': PROJECT_COMMAND })
    const ctx = await mount(configFor(root))
    const { agent, submitted, finish } = await mountAgent(ctx, 'deploy-agent')

    expect(ctx.commands.list(agent)).toEqual([{
      name: 'deploy',
      description: 'Deploy the service',
      input: { hint: '<environment>' },
    }])
    expect(ctx.commands.find(agent, 'deploy')?.model).toBeUndefined()

    const execution = await ctx.commands.execute(agent, '/deploy staging', [], new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'success',
      text: `Submitted /deploy from ${join(root, 'project/.dsh/commands/deploy.md')}`,
    })
    expect(submittedText(submitted[0])).toBe('Deploy staging and report the result.')
    // The allowlist masks the agent for the run this submission opened.
    expect(ctx.tools.get('write', agent)).toBeUndefined()
    expect(ctx.tools.get('read', agent)).toBeDefined()
    finish()
    await flush()
    expect(ctx.tools.get('write', agent)).toBeDefined()
  })

  it('carries model on the definition and reports unknown frontmatter keys', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/review.md': [
        '---',
        'description: Review a diff',
        'model: mock/reviewer',
        'user-invocable: false',
        '---',
        '',
        'Review the current diff.',
        '',
      ].join('\n'),
    })
    const ctx = await mountServices()
    const { agent } = await mountAgent(ctx, 'review-agent')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await loadCommands(ctx, configFor(root))

    expect(ctx.commands.find(agent, 'review')?.model).toBe('mock/reviewer')
    expect(ctx.commands.list(agent)).toEqual([{ name: 'review', description: 'Review a diff' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('frontmatter key "user-invocable" ignored'))
  })

  it('appends input when the body has no placeholder and leaves an empty invocation bare', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/note.md': '---\ndescription: Note\n---\nRecord the note.\n',
    })
    const ctx = await mount(configFor(root))
    const { agent, submitted } = await mountAgent(ctx, 'note-agent')

    await ctx.commands.execute(agent, '/note  keep this  ', [], new AbortController().signal)
    await ctx.commands.execute(agent, '/note', [], new AbortController().signal)

    expect(submitted.map(submittedText)).toEqual(['Record the note.\n\nkeep this', 'Record the note.'])
  })

  it('prefers the project .dsh root, then project .claude, then the user roots', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/deploy.md': '---\ndescription: project dsh\n---\nbody\n',
      'project/.claude/commands/deploy.md': '---\ndescription: project claude\n---\nbody\n',
      'home/.dsh/commands/deploy.md': '---\ndescription: user dsh\n---\nbody\n',
      'home/.claude/commands/deploy.md': '---\ndescription: user claude\n---\nbody\n',
      'home/.dsh/commands/only-user.md': '---\ndescription: user only\n---\nbody\n',
      'home/.claude/commands/only-claude.md': '---\ndescription: claude only\n---\nbody\n',
    })
    const ctx = await mountServices()
    const { agent } = await mountAgent(ctx, 'precedence-agent')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await loadCommands(ctx, configFor(root))

    expect(ctx.commands.list(agent)).toEqual([
      { name: 'deploy', description: 'project dsh' },
      { name: 'only-claude', description: 'claude only' },
      { name: 'only-user', description: 'user only' },
    ])
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('ignored: "deploy" is already provided by'),
      expect.stringContaining('ignored: "deploy" is already provided by'),
      expect.stringContaining('ignored: "deploy" is already provided by'),
    ])
  })

  it('reads the user .claude root when the project .dsh root is disabled', async () => {
    const root = await fixtureRoot({
      'home/.claude/commands/ship.md': '---\ndescription: Ship it\n---\nbody\n',
    })
    const ctx = await mount(configFor(root, { projectDshCommands: '', claudeHome: join(root, 'home/.claude') }))
    const { agent } = await mountAgent(ctx, 'claude-only-agent')

    expect(ctx.commands.list(agent)).toEqual([{ name: 'ship', description: 'Ship it' }])
  })

  it('accepts an uppercase .MD suffix', async () => {
    const root = await fixtureRoot({ 'project/.dsh/commands/lower.MD': '---\ndescription: lower\n---\nbody\n' })
    const ctx = await mount(configFor(root))
    const { agent } = await mountAgent(ctx, 'upper-agent')

    expect(ctx.commands.list(agent)).toEqual([{ name: 'lower', description: 'lower' }])
  })

  it('ignores every malformed command file with one diagnostic and keeps loading', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/no-frontmatter.md': 'Just a body.\n',
      'project/.dsh/commands/unterminated.md': '---\ndescription: open\n\nbody\n',
      'project/.dsh/commands/bad-yaml.md': '---\ndescription: [unclosed\n---\nbody\n',
      'project/.dsh/commands/sequence.md': '---\n- a\n- b\n---\nbody\n',
      'project/.dsh/commands/empty-body.md': '---\ndescription: empty\n---\n\n',
      'project/.dsh/commands/no-description.md': '---\nargument-hint: <x>\n---\nbody\n',
      'project/.dsh/commands/blank-description.md': '---\ndescription: "  "\n---\nbody\n',
      'project/.dsh/commands/number-description.md': '---\ndescription: 7\n---\nbody\n',
      'project/.dsh/commands/number-hint.md': '---\ndescription: hint\nargument-hint: 42\n---\nbody\n',
      'project/.dsh/commands/mapped-tools.md': '---\ndescription: tools\nallowed-tools:\n  read: yes\n---\nbody\n',
      'project/.dsh/commands/number-model.md': '---\ndescription: model\nmodel: 7\n---\nbody\n',
      'project/.dsh/commands/Bad-Name.md': '---\ndescription: bad name\n---\nbody\n',
      'project/.dsh/commands/good.md': '---\ndescription: still loaded\n---\nbody\n',
    })
    const ctx = await mountServices()
    const { agent } = await mountAgent(ctx, 'malformed-agent')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await loadCommands(ctx, configFor(root))

    expect(ctx.commands.list(agent)).toEqual([{ name: 'good', description: 'still loaded' }])
    const warned = warn.mock.calls.map(([line]) => String(line))
    expect(warned).toHaveLength(12)
    expect(warned.some(line => line.includes('no-frontmatter.md ignored: missing YAML frontmatter'))).toBe(true)
    expect(warned.some(line => line.includes('unterminated.md ignored: missing YAML frontmatter'))).toBe(true)
    expect(warned.some(line => line.includes('bad-yaml.md ignored: invalid YAML frontmatter'))).toBe(true)
    expect(warned.some(line => line.includes('sequence.md ignored: missing YAML frontmatter'))).toBe(true)
    expect(warned.some(line => line.includes('empty-body.md ignored: the command body is empty'))).toBe(true)
    expect(warned.some(line => line.includes('no-description.md ignored: frontmatter requires a non-empty description'))).toBe(true)
    expect(warned.some(line => line.includes('blank-description.md ignored: frontmatter requires a non-empty description'))).toBe(true)
    expect(warned.some(line => line.includes('number-description.md ignored: frontmatter requires a non-empty description'))).toBe(true)
    expect(warned.some(line => line.includes('number-hint.md ignored: argument-hint must be a non-empty string'))).toBe(true)
    expect(warned.some(line => line.includes('mapped-tools.md ignored: allowed-tools must be a non-empty list of tool names or a comma-separated string'))).toBe(true)
    expect(warned.some(line => line.includes('number-model.md ignored: model must be a non-empty string'))).toBe(true)
    expect(warned.some(line => line.includes('Bad-Name.md ignored: TypeError: command name "Bad-Name" must match'))).toBe(true)
  })

  it('accepts a YAML sequence for allowed-tools and masks the named tools', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/tools.md': '---\ndescription: tools\nallowed-tools:\n  - read\n  - read\n  - write\n---\nbody\n',
    })
    const ctx = await mount(configFor(root))
    const { agent, finish } = await mountAgent(ctx, 'sequence-tools-agent')

    await ctx.commands.execute(agent, '/tools', [], new AbortController().signal)
    expect(ctx.tools.get('grep', agent)).toBeUndefined()
    expect(ctx.tools.get('write', agent)).toBeDefined()
    finish()
    await flush()
    expect(ctx.tools.get('grep', agent)).toBeDefined()
  })

  it('fails the invocation when allowed-tools names a tool that is not mounted', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/ghost.md': '---\ndescription: ghost\nallowed-tools: nowhere\n---\nbody\n',
    })
    const ctx = await mount(configFor(root))
    const { agent, submitted } = await mountAgent(ctx, 'ghost-tool-agent')

    const execution = await ctx.commands.execute(agent, '/ghost', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.kind === 'error' ? execution.result.text : '').toContain('unknown global tool "nowhere"')
    expect(submitted).toEqual([])
  })

  it('releases the mask through the rejection path of quiescence', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/masked.md': '---\ndescription: masked\nallowed-tools: read\n---\nbody\n',
    })
    const ctx = await mount(configFor(root))
    const { agent } = await mountAgent(ctx, 'rejecting-idle-agent', { rejectIdle: true })

    await ctx.commands.execute(agent, '/masked', [], new AbortController().signal)
    await flush()
    expect(ctx.tools.get('write', agent)).toBeDefined()
  })

  it('reports a submission failure and still releases the mask at quiescence', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/doomed.md': '---\ndescription: doomed\nallowed-tools: read\n---\nbody\n',
    })
    const ctx = await mount(configFor(root))
    const { agent, finish } = await mountAgent(ctx, 'failing-submission-agent', { failSubmission: true })

    await expect(ctx.commands.execute(agent, '/doomed', [], new AbortController().signal))
      .rejects.toThrow('followup failed')
    expect(ctx.tools.get('write', agent)).toBeUndefined()
    finish()
    await flush()
    expect(ctx.tools.get('write', agent)).toBeDefined()
  })

  it('skips oversized files while loading a file exactly at the cap', async () => {
    const exact = '---\ndescription: exact\n---\n012345\n'
    const root = await fixtureRoot({
      'project/.dsh/commands/large.md': '---\ndescription: large\n---\n0123456789\n',
      'project/.dsh/commands/exact.md': exact,
    })
    const ctx = await mountServices()
    const { agent } = await mountAgent(ctx, 'cap-agent')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await loadCommands(ctx, configFor(root, { maxCommandBytes: Buffer.byteLength(exact) }))

    expect(ctx.commands.list(agent)).toEqual([{ name: 'exact', description: 'exact' }])
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('large.md ignored:'),
    ])
  })

  it('skips a directory named like a command file and ignores unrelated files', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/nested.md/inside.txt': 'not a command',
      'project/.dsh/commands/notes.txt': 'not a command',
      'project/.dsh/commands/README': 'not a command',
    })
    const ctx = await mountServices()
    const { agent } = await mountAgent(ctx, 'entries-agent')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await loadCommands(ctx, configFor(root))

    expect(ctx.commands.list(agent)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves absent roots silent and rejects a non-positive byte cap', async () => {
    const root = await fixtureRoot({})
    const ctx = await mountServices()
    const { agent } = await mountAgent(ctx, 'absent-agent')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await loadCommands(ctx, configFor(root))

    expect(ctx.commands.list(agent)).toEqual([])
    expect(warn).not.toHaveBeenCalled()

    const bare = new Context()
    await bare.plugin(SessionStore)
    await bare.plugin(CommandRuntime)
    // The schema rejects a non-positive cap at load; a direct apply call keeps its own guard.
    await expect(bare.plugin(fileCommands, { maxCommandBytes: 0 }))
      .rejects.toThrow('$.maxCommandBytes expected number >= 1 but got 0')
    await expect(fileCommands.apply(bare, { maxCommandBytes: 0 }))
      .rejects.toThrow('maxCommandBytes must be a positive integer')
  })

  it('removes every registration when its plugin fiber disposes', async () => {
    const root = await fixtureRoot({
      'project/.dsh/commands/deploy.md': '---\ndescription: deploy\n---\nbody\n',
    })
    const ctx = await mount(configFor(root, { projectDshCommands: '' }))
    const { agent } = await mountAgent(ctx, 'disposal-agent')
    const fiber = await ctx.plugin(fileCommands, configFor(root))

    expect(ctx.commands.find(agent, 'deploy')).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, 'deploy')).toBeUndefined()
  })
})

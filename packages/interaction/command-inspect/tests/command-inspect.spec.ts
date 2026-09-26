import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import * as commandInspect from '../src/index.ts'

interface Harness {
  readonly ctx: Context
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
  stop(): Promise<void>
}

interface HarnessOptions {
  readonly providers?: readonly { id: string; name: string; models?: number }[]
  readonly tools?: readonly string[]
  readonly sandboxMode?: string
  readonly presets?: readonly { id: string; rows: readonly { moduleName: string }[] }[]
  readonly subagentProviders?: readonly string[]
  readonly children?: readonly { id: string; mode: string; label?: string }[]
  readonly hookBridges?: readonly { name: string; enabled: boolean }[]
  readonly withLoader?: boolean
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  ctx.provide('tools', {
    schemas: () => (options.tools ?? []).map(name => ({ name, description: `${name} tool` })),
  } as never)
  ctx.provide('llm', {
    listProviders: () => [...(options.providers ?? [])].map(({ id, name }) => ({ id, name })),
    listModels: async (provider: string) => {
      const entry = (options.providers ?? []).find(candidate => candidate.id === provider)
      if (entry?.models === undefined) throw new Error('provider dormant')
      return Array.from({ length: entry.models }, (_, index) => ({ id: `${provider}-${String(index)}` }))
    },
  } as never)
  if (options.sandboxMode !== undefined) {
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: options.sandboxMode }) } as never)
  }
  ctx.provide('agentPresets', {
    compositionInventory: async () => [...(options.presets ?? [])].map(preset => ({
      id: preset.id,
      rows: preset.rows.map(row => ({ moduleName: row.moduleName })),
    })),
  } as never)
  ctx.provide('subagents', {
    list: () => [...(options.subagentProviders ?? [])],
    listChildren: async () => [...(options.children ?? [])],
  } as never)
  if (options.withLoader === true) {
    ctx.provide('loader', {
      entries: () => (options.hookBridges ?? []).map((bridge, index) => ({
        id: `hook-${String(index)}`,
        options: { name: bridge.name },
        parent: { tree: { ctx: { baseUrl: undefined } } },
        disabled: !bridge.enabled,
        fiber: undefined,
      })),
    } as never)
  }

  const plugin = await ctx.plugin(commandInspect)
  return { ctx, plugin, stop: () => plugin.dispose() }
}

async function run(test: Harness, line: string): Promise<CommandExecution> {
  const agent = { session: { id: 'caller', header: { cwd: '/workspace' }, append: () => ({}) } }
  const execution = await test.ctx.commands.execute(agent as never, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`${line} was not registered`)
  return execution
}

/** Result text of one command, failing the test when it errored. */
function textOf(execution: CommandExecution): string {
  if (execution.result.kind !== 'success') {
    throw new Error(`expected success, got: ${JSON.stringify(execution.result)}`)
  }
  return execution.result.text ?? ''
}

describe('/help', () => {
  it('lists the commands this session can run with their argument hints', async () => {
    const test = await harness()
    try {
      test.ctx.commands.register({
        name: 'goal',
        description: 'Show the goal',
        input: { hint: '<objective>' },
        handler: () => ({ kind: 'success', text: 'ok' }),
      })

      const text = textOf(await run(test, '/help'))

      expect(text).toContain('- /goal <objective> — Show the goal')
      expect(text).toContain('- /help — List the commands this session can run')
      expect((await run(test, '/help now')).result).toEqual({ kind: 'error', text: 'Usage: /help' })
    } finally {
      await test.stop()
    }
  })
})

describe('/doctor', () => {
  it('reports mounted capabilities and names dormant providers instead of failing', async () => {
    const test = await harness({
      providers: [{ id: 'deepseek', name: 'DeepSeek', models: 2 }, { id: 'acme', name: 'Acme' }],
      tools: ['read', 'bash'],
      sandboxMode: 'workspace-write',
    })
    try {
      const text = textOf(await run(test, '/doctor'))

      expect(text).toContain('Sandbox: workspace-write')
      expect(text).toContain('Providers: 2')
      expect(text).toContain('- deepseek (DeepSeek): 2 model(s)')
      expect(text).toContain('- acme (Acme): models unavailable')
      expect(text).toContain('Tools: 2 callable')
      expect(text).toContain('Filesystem provider: absent')
      expect(text).toContain('Storage domain: absent')
      expect((await run(test, '/doctor now')).result).toEqual({ kind: 'error', text: 'Usage: /doctor' })
    } finally {
      await test.stop()
    }
  })

  it('reports an unmounted sandbox policy and no providers', async () => {
    const test = await harness()
    try {
      const text = textOf(await run(test, '/doctor'))

      expect(text).toContain('Sandbox: no policy mounted')
      expect(text).toContain('Providers: none registered')
      expect(text).toContain('Hook bridges: unknown (no Loader)')
    } finally {
      await test.stop()
    }
  })
})

describe('/mcp', () => {
  it('groups bridged tools by their server segment', async () => {
    const test = await harness({
      tools: ['mcp__github__create_issue', 'mcp__github__list_prs', 'mcp__linear__create_issue', 'read'],
    })
    try {
      const text = textOf(await run(test, '/mcp'))

      expect(text).toContain('2 MCP server(s):')
      expect(text).toContain('- github: create_issue, list_prs')
      expect(text).toContain('- linear: create_issue')
      expect((await run(test, '/mcp extra')).result).toEqual({ kind: 'error', text: 'Usage: /mcp' })
    } finally {
      await test.stop()
    }
  })

  it('reports no registered MCP tools', async () => {
    const test = await harness({ tools: ['read'] })
    try {
      expect(textOf(await run(test, '/mcp'))).toBe('No MCP tools are registered.')
    } finally {
      await test.stop()
    }
  })
})

describe('/agents', () => {
  it('lists compositions, providers, and this session\'s children', async () => {
    const test = await harness({
      presets: [{ id: 'standard', rows: [{ moduleName: 'a' }, { moduleName: 'b' }] }],
      subagentProviders: ['spawn', 'acp'],
      children: [{ id: 'child-1', mode: 'one-shot', label: 'researcher' }],
    })
    try {
      const text = textOf(await run(test, '/agents'))

      expect(text).toContain('Agent compositions: 1')
      expect(text).toContain('- standard: 2 plugin row(s)')
      expect(text).toContain('Subagent providers: spawn, acp')
      expect(text).toContain('- researcher (one-shot)')
      expect((await run(test, '/agents now')).result).toEqual({ kind: 'error', text: 'Usage: /agents' })
    } finally {
      await test.stop()
    }
  })
})

describe('/hooks', () => {
  it('lists mounted hook bridges and refuses without a Loader', async () => {
    const withoutLoader = await harness()
    try {
      expect((await run(withoutLoader, '/hooks')).result).toEqual({
        kind: 'error',
        text: 'This deployment has no Loader, so mounted hook bridges cannot be listed.',
      })
    } finally {
      await withoutLoader.stop()
    }

    const mounted = await harness({
      withLoader: true,
      hookBridges: [{ name: '@deepseek-ai/dsh-hooks-claude-code', enabled: true }],
    })
    try {
      const text = textOf(await run(mounted, '/hooks'))

      expect(text).toContain('1 hook bridge(s) mounted:')
      expect(text).toContain('- @deepseek-ai/dsh-hooks-claude-code (enabled)')
      expect((await run(mounted, '/hooks now')).result).toEqual({ kind: 'error', text: 'Usage: /hooks' })
    } finally {
      await mounted.stop()
    }
  })

  it('reports no mounted bridges when the Loader has none', async () => {
    const test = await harness({ withLoader: true })
    try {
      expect(textOf(await run(test, '/hooks'))).toContain('No hook bridges are mounted')
    } finally {
      await test.stop()
    }
  })
})

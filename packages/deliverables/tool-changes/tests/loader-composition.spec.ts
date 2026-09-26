/**
 * REAL-composition proof: the shipped rows (system prompt, tool registry, session store, local
 * subprocess runtime, workspace-changes) plus this package boot through the vendored Loader, and a
 * recorded turn's changes reach the model through both tools.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WorkspaceChangesPlugin from '@deepseek-ai/dsh-workspace-changes'
import * as ToolChanges from '../src/index.ts'
import { GIT_SUBPROCESS_TIMEOUT_MS, callingAgent, git, modelText, settle, toolResult } from './support.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('boots every row and answers both tools from a turn the recorder committed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-changes-loader-'))
    git(root, 'init', '-q', root)
    const cwd = join(root, 'ws')
    await mkdir(cwd)
    await writeFile(join(cwd, 'tracked.txt'), 'one\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-workspace-changes'",
      "- name: '@deepseek-ai/dsh-tool-changes'",
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules: Record<string, unknown> = {
      '@deepseek-ai/dsh-system-prompt': SystemPrompt,
      '@deepseek-ai/dsh-tools': ToolRuntime,
      '@deepseek-ai/dsh-session': SessionStore,
      '@deepseek-ai/dsh-subprocess-local': LocalSubprocessRuntime,
      '@deepseek-ai/dsh-workspace-changes': WorkspaceChangesPlugin,
      '@deepseek-ai/dsh-tool-changes': ToolChanges,
    }
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!Object.hasOwn(modules, specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules[specifier]
      },
    } as never
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
    await context.loader.await()
    expect([...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)).toEqual([])

    await context.plugin(AgentRegistry)
    const session = context.sessions.create(SessionId('loader-tool-changes'), { meta: { cwd } })
    const agent = await callingAgent(context, session)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    await settle(context, session)
    await writeFile(join(cwd, 'tracked.txt'), 'one\ntwo\n')
    toolResult(session, 1)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle(context, session)
    const tools = context.tools
    const execute = (name: string, args: unknown) => tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`loader-${name}`),
      name,
      arguments: args,
      agent,
    })

    const summary = await execute('turn_changes', {})
    expect(summary.isError).toBe(false)
    expect(modelText(summary)).toBe([
      `Turn 1 changed 1 file (+1 -0) under ${cwd}:`,
      '  tracked.txt (+1 -0)',
      'Read one file\'s diff with turn_diff (turn 1, path as listed).',
    ].join('\n'))

    const diff = await execute('turn_diff', { path: 'tracked.txt' })
    expect(diff.isError).toBe(false)
    expect(modelText(diff)).toBe([
      'Turn 1, tracked.txt',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two',
    ].join('\n'))
  }, GIT_SUBPROCESS_TIMEOUT_MS)
})

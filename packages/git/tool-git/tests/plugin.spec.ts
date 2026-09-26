/**
 * Plugin lifecycle: the four registrations appear and leave with the fiber
 * (HMR safety), and an unusable budget fails at load instead of at the first
 * command.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

/** The model-facing names this package owns. */
const TOOL_NAMES = ['git_commit', 'git_branch', 'git_pr', 'git_worktree'] as const

async function mount(ctx: Context, config: ToolGit.Config = {}) {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  return await ctx.plugin(ToolGit, config)
}

describe('registration', () => {
  it('registers every git tool once the registry and the subprocess seam are present', async () => {
    const ctx = new Context()
    await mount(ctx)
    for (const name of TOOL_NAMES) {
      expect(ctx.tools.get(name), name).toBeDefined()
    }
  })

  it('removes every registration when its fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await mount(ctx)
    await fiber.dispose()
    for (const name of TOOL_NAMES) {
      expect(ctx.tools.get(name), name).toBeUndefined()
    }
  })

  it('stays pending without the subprocess capability', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolGit, {})
    expect(ctx.tools.get('git_commit')).toBeUndefined()
  })
})

describe('configuration', () => {
  it('rejects a budget no command could run under', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(ToolGit, { timeoutMs: 0 })).rejects.toThrow('tool-git: timeoutMs must be a positive integer, got 0')
  })

  it('rejects a fractional spill cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(ToolGit, { spillMaxBytes: 1.5 })).rejects.toThrow('tool-git: spillMaxBytes must be a positive integer, got 1.5')
  })
})

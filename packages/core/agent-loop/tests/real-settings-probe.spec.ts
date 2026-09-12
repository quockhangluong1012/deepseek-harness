/** Throwaway probe: the real user settings document reaches the loop's step ceiling. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import AgentLoop, { AGENT_LOOP_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-loop'

describe('real settings document probe', () => {
  it('publishes the stored step ceiling into the loop config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SettingsFile)
    await ctx.plugin(AgentLoop, { agents: [] })

    const user = ctx.settings.describe().find(entry => entry.ns === AGENT_LOOP_SETTINGS_NAMESPACE)?.user
    process.stdout.write(`stored agent-loop section: ${JSON.stringify(user)}\n`)
    process.stdout.write(`effective maxSteps: ${ctx.agentLoop.config.maxSteps}\n`)

    expect(user).toEqual({ maxSteps: 1000 })
    expect(ctx.agentLoop.config.maxSteps).toBe(1000)
    await ctx.fiber.dispose()
  })
})

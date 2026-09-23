/** The `agent-loop` settings section layered over the composition entry. */

import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

async function boot() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, AgentLoop, { agents: [], maxParallelToolCalls: 4 })
  return { ctx, live }

}

it('updates future scheduler budgets while preserving composed agents and the running loop', async () => {
  const { ctx, live } = await boot()
  const before = live.fiber
  await live.update({ maxParallelToolCalls: 1 })
  expect(live.entry.fiber === before).toBe(true)
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(1)
  expect(ctx.agentLoop.config.agents).toEqual([])
  await expect(live.update({ maxParallelToolCalls: 0 })).rejects.toThrow()
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(1)
})

it('samples the step and retry ceilings from the same live config', async () => {
  const { ctx, live } = await boot()
  const before = live.fiber
  expect(ctx.agentLoop.config.maxSteps.get()).toBe(100)
  expect(ctx.agentLoop.config.maxRequestRetries.get()).toBe(10)

  await live.update({ maxSteps: 25, maxRequestRetries: 3 })

  expect(live.entry.fiber === before).toBe(true)
  expect(ctx.agentLoop.config.maxSteps.get()).toBe(25)
  expect(ctx.agentLoop.config.maxRequestRetries.get()).toBe(3)

  await expect(live.update({ maxSteps: 0 })).rejects.toThrow()
  await expect(live.update({ maxRequestRetries: -1 })).rejects.toThrow()
  expect(ctx.agentLoop.config.maxSteps.get()).toBe(25)
  expect(ctx.agentLoop.config.maxRequestRetries.get()).toBe(3)
})

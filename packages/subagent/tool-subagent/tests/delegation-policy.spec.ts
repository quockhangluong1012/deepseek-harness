/**
 * Typed worker roles, the delegation policy, and task overlap: what a
 * file-defined role puts on the child's start request, which spawns the policy
 * refuses, and what a repeated delegation does instead of spawning again.
 *
 * @module @deepseek-ai/dsh-tool-subagent/tests/delegation-policy
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import { callSubagent, fakeAgent, setup, text } from './harness.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One temp root this spec owns. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'delegation-policy-'))
  roots.push(root)
  return root
}

/** Write one file under a root, creating its directory. */
function writeDefinition(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source, 'utf8')
}

/** The child prompt text one captured start request carried. */
function promptOf(request: SubagentStartRequest | undefined): string {
  return request?.prompt
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('') ?? ''
}

/** Yield one macrotask, so continuations already scheduled ahead of this wait run first. */
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  setTimeout(resolve, 0)
  return promise
}

/** The object-rooted schema one definition file names. */
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { summary: { type: 'string' } },
  required: ['summary'],
}

/** One definition root holding a role that declares every accepted field. */
function roleRoot(): string {
  const root = tempRoot()
  writeDefinition(join(root, 'delegation-review.json'), JSON.stringify(REVIEW_SCHEMA))
  writeDefinition(join(root, 'reviewer.md'), `---
name: reviewer
role: reviewer
description: Reviews a diff
model: alpha/review-model
tools: Read, grep
permission:
  edit: deny
budget:
  maxTokens: 50000
  maxCostUsd: 1.5
maxTurns: 6
outputSchema: delegation-review.json
---
Review the diff.
`)
  return root
}

/** Mount the real stack around one scripted provider, returning the tool registration's fiber. */
async function mountTool(
  config: tool.Config,
  mockConfig: Partial<mock.Config> = {},
): Promise<{ ctx: Context; fiber: unknown }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
  const fiber = ctx.plugin(tool, config)
  return { ctx, fiber }
}

describe('worker roles declared by definition files', () => {
  it('applies every declared role field to the child start request', async () => {
    const root = roleRoot()
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      {
        provider: 'mock',
        agentDirs: { project: [root], user: [] },
        delegation: { maxTokens: 200_000 },
        usdPerMillionTokens: 3,
      },
      { onStart: request => void starts.push(request) },
    )
    const parent = fakeAgent('role-parent')
    // The role declares its own route, which the delegation preflights.
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'review the diff', prompt: 'p', agent: 'reviewer' }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(starts).toHaveLength(1)
    const request = starts[0]
    expect(request?.agentOptions).toEqual({ provider: 'alpha', model: 'review-model' })
    expect(request?.toolFilter).toEqual({ allow: ['read', 'grep'], deny: ['edit'] })
    expect(request?.outputSchema).toEqual(REVIEW_SCHEMA)
    // The role declares 50000 tokens, the policy 200000: the child gets the narrower one.
    expect(request?.workerLimits).toEqual({ maxTurns: 6, maxTokens: 50_000, maxCostUsd: 1.5, usdPerMillionTokens: 3 })
    expect(request?.maxDepth).toBe(1)
    expect(promptOf(request)).toBe('p')
  })

  it('takes the child-depth cap the policy declares and rejects a conflicting one', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', delegation: { maxDepth: 3 } },
      { onStart: request => void starts.push(request) },
    )
    await callSubagent(ctx, { description: 'read the file', prompt: 'p' }, { agent: fakeAgent('depth-parent') })
    expect(starts[0]?.maxDepth).toBe(3)

    const { ctx: conflicting, fiber } = await mountTool({ provider: 'mock', maxDepth: 1, delegation: { maxDepth: 2 } })
    await expect(fiber).rejects.toThrow(/`delegation.maxDepth` and `maxDepth` declare different child depth caps/)
    await conflicting.fiber.dispose()
  })

  it('hands the delegation policy its own ceilings when the call names no role', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', delegation: { maxTokens: 1_000, maxCost: 2 }, usdPerMillionTokens: 1 },
      { onStart: request => void starts.push(request) },
    )

    await callSubagent(ctx, { description: 'read the file', prompt: 'p' }, { agent: fakeAgent('ceiling-parent') })

    expect(starts[0]?.workerLimits).toEqual({ maxTokens: 1_000, maxCostUsd: 2, usdPerMillionTokens: 1 })
  })

  it('refuses the spawn when the provider cannot enforce the ceilings a role declares', async () => {
    const root = roleRoot()
    const ctx = await setup(
      { provider: 'mock', agentDirs: { project: [root], user: [] }, usdPerMillionTokens: 1 },
      { capabilities: { workerLimits: false } },
    )
    // The role declares its own route, which the delegation preflights before
    // the admission checks below run.
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'review the diff', prompt: 'p', agent: 'reviewer' }, { agent: fakeAgent('incapable-parent') })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cannot enforce them (no workerLimits capability)')
  })

  it('fails the load when a dollar ceiling has no token price', async () => {
    const { ctx, fiber } = await mountTool({ provider: 'mock', delegation: { maxCost: 1 } })
    await expect(fiber).rejects.toThrow(/`delegation.maxCost` prices a child in USD, so it requires `usdPerMillionTokens`/)
    await ctx.fiber.dispose()
  })

  it('fails the load when the provider cannot enforce the policy ceilings', async () => {
    const { ctx, fiber } = await mountTool(
      { provider: 'mock', delegation: { maxTokens: 10 } },
      { capabilities: { workerLimits: false } },
    )
    await expect(fiber).rejects.toThrow(/cannot \(no workerLimits capability\)/)
    await ctx.fiber.dispose()
  })
})

describe('delegation policy admission', () => {
  it('refuses a role the policy does not admit', async () => {
    const root = roleRoot()
    const ctx = await setup({ provider: 'mock', agentDirs: { project: [root], user: [] }, delegation: { allowedRoles: ['coder'] } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'review the diff', prompt: 'p', agent: 'reviewer' }, { agent: fakeAgent('roles-parent') })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent delegation refused: the role "reviewer" is not one of the roles this delegation policy allows (coder)')
  })

  it('admits a definition that declares no role by its own name', async () => {
    const root = tempRoot()
    writeDefinition(join(root, 'reviewer.md'), '---\nname: reviewer\n---\n')
    const ctx = await setup({ provider: 'mock', agentDirs: { project: [root], user: [] }, delegation: { allowedRoles: ['reviewer'] } })

    const result = await callSubagent(ctx, { description: 'review the diff', prompt: 'p', agent: 'reviewer' }, { agent: fakeAgent('named-parent') })

    expect(result.isError).toBe(false)
  })

  it('refuses a spawn that names no role once the policy admits roles', async () => {
    const ctx = await setup({ provider: 'mock', delegation: { allowedRoles: ['reviewer'] } })

    const result = await callSubagent(ctx, { description: 'review the diff', prompt: 'p' }, { agent: fakeAgent('anonymous-parent') })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('allows only the roles reviewer, and the spawn names none')
  })

  it('refuses a spawn without the output schema the policy requires', async () => {
    const ctx = await setup({ provider: 'mock', delegation: { resultSchemaRequired: true } })
    const parent = fakeAgent('schema-parent')

    const missing = await callSubagent(ctx, { description: 'review the diff', prompt: 'p' }, { agent: parent })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('requires an output schema, and the spawn declares none')

    const starts: SubagentStartRequest[] = []
    const carrying = await setup(
      { provider: 'mock', delegation: { resultSchemaRequired: true } },
      { onStart: request => void starts.push(request) },
    )
    const supplied = await callSubagent(
      carrying,
      { description: 'review the diff', prompt: 'p', output_schema: REVIEW_SCHEMA },
      { agent: fakeAgent('schema-parent-2') },
    )
    expect(supplied.isError).toBe(false)
    expect(starts[0]?.outputSchema).toEqual(REVIEW_SCHEMA)
  })

  it('refuses a child past the per-parent cap', async () => {
    const ctx = await setup({ provider: 'mock', delegation: { maxChildren: 1 } })
    const parent = fakeAgent('cap-parent')

    const first = await callSubagent(ctx, { description: 'first task', prompt: 'p' }, { agent: parent })
    expect(first.isError).toBe(false)

    const second = await callSubagent(ctx, { description: 'second task', prompt: 'p' }, { agent: parent })
    expect(second.isError).toBe(true)
    expect(text(second))
      .toContain('subagent delegation refused: this delegation policy allows 1 children per parent, and the parent already spawned 1')
  })

  it('refuses a child past the concurrency cap while one is in flight', async () => {
    const gate = Promise.withResolvers<undefined>()
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', delegation: { maxConcurrent: 1 } },
      { onStart: (request) => { starts.push(request); return gate.promise } },
    )
    const parent = fakeAgent('concurrency-parent')

    const inFlight = callSubagent(ctx, { description: 'long task', prompt: 'p' }, { agent: parent })
    await vi.waitFor(() => { expect(starts).toHaveLength(1) })
    // The boundary records the child after its provider published it, one
    // microtask after the provider's start callback ran.
    await tick()
    const refused = await callSubagent(ctx, { description: 'other task', prompt: 'p' }, { agent: parent })
    expect(refused.isError).toBe(true)
    expect(text(refused))
      .toContain('subagent delegation refused: this delegation policy allows 1 children in flight, and the parent already has 1')

    gate.resolve(undefined)
    expect((await inFlight).isError).toBe(false)
    const afterSettled = await callSubagent(ctx, { description: 'other task', prompt: 'p' }, { agent: parent })
    expect(afterSettled.isError).toBe(false)
  })
})

describe('task overlap detection', () => {
  it('reuses the retained result of a completed child that ran the same task', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', delegation: { duplicateTaskDetection: true } },
      { reply: 'the parser is fine', onStart: request => void starts.push(request) },
    )
    const parent = fakeAgent('reuse-parent')

    await callSubagent(ctx, { description: 'review the parser changes', prompt: 'p' }, { agent: parent })
    const reused = await callSubagent(ctx, { description: 'Review the parser changes', prompt: 'p' }, { agent: parent })

    expect(reused.isError).toBe(false)
    expect(starts).toHaveLength(1)
    expect(text(reused)).toContain('Reused the result of the subagent that already ran "review the parser changes"')
    expect(text(reused)).toContain('the parser is fine')
  })

  it('merges into the in-flight child that already covers the task', async () => {
    const gate = Promise.withResolvers<undefined>()
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', delegation: { duplicateTaskDetection: true } },
      { onStart: (request) => { starts.push(request); return gate.promise } },
    )
    const parent = fakeAgent('merge-parent')

    const inFlight = callSubagent(ctx, { description: 'review the parser changes', prompt: 'p' }, { agent: parent })
    await vi.waitFor(() => { expect(starts).toHaveLength(1) })
    await tick()
    const merged = await callSubagent(ctx, { description: 'review the parser changes', prompt: 'p' }, { agent: parent })

    expect(merged.isError).toBe(true)
    expect(text(merged)).toContain('merged into child "delegation-1"')
    expect(starts).toHaveLength(1)

    gate.resolve(undefined)
    expect((await inFlight).isError).toBe(false)
  })

  it('narrows the prompt of a task a completed child partly covered', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', delegation: { duplicateTaskDetection: true } },
      { onStart: request => void starts.push(request) },
    )
    const parent = fakeAgent('narrow-parent')

    await callSubagent(ctx, { description: 'audit the parser changes', prompt: 'p' }, { agent: parent })
    const narrowed = await callSubagent(ctx, { description: 'review the parser changes', prompt: 'do the review' }, { agent: parent })

    expect(narrowed.isError).toBe(false)
    expect(starts).toHaveLength(2)
    expect(promptOf(starts[1])).toBe(
      'A previous subagent already covered part of this work: "audit the parser changes" (child "delegation-1"). '
      + 'Do not repeat what it covered; complete only what this task adds.\n\ndo the review',
    )
  })

  it('avoids the spawn when a completed child ran the task without keeping a result', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await setup(
      { provider: 'mock', delegation: { duplicateTaskDetection: true } },
      { stopReason: 'error', onStart: request => void starts.push(request) },
    )
    const parent = fakeAgent('avoid-parent')

    const failed = await callSubagent(ctx, { description: 'review the parser changes', prompt: 'p' }, { agent: parent })
    expect(failed.isError).toBe(true)

    const avoided = await callSubagent(ctx, { description: 'review the parser changes', prompt: 'p' }, { agent: parent })
    expect(avoided.isError).toBe(true)
    expect(text(avoided)).toContain('already completed this task (delegation-1) and this session retains no result to reuse')
    expect(starts).toHaveLength(1)
  })

  it('spawns every task when duplicate detection is off', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await setup({ provider: 'mock' }, { reply: 'fresh reply', onStart: request => void starts.push(request) })
    const parent = fakeAgent('inert-parent')

    await callSubagent(ctx, { description: 'review the parser changes', prompt: 'p' }, { agent: parent })
    const second = await callSubagent(ctx, { description: 'review the parser changes', prompt: 'p' }, { agent: parent })

    expect(starts).toHaveLength(2)
    expect(text(second)).toBe('fresh reply')
  })
})

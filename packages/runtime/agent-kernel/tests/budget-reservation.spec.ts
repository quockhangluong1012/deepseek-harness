/**
 * Budget reservations: what a session can still promise while the work it
 * delegated is in flight, how a settled child's spend is debited, and the
 * concurrency ceiling that bounds a task's actions.
 *
 * @module @deepseek-ai/dsh-agent-kernel/tests/budget-reservation
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Config } from '../src/index.ts'
import type { BudgetReservationId, CapabilityDeclaration, ResourceBudget } from '../src/types.ts'
import {
  callTool,
  currentTask,
  decisions,
  denials,
  eventsOf,
  humanMessage,
  makeAgent,
  makeChild,
  preStep,
  registerTool,
  rig,
  type Rig,
} from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount a rig and remember it for teardown. */
async function mounted(config: Config = {}): Promise<Rig> {
  const result = await rig(config)
  contexts.push(result.ctx)
  return result
}

/** A permission document allowing every action. */
const ALLOW_ALL = { defaults: { effect: 'allow' as const }, rules: [] }

/** An identity no reservation was ever issued under. */
const UNKNOWN_RESERVATION = brandString<BudgetReservationId>('reservation-unknown')

/** One axis of every grant in a list, summed. */
function summedSteps(grants: readonly (ResourceBudget | undefined)[]): number | undefined {
  const values = grants.map(grant => grant?.maxSteps)
  if (values.some(value => value === undefined)) return undefined
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

describe('the budget governor', () => {
  it('reports the concurrency ceiling as a remaining allowance', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxConcurrentActions: 2 } })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])

    expect(kernel.state.view(agent.session)?.budgets.remaining).toEqual({ maxConcurrentActions: 2 })
  })

  it('caps concurrent reservations at what the session has left', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 6, maxTokens: 1000 } })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])
    agent.session.append('step/start', { turn: 1, step: 1 })
    const session = agent.session

    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 5, maxTokens: 1000 })

    // Both reservations are made before either settles, so the second is
    // promised only what the first left.
    const first = kernel.budgets.reserve(session, { maxSteps: 4, maxTokens: 1000 })
    const second = kernel.budgets.reserve(session, { maxSteps: 4, maxTokens: 1000 })
    expect(first.amount).toEqual({ maxSteps: 4, maxTokens: 1000 })
    expect(second.amount).toEqual({ maxSteps: 1, maxTokens: 0 })
    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 0, maxTokens: 0 })

    // Releasing the first hold returns only what it held: the second hold kept
    // the one step it was promised and none of the tokens.
    kernel.budgets.release(first.reservationId)
    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 4, maxTokens: 1000 })

    // Settling the second debits what it spent, which a later grant cannot be
    // promised again.
    kernel.budgets.commit(second.reservationId, { maxSteps: 1 })
    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 4, maxTokens: 1000 })
    expect(kernel.budgets.reserve(session, { maxSteps: 10 }).amount).toEqual({ maxSteps: 4 })
  })

  it('holds only the spend axes, and settles a hold once', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 4, maxSubagentDepth: 3 } })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])
    const session = agent.session
    const runId = currentTask(agent).runId

    // Authority axes are inherited as ceilings rather than held as amounts.
    const hold = kernel.budgets.reserve(session, { maxSteps: 2, maxSubagentDepth: 1 }, runId)
    expect(hold).toMatchObject({ amount: { maxSteps: 2 }, sessionId: session.id, runId })
    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 2, maxSubagentDepth: 3 })

    // A hold settled with no measurement ends without debiting anything, and
    // settling or releasing it again does nothing.
    kernel.budgets.commit(hold.reservationId)
    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 4, maxSubagentDepth: 3 })
    kernel.budgets.release(hold.reservationId)
    kernel.budgets.commit(UNKNOWN_RESERVATION, { maxSteps: 4 })
    kernel.budgets.release(UNKNOWN_RESERVATION)
    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 4, maxSubagentDepth: 3 })
  })

  it('promises nothing for a session that holds no task', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 4 } })
    const agent = await makeAgent(ctx)

    expect(kernel.budgets.available(agent.session)).toEqual({})
    expect(kernel.budgets.reserve(agent.session, { maxSteps: 4 })).toMatchObject({ amount: {} })
  })

  it('records the run a hold was placed for', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 4 } })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])

    const runId = currentTask(agent).runId
    expect(kernel.budgets.reserve(agent.session, { maxSteps: 1 }, runId).runId).toBe(runId)
  })
})

describe('the background budget owner', () => {
  it('reports the background spend beside the session charge its own observation records', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 4, maxTokens: 1000 } })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])
    agent.session.append('step/start', { turn: 1, step: 1 })
    // Mounted after the kernel, as a background owner is in a profile that
    // brings one up: the read is per observation, not a captured service.
    ctx.provide('evolutionBudget', { backgroundSpend: () => ({ tokens: 5000, wallMs: 60000, cost: 2 }) } as never)

    const budgets = kernel.budgets.measure(currentTask(agent), agent.session)

    expect(budgets.steps).toBe(1)
    expect(budgets.remaining).toMatchObject({ maxSteps: 3, maxTokens: 1000 })
    expect(budgets.background).toEqual({ tokens: 5000, wallMs: 60000, cost: 2 })
    // The kernel view answers from the same observation, so a caller reading
    // the task's state sees the background draw without a second call.
    expect(kernel.state.view(agent.session)?.budgets.background).toEqual({ tokens: 5000, wallMs: 60000, cost: 2 })
  })

  it('reports no background spend when no background budget owner is mounted', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 4 } })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])

    expect(kernel.budgets.measure(currentTask(agent), agent.session).background).toBeUndefined()
  })

  it('enforces nothing: background spend past the in-session ceiling leaves the session whole', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 2, maxTokens: 1000 } })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])
    // Background work that outran the session's own token ceiling by four
    // orders of magnitude. `guard/budgets` bounds what the session spends and
    // the background owner gates its own calls; the governor only reads.
    ctx.provide('evolutionBudget', { backgroundSpend: () => ({ tokens: 10_000_000, wallMs: 600_000 }) } as never)
    const session = agent.session

    expect(kernel.budgets.measure(currentTask(agent), session).remaining).toMatchObject({ maxSteps: 2, maxTokens: 1000 })
    expect(kernel.budgets.available(session)).toEqual({ maxSteps: 2, maxTokens: 1000 })
    expect(kernel.budgets.reserve(session, { maxSteps: 2, maxTokens: 1000 }).amount).toEqual({ maxSteps: 2, maxTokens: 1000 })
  })
})

describe('delegation grants', () => {
  it('grants two children created before either settles no more than the parent can promise', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL, budgets: { maxSteps: 6, maxTokens: 1000 } })
    const parent = await makeAgent(ctx)
    await preStep(ctx, parent, [humanMessage('delegate')])
    parent.session.append('step/start', { turn: 1, step: 1 })
    parent.session.append('step/start', { turn: 1, step: 2 })

    const first = await makeChild(ctx, parent)
    const second = await makeChild(ctx, parent)

    const grants = [first, second].map(child => eventsOf(child, 'delegation/received')[0]?.resourceLimits)
    const remaining = kernel.state.view(parent.session)?.budgets.remaining
    // The parent is left four steps; the first child is promised all of them
    // and the second, created while that hold stands, is promised none.
    expect(grants).toEqual([
      { maxSteps: 4, maxTokens: 1000 },
      { maxSteps: 0, maxTokens: 0 },
    ])
    expect(summedSteps(grants)).toBe(remaining?.maxSteps)
    expect(kernel.budgets.available(parent.session)).toEqual({ maxSteps: 0, maxTokens: 0 })
    expect(eventsOf(parent, 'delegation/issued')).toEqual([
      ...eventsOf(first, 'delegation/received'),
      ...eventsOf(second, 'delegation/received'),
    ])
    // The second child's contract starts from what the receipt granted, so the
    // shared pot is what bounds it rather than the deployment's ceiling.
    await preStep(ctx, second, [humanMessage('work')])
    expect(eventsOf(second, 'task/created')[0]?.budget).toEqual({ maxSteps: 0, maxTokens: 0 })
  })

  it('debits the parent with a child that ran and releases a child that never did', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL, budgets: { maxSteps: 6, maxTokens: 1000 } })
    const parent = await makeAgent(ctx)
    await preStep(ctx, parent, [humanMessage('delegate')])

    const ran = await makeChild(ctx, parent)
    await preStep(ctx, ran, [humanMessage('work')])
    ran.session.append('step/start', { turn: 1, step: 1 })
    const idle = await makeChild(ctx, parent)

    ctx.emit('agent/disposed', { agent: ran })
    ctx.emit('agent/disposed', { agent: idle })

    // The child that ran spent one of the parent's six steps; the child that
    // never opened a task spent nothing.
    expect(kernel.budgets.available(parent.session)).toEqual({ maxSteps: 5, maxTokens: 1000 })
  })

  it('settles a child once, so a second disposal settles nothing further', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL, budgets: { maxSteps: 6 } })
    const parent = await makeAgent(ctx)
    await preStep(ctx, parent, [humanMessage('delegate')])
    const child = await makeChild(ctx, parent)
    await preStep(ctx, child, [humanMessage('work')])
    child.session.append('step/start', { turn: 1, step: 1 })

    ctx.emit('agent/disposed', { agent: child })
    ctx.emit('agent/disposed', { agent: child })

    expect(kernel.budgets.available(parent.session)).toEqual({ maxSteps: 5 })
  })
})

describe('the concurrency ceiling', () => {
  /**
   * Register a probe tool whose body reports that it started and then waits,
   * so a spec can hold one action in flight across another call's decision.
   * @param ctx - the owning context.
   * @param kernel - the mounted kernel the tool's capability is declared on.
   * @returns the started signal and the release that lets a body finish.
   */
  function registerBlockingProbe(
    ctx: Context,
    kernel: Rig['kernel'],
  ): { readonly started: Promise<undefined>; readonly release: () => void } {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const declaration: CapabilityDeclaration = {
      tool: 'probe',
      capabilities: ['fs.read'],
      resources: () => 'workspace/a.ts',
    }
    kernel.capabilities.register(declaration)
    registerTool(ctx, 'probe', async () => {
      started.resolve(undefined)
      await release.promise
      return [{ type: 'text' as const, text: 'ok' }]
    })
    return { started: started.promise, release: () => { release.resolve(undefined) } }
  }

  it('refuses a call that would put more actions in flight than the ceiling allows', async () => {
    const { ctx, kernel } = await mounted({ mode: 'enforce', policy: ALLOW_ALL, budgets: { maxConcurrentActions: 1 } })
    const agent = await makeAgent(ctx)
    const probe = registerBlockingProbe(ctx, kernel)
    await preStep(ctx, agent, [humanMessage('go')])

    const inFlight = callTool(ctx, 'probe', agent, 'call-in-flight')
    await probe.started
    const overCeiling = callTool(ctx, 'probe', agent, 'call-over-ceiling')
    // The second call is decided, refused, and settled before its body runs.
    await vi.waitFor(() =>{  expect(decisions(agent)).toHaveLength(2) })

    expect(denials(agent)).toHaveLength(1)
    expect(denials(agent)[0]?.reasons.join('; ')).toContain('the task already has 1 of 1 actions in flight')

    probe.release()
    await expect(inFlight).resolves.toMatchObject({ isError: false })
    await expect(overCeiling).resolves.toMatchObject({ isError: true })
  })

  it('records the refusal in shadow mode and runs the call anyway', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL, budgets: { maxConcurrentActions: 1 } })
    const agent = await makeAgent(ctx)
    const probe = registerBlockingProbe(ctx, kernel)
    await preStep(ctx, agent, [humanMessage('go')])

    const inFlight = callTool(ctx, 'probe', agent, 'call-in-flight')
    await probe.started
    const overCeiling = callTool(ctx, 'probe', agent, 'call-over-ceiling')
    await vi.waitFor(() =>{  expect(decisions(agent)).toHaveLength(2) })

    expect(denials(agent)[0]).toMatchObject({ effect: 'deny', enforced: false })
    expect(decisions(agent)[1]?.decision).toMatchObject({ effect: 'deny', enforced: false })

    probe.release()
    await expect(Promise.all([inFlight, overCeiling])).resolves.toMatchObject([{ isError: false }, { isError: false }])
  })

  it('admits parallel calls when the task declares no concurrency ceiling', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    const probe = registerBlockingProbe(ctx, kernel)
    await preStep(ctx, agent, [humanMessage('go')])

    const first = callTool(ctx, 'probe', agent, 'call-a')
    await probe.started
    const second = callTool(ctx, 'probe', agent, 'call-b')
    await vi.waitFor(() =>{  expect(decisions(agent)).toHaveLength(2) })

    probe.release()
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ isError: false }, { isError: false }])
    expect(denials(agent)).toEqual([])
  })
})

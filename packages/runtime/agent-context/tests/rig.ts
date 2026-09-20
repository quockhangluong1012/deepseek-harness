/**
 * Shared harness for the agent-context specs: a context with the standard loop
 * prerequisite services, directly constructed Agents so a spec can drive one
 * assembly without a model call, and small readers over a session log.
 *
 * @module @deepseek-ai/dsh-agent-context/tests/rig
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import type { BudgetSnapshot, KernelView, TaskContract } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActionId, FailureId, RunId, TaskId } from '@deepseek-ai/dsh-agent-kernel'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import AgentContext from '../src/index.ts'
import type { AgentContextService, Config } from '../src/index.ts'

/** A mounted compiler and the context that owns it. */
export interface Rig {
  /** The owning context. */
  readonly ctx: Context
  /** The mounted compiler service. */
  readonly service: AgentContextService
  /** The compiler plugin's own fiber, so a spec can dispose it. */
  readonly fiber: Fiber
}

/** Counters that keep each fixture's session identity distinct. */
let sequence = 0

/**
 * Mount the loop prerequisites and the compiler.
 * @param config - plugin configuration; omitted fields take the schema defaults.
 * @param kernel - whether to mount the agent kernel, so durable task facts exist.
 * @returns the mounted rig.
 */
export async function rig(config: Config = {}, kernel = false): Promise<Rig> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (kernel) await ctx.plugin(AgentKernel, {})
  const fiber = await ctx.plugin(AgentContext, config)
  return { ctx, service: ctx.agentContext, fiber }
}

/**
 * Register a directly constructed Agent over a fresh session.
 * @param ctx - the owning context.
 * @returns the registered Agent.
 */
export function makeAgent(ctx: Context): Agent {
  sequence += 1
  const scope = ctx.plugin(() => {})
  const id = SessionId(`context-agent-${String(sequence)}`)
  const agent: Agent = {
    id,
    options: {},
    session: ctx.sessions.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

/**
 * Admit one step through the real pre-step waterfall, so the kernel opens a task.
 * @param ctx - the owning context.
 * @param agent - the agent proposing the step.
 * @param text - the human message the step claims.
 * @returns a promise that settles when every listener has run.
 */
export async function admitStep(ctx: Context, agent: Agent, text = 'fix the build'): Promise<void> {
  await ctx.waterfall(
    'agent/pre-step',
    {
      agent,
      messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

/**
 * Every durable payload of one event type in a session, in log order.
 * @param agent - the agent whose session is read.
 * @param type - the event type.
 * @returns the payloads.
 */
export function eventsOf<T extends keyof SessionEventMap>(agent: Agent, type: T): SessionEventMap[T][] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<T> => event.type === type)
    .map(event => event.data)
}

/** The budget observation every fixture view carries. */
const BUDGET: BudgetSnapshot = { steps: 1, toolCalls: 0, wallMs: 12, remaining: {} }

/**
 * Build a complete kernel view, so each spec overrides only the field it reads.
 * @param overrides - fields to replace on the fixture view.
 * @returns the view.
 */
export function viewOf(overrides: Partial<KernelView> = {}): KernelView {
  const task: TaskContract = {
    taskId: brandString<TaskId>('task-1'),
    runId: brandString<RunId>('run-1'),
    objective: 'fix the failing build',
    constraints: [],
    acceptance: [],
    agentProfile: 'default',
    policyProfile: 'default',
    budget: {},
    status: 'executing',
    revision: 3,
  }
  return { task, sessionId: SessionId('context-agent-view'), budgets: BUDGET, openActionIds: [], unresolvedFailures: [], ...overrides }
}

/**
 * One branded action identity.
 * @param value - the identity text.
 * @returns the branded id.
 */
export function actionId(value: string): ActionId {
  return brandString<ActionId>(value)
}

/**
 * One branded failure identity.
 * @param value - the identity text.
 * @returns the branded id.
 */
export function failureId(value: string): FailureId {
  return brandString<FailureId>(value)
}

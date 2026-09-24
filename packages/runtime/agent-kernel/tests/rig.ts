/**
 * Shared harness for the agent-kernel specs: a context with the standard loop
 * prerequisite services, directly constructed Agents (so a spec can drive one
 * waterfall without a model call), and small readers over a session log.
 *
 * @module @deepseek-ai/dsh-agent-kernel/tests/rig
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import AgentKernel from '../src/index.ts'
import type { AgentKernelService, Config } from '../src/index.ts'
import type {
  ActionDecidedEvent, ActionProposal, AuthorizationDecision, KernelEventData, PolicyDecision, StateTransition, TaskContract,
} from '../src/types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-kernel-test': { kind: 'agent-kernel-test' } & ContextFormed
  }
}

/** A mounted kernel and the context that owns it. */
export interface Rig {
  /** The owning context. */
  readonly ctx: Context
  /** The mounted kernel service. */
  readonly kernel: AgentKernelService
}

/** Counters that keep each fixture's tool and session identity distinct. */
let sequence = 0

/**
 * Mount the loop prerequisites and the kernel.
 * @param config - plugin configuration; omitted fields take the schema defaults.
 * @returns the mounted rig.
 */
export async function rig(config: Config = {}): Promise<Rig> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentKernel, config)
  return { ctx, kernel: ctx.agentKernel }
}

/**
 * Register a directly constructed Agent over a fresh session. The Agent is
 * published to `ctx.agents` so scoped dispatch and identity checks resolve it.
 * @param ctx - the owning context.
 * @param cwd - absolute workspace directory to record on the session header.
 * @returns the registered Agent after its creation listeners finish.
 */
export async function makeAgent(ctx: Context, cwd?: string): Promise<Agent> {
  sequence += 1
  const scope = ctx.plugin(() => {})
  const id = SessionId(`agent-${sequence}`)
  const session = ctx.sessions.create(id, cwd === undefined ? {} : { meta: { cwd } })
  const agent: Agent = {
    id,
    options: {},
    session,
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
  await ctx.agents.register(agent)
  return agent
}

/**
 * Register one fixture tool.
 * @param ctx - the owning context.
 * @param name - the tool name the spec will call.
 * @param body - the tool body; the default returns one text block.
 */
export function registerTool(ctx: Context, name: string, body?: () => Promise<ContentBlock[]>): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: `fixture ${name}`,
    parameters: {},
    async execute() {
      return body === undefined ? [{ type: 'text' as const, text: 'ok' }] : await body()
    },
  }))
}

/**
 * Run one tool call through the real registry pipeline.
 * @param ctx - the owning context.
 * @param name - the tool to call.
 * @param agent - the calling agent, or undefined for an agentless call.
 * @param callId - the call identity the kernel keys the ledger by.
 * @returns the registry's normalized result.
 */
export function callTool(
  ctx: Context,
  name: string,
  agent: Agent | undefined,
  callId = `call-${String((sequence += 1))}`,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: {},
    ...agent === undefined ? {} : { agent },
  })
}

/**
 * Admit one step through the real pre-step waterfall.
 * @param ctx - the owning context.
 * @param agent - the agent proposing the step.
 * @param messages - the messages the step claims.
 * @param turn - the turn number.
 * @param step - the step number.
 * @returns the decision the waterfall produced.
 */
export function preStep(
  ctx: Context,
  agent: Agent,
  messages: ReturnType<typeof createUserMessage>[],
  turn = 1,
  step = 1,
): Promise<unknown> {
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages, turn, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

/**
 * Close one turn through the real turn-stopping event.
 * @param ctx - the owning context.
 * @param agent - the agent whose turn is stopping.
 * @param turn - the turn number.
 * @returns a promise that settles when every serial listener has run.
 */
export function stopTurn(ctx: Context, agent: Agent, turn = 1): Promise<void> {
  return Promise.resolve(ctx.serial('agent/turn-stopping', { agent, turn, signal: new AbortController().signal }))
}

/**
 * Build one human message for a claimed step.
 * @param text - the message text.
 * @returns the message.
 */
export function humanMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Build one non-human context message for the kernel fixtures.
 * @param text - the message text.
 * @returns the message.
 */
export function pluginMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-kernel-test' } })
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

/** Every action decision this agent recorded, in log order. */
export function decisions(agent: Agent): KernelEventData<ActionDecidedEvent>[] {
  return eventsOf(agent, 'action/decided')
}

/** The proposal of each decided action, in log order. */
export function proposals(agent: Agent): ActionProposal[] {
  return decisions(agent).map(record => record.proposal)
}

/** The permission rules' decision for each action, in log order. */
export function policies(agent: Agent): PolicyDecision[] {
  return decisions(agent).map(record => record.policy)
}

/** The composed authorization for each action, in log order. */
export function authorizations(agent: Agent): AuthorizationDecision[] {
  return decisions(agent).map(record => record.decision)
}

/** The composed authorizations that refused an action, in log order. */
export function denials(agent: Agent): AuthorizationDecision[] {
  return authorizations(agent).filter(decision => decision.effect === 'deny')
}

/**
 * Every task transition recorded for one agent, in log order.
 * @param agent - the agent whose session is read.
 * @returns the transitions.
 */
export function transitions(agent: Agent): StateTransition[] {
  return eventsOf(agent, 'task/transitioned')
}

/**
 * The current task contract folded from one agent's log.
 * @param agent - the agent whose session is read.
 * @returns the latest task contract.
 * @throws When the log holds no `task/created` event.
 */
export function currentTask(agent: Agent): TaskContract {
  const created = eventsOf(agent, 'task/created').at(-1)
  if (created === undefined) throw new Error('spec: agent has no task contract')
  let task = created
  for (const transition of transitions(agent)) {
    if (transition.taskRevision === task.revision) task = { ...task, status: transition.to, revision: transition.revision }
  }
  return task
}

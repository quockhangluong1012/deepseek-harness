/** Shared pre-step driving and assertions for the repo-map suites. */
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Drive one pre-step through the composed listeners with one user task. */
export async function preStep(agent: Agent, task = 'add an auth controller guard'): Promise<PreStepDecision> {
  const message = createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })
  return await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
    messages: [message],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
}

/** The injected map text one pre-step decision carries, when it carries one. */
export function mapTextOf(decision: PreStepDecision): string | undefined {
  if (decision.kind !== 'enter') return undefined
  const injected = decision.messages.at(-1)
  if (injected === undefined || injected.source.kind !== 'repo-map') return undefined
  return injected.content.map(block => block.type === 'text' ? block.text : '').join('')
}

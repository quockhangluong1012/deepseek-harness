/** Test-only subagent provider that records every start request for assertions. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

/** Start requests received since the last reset; the owning spec clears it. */
export const recordedStarts: SubagentStartRequest[] = []

export const name = 'recording-subagent-provider'
export const inject = ['subagents']

/** Fixture configuration: the registry name to occupy and the child's reply. */
export interface Config {
  /** Provider name the delegation tool selects. */
  name: string
  /** Final text the recorded child returns. */
  reply?: string
}

export const Config: z<Config> = z.object({
  name: z.string().required(),
  reply: z.string().default('recorded subagent reply'),
})

/** Register the recording provider under the configured name. */
export function apply(ctx: Context, config: Config): void {
  const provider: SubagentProvider = {
    name: config.name,
    capabilities: {
      agentOptions: true,
      outputSchema: false,
      depthLimit: true,
      toolFilter: true,
      persona: true,
      workerLimits: false,
    },
    inheritsParentContext: false,
    start(request: SubagentStartRequest): Promise<SubagentRun> {
      recordedStarts.push(request)
      return Promise.resolve({
        id: SessionId(`recorded-subagent:${request.parent.id}`),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: config.reply ?? 'recorded subagent reply' }],
          stopReason: 'completed' as const,
        }),
        dispose: () => Promise.resolve(),
      })
    },
  }
  ctx.subagents.registerProvider(provider)
}

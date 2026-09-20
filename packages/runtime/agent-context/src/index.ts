/**
 * The context compiler: a knowledge-plane plugin that observes the prompt
 * assembly `core/system-prompt` already produces and records what a model step
 * was actually compiled from.
 *
 * The plugin owns no prompt contribution and no model request. It wraps every
 * assembled section and runtime context in a source envelope, adds the durable
 * task facts `dsh-agent-kernel` derives from the same session log, ranks and
 * prices them, cuts the placement at a configured token ceiling, and appends
 * one log-only `context/compiled` record per assembly. `mode: 'shadow'` (the
 * default) records the placement and returns the assembly unchanged;
 * `mode: 'apply'` also drops the sources the ceiling cut.
 *
 * @module @deepseek-ai/dsh-agent-context
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: activates the `ctx.agentKernel` Context declaration.
import type {} from '@deepseek-ai/dsh-agent-kernel'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { DefaultContextCompiler, recordOf } from './compile.ts'
import type { ContextCompiler } from './compile.ts'
import { sourcesFromView } from './sources.ts'
import type { CompiledContext } from './types.ts'

export type * from './types.ts'
export { CONTEXT_COMPILER_VERSION } from './compile.ts'
export type { ContextCompileInput, ContextCompiler } from './compile.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'agent-context'

/**
 * Plugin configuration. A compiler mounted with no configuration records every
 * placement and changes nothing, so a deployment measures a ceiling against
 * real traffic before it can drop any of it.
 */
export interface Config {
  /** Whether the cut placement is only recorded (`shadow`) or also applied to the assembly (`apply`). */
  mode?: 'shadow' | 'apply'
  /** Token ceiling one compiled placement may price at; unset means unbounded. */
  maxContextTokens?: number
}

/** Runtime configuration schema for the agent-context plugin. */
export const Config: z<Config> = z.object({
  mode: z.union(['shadow', 'apply'] as const).default('shadow'),
  maxContextTokens: z.number(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentContext: AgentContextService
  }
}

/**
 * The compiler service (`ctx.agentContext`). It attaches to the prompt
 * assembly waterfall in its constructor, so unloading the plugin unloads the
 * listener with it.
 */
export class AgentContextService extends Service {
  static Config: z<Config> = Config
  /** The pure compiler a caller can drive over any assembly. */
  readonly compiler: ContextCompiler
  private readonly mode: 'shadow' | 'apply'
  private readonly maxContextTokens: number | null

  /**
   * @param ctx - plugin context; the assembly listener is scoped to it.
   * @param config - validated plugin configuration; the Loader passes none when
   *   the entry declares no `config:` block.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentContext')
    this.compiler = new DefaultContextCompiler()
    this.mode = config.mode ?? 'shadow'
    this.maxContextTokens = config.maxContextTokens ?? null
    // The returned value is authoritative, so the placement is compiled from
    // `next()`'s assembly rather than the providers' pre-waterfall one.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const final = await next()
      return this.place(final, context)
    })
  }

  /**
   * Compile one assembly for a live agent and record the placement.
   * @param agent - the agent the assembly is for.
   * @param assembly - the assembled prompt contributions.
   * @returns the placement, already appended as `context/compiled`.
   */
  async compile(agent: Agent, assembly: PromptAssembly): Promise<CompiledContext> {
    const session = agent.session
    // Optional: the compiler still records a placement when no kernel is
    // mounted, but then it has no durable task facts to make required.
    const view = this.ctx.get('agentKernel')?.state.view(session)
    const compiled = await this.compiler.compile({
      assembly,
      sources: sourcesFromView(view),
      objective: view?.task.objective ?? '',
      maxTokens: this.maxContextTokens,
    })
    session.append('context/compiled', recordOf(compiled, this.maxContextTokens))
    return compiled
  }

  /**
   * Record one assembly, and in `apply` mode return it with the cut sources removed.
   * @param assembly - the post-waterfall assembly.
   * @param context - the assembly context naming the agent, when one is assembled for.
   * @returns the assembly the loop should render.
   */
  private async place(assembly: PromptAssembly, context: AssembleContext): Promise<PromptAssembly> {
    const agent = context.agent
    // A diagnostics assembly belongs to no agent, so it has no session to record against.
    if (agent === undefined) return assembly
    const compiled = await this.compile(agent, assembly)
    if (this.mode === 'shadow') return assembly
    const placed = new Set(compiled.included.map(entry => entry.source.id))
    return {
      ...assembly,
      sections: assembly.sections.filter(section => placed.has(section.name)),
      contexts: assembly.contexts.filter(entry => placed.has(entry.name)),
    }
  }
}

export default AgentContextService

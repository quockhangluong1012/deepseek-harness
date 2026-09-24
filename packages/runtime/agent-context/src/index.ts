/**
 * The context compiler: a knowledge-plane plugin that observes the prompt
 * assembly `core/system-prompt` already produces and records what a model step
 * was actually compiled from.
 *
 * The plugin owns no prompt contribution and no model request. It wraps every
 * assembled section and runtime context in a source envelope, adds the durable
 * task facts `dsh-agent-kernel` derives from the same session log, ranks and
 * prices them, cuts the placement at a configured token ceiling, and appends
 * one log-only `context/compiled` record per distinct placement: an assembly
 * whose digest repeats the session's previous record appends nothing. `mode: 'shadow'` (the
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
// Type-only: activates the `compaction/end` Session event declaration.
import type {} from '@deepseek-ai/dsh-compaction'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { DefaultContextCompiler, recordOf } from './compile.ts'

/**
 * The digest of the session's most recent compilation record.
 * @param session - the session whose log is read.
 * @returns the recorded digest, or undefined when the session has no record yet.
 */
function lastCompiledDigest(session: Agent['session']): string | undefined {
  const records = session.snapshotEvents()
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]
    if (event?.type === 'context/compiled') return event.data.digest
  }
  return undefined
}
import type { ContextCompiler } from './compile.ts'
import { filterDelta, dropExpired, sourceOf } from './registry.ts'
import type { ContextSourceDescriptor, ContextSourceProvider, ContextSourceRegistry } from './registry.ts'
import { sourcesFromView } from './sources.ts'
import type { CompiledContext, ContextSource } from './types.ts'

export type * from './types.ts'
export { CONTEXT_COMPILER_VERSION } from './compile.ts'
export type { ContextCompileInput, ContextCompiler } from './compile.ts'
export { dropExpired, filterDelta, retentionOfPlacement, sourceOf } from './registry.ts'
export type { ContextItem, ContextPlacement, ContextSourceDescriptor, ContextSourceProvider, ContextSourceRegistry } from './registry.ts'

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
export class AgentContextService extends Service implements ContextSourceRegistry {
  static Config: z<Config> = Config
  /** The pure compiler a caller can drive over any assembly. */
  readonly compiler: ContextCompiler
  private readonly mode: 'shadow' | 'apply'
  private readonly maxContextTokens: number | null
  private readonly registrations = new Map<string, { descriptor: ContextSourceDescriptor; provide: ContextSourceProvider }>()
  private nextRegistrationId = 0
  /** Delta-placement item keys (`producer\0itemId`) already surfaced, per session id. */
  private readonly seen = new Map<string, Set<string>>()

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
    // Compaction removes verbose history, so a delta item it dropped is no
    // longer "already surfaced" — the session may see it again.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'compaction/end') this.seen.delete(String(session.id))
    })
  }

  /**
   * Register one producer's descriptor and item supplier (S2). The compiler
   * places its items alongside the assembly and the kernel's task facts on
   * every later compile, until the disposer runs.
   * @param descriptor - the producer's source descriptor.
   * @param provide - the item supplier, called once per compile.
   * @returns a disposer that unregisters the producer.
   */
  register(descriptor: ContextSourceDescriptor, provide: ContextSourceProvider): () => void {
    const id = `${descriptor.producer}#${this.nextRegistrationId}`
    this.nextRegistrationId += 1
    this.registrations.set(id, { descriptor, provide })
    return () => { this.registrations.delete(id) }
  }

  /**
   * Collect every registered producer's items for one compile, dropping
   * expired items and — for `delta` placement — items this session already
   * surfaced, then recording the newly surfaced ones.
   * @param agent - the agent the compile is for.
   * @param signal - cancellation forwarded to every provider.
   * @returns the registered items wrapped as context sources.
   */
  private async collectRegistered(agent: Agent, signal: AbortSignal): Promise<ContextSource[]> {
    const sessionKey = String(agent.session.id)
    const already = this.seen.get(sessionKey) ?? new Set<string>()
    const now = new Date().toISOString()
    const sources: ContextSource[] = []
    const newlySeen = new Set<string>()
    for (const { descriptor, provide } of this.registrations.values()) {
      const items = dropExpired(await provide(agent, signal), now)
      const eligible = filterDelta(descriptor.placement, already, descriptor.producer, items)
      for (const item of eligible) {
        sources.push(sourceOf(descriptor, item))
        if (descriptor.placement === 'delta') newlySeen.add(`${descriptor.producer}\0${item.id}`)
      }
    }
    if (newlySeen.size > 0) {
      for (const key of already) newlySeen.add(key)
      this.seen.set(sessionKey, newlySeen)
    }
    return sources
  }

  /**
   * Compile one assembly for a live agent and record the placement.
   * @param agent - the agent the assembly is for.
   * @param assembly - the assembled prompt contributions.
   * @param signal - cancellation forwarded to every registered provider.
   * @returns the placement, already appended as `context/compiled`.
   */
  async compile(agent: Agent, assembly: PromptAssembly, signal: AbortSignal = new AbortController().signal): Promise<CompiledContext> {
    const session = agent.session
    // Optional: the compiler still records a placement when no kernel is
    // mounted, but then it has no durable task facts to make required.
    const view = this.ctx.get('agentKernel')?.state.view(session)
    const registered = await this.collectRegistered(agent, signal)
    const compiled = await this.compiler.compile({
      assembly,
      sources: [...sourcesFromView(view), ...registered],
      objective: view?.task.objective ?? '',
      maxTokens: this.maxContextTokens,
    })
    // One record per distinct placement: an assembly whose digest matches the
    // session's previous record adds nothing a reader could learn from, so the
    // durable digest is read back from the log rather than kept in memory.
    const record = recordOf(compiled, this.maxContextTokens)
    if (lastCompiledDigest(session) !== record.digest) session.append('context/compiled', record)
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
    const compiled = await this.compile(agent, assembly, context.signal)
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

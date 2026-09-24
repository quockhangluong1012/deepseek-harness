/**
 * The context compiler: a knowledge-plane plugin that observes the prompt
 * assembly `core/system-prompt` already produces and records what a model step
 * was actually compiled from.
 *
 * The plugin owns no prompt contribution and no model request. It wraps every
 * assembled section and runtime context in a source envelope, adds the durable
 * task facts `dsh-agent-kernel` derives from the same session log, ranks and
 * prices them, cuts the placement at a configured token ceiling, and appends
 * a log-only `context/compiled` record for each new placement. A delta source
 * resurfaced after compaction is recorded again even when its digest repeats.
 * `mode: 'shadow'` (the default) records the placement and returns the assembly
 * unchanged; `mode: 'apply'` also drops the sources the ceiling cut.
 *
 * @module @deepseek-ai/dsh-agent-context
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: activates the `ctx.agentKernel` Context declaration.
import type {} from '@deepseek-ai/dsh-agent-kernel'
// Type-only: activates the `compaction/end` Session event declaration.
import type {} from '@deepseek-ai/dsh-compaction'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection'
import { DefaultContextCompiler, recordOf } from './compile.ts'

import type { ContextCompiler } from './compile.ts'
import { filterDelta, dropExpired, sourceOf } from './registry.ts'
import type { ContextSourceDescriptor, ContextSourceProvider, ContextSourceRegistry } from './registry.ts'
import { sourcesFromView } from './sources.ts'
import type { CompiledContext, ContextSource, ContextSourceKind } from './types.ts'

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
/** Context source identities selected since compaction and the last placement digest. */
interface ContextSourcePlacementState {
  /** Source ids included during the current compaction epoch. */
  readonly sourceIds: readonly string[]
  /** Digest of the last compiled placement, or `null` before the first compile. */
  readonly lastDigest: string | null
  /** Compressible source ids the ceiling placed in the current request series (S1 point 5). */
  readonly includedIds: readonly string[]
  /** Compressible source ids the ceiling cut in the current request series (S1 point 5). */
  readonly cutIds: readonly string[]
  /** Token total by source kind of the newest recorded placement (S1). */
  readonly tokensByKind: Readonly<Partial<Record<ContextSourceKind, number>>>
  /** Distinct placements recorded for the session; a new digest supersedes the last (S1). */
  readonly placementCount: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Context sources already placed and the placement digest for this session. */
    contextSourcePlacement: ContextSourcePlacementState
  }
}

const contextSourcePlacementSchema = zod.object({
  sourceIds: zod.array(zod.string()),
  lastDigest: zod.string().nullable(),
  includedIds: zod.array(zod.string()),
  cutIds: zod.array(zod.string()),
  tokensByKind: zod.record(zod.string(), zod.number()),
  placementCount: zod.number(),
})

const contextSourcePlacement: ProjectionDefinition<'contextSourcePlacement', ContextSourcePlacementState> = {
  key: 'contextSourcePlacement',
  stateVersion: 3,
  stateSchema: contextSourcePlacementSchema,
  init: () => ({ sourceIds: [], lastDigest: null, includedIds: [], cutIds: [], tokensByKind: {}, placementCount: 0 }),
  apply: (state, event) => {
    if (event.type === 'compaction/end') {
      // Keep the digest and token totals so a resurfaced delta can append the
      // new epoch's placement; clear the budget hysteresis with the same
      // boundary (S1 point 5). The placement count is lifetime, not per-epoch.
      if (state.sourceIds.length === 0 && state.includedIds.length === 0 && state.cutIds.length === 0) return state
      return { ...state, sourceIds: [], includedIds: [], cutIds: [] }
    }
    if (event.type !== 'context/compiled') return state
    const sourceIds = new Set(state.sourceIds)
    const includedIds = new Set(state.includedIds)
    const cutIds = new Set(state.cutIds)
    let changed = false
    for (const entry of event.data.included) {
      if (!sourceIds.has(entry.id)) {
        sourceIds.add(entry.id)
        changed = true
      }
      if (entry.retention === 'compressible' && !includedIds.has(entry.id)) {
        includedIds.add(entry.id)
        changed = true
      }
    }
    for (const omission of event.data.omitted) {
      if (omission.reason === 'budget' && !cutIds.has(omission.id)) {
        cutIds.add(omission.id)
        changed = true
      }
    }
    if (!changed && state.lastDigest === event.data.digest) return state
    const supersedes = state.lastDigest !== null && state.lastDigest !== event.data.digest
    // Recomputed fresh from this placement's own entries, not accumulated
    // across placements: the totals describe what is compiled now.
    const tokensByKind: Partial<Record<ContextSourceKind, number>> = {}
    for (const entry of event.data.included) {
      tokensByKind[entry.kind] = (tokensByKind[entry.kind] ?? 0) + entry.tokens
    }
    return {
      sourceIds: [...sourceIds],
      lastDigest: event.data.digest,
      includedIds: [...includedIds],
      cutIds: [...cutIds],
      tokensByKind,
      placementCount: state.placementCount + (state.lastDigest === null || supersedes ? 1 : 0),
    }
  },
}


/**
 * The compiler service (`ctx.agentContext`). It attaches to the prompt
 * assembly waterfall in its constructor, so unloading the plugin unloads the
 * listener with it.
 */
export class AgentContextService extends Service implements ContextSourceRegistry {
  static inject = ['sessionProjections']
  static Config: z<Config> = Config
  /** The pure compiler a caller can drive over any assembly. */
  readonly compiler: ContextCompiler
  private readonly mode: 'shadow' | 'apply'
  private readonly maxContextTokens: number | null
  private readonly registrations = new Map<string, { descriptor: ContextSourceDescriptor; provide: ContextSourceProvider }>()
  private nextRegistrationId = 0
  /** Latest successfully compiled source ids per live session. */
  private readonly includedSources = new WeakMap<Agent['session'], ReadonlySet<string>>()

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
    ctx.effect(
      () => ctx.sessionProjections.register(contextSourcePlacement),
      'agentContext.contextSourcePlacement',
    )
    // The returned value is authoritative, so the placement is compiled from
    // `next()`'s assembly rather than the providers' pre-waterfall one.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const final = await next()
      return this.place(final, context)
    })
    // Compaction starts a new recent-result selection for live consumers.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'compaction/end') this.includedSources.delete(session)
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
   * Test whether a source was included by this session's latest successful compile.
   * @param session - live session the compile recorded.
   * @param sourceId - source id returned by the compiler.
   * @returns whether the latest placement included the source.
   */
  isIncluded(session: Agent['session'], sourceId: string): boolean {
    return this.includedSources.get(session)?.has(sourceId) ?? false
  }

  /**
   * Per-source-kind token totals of the session's newest recorded placement
   * (S1), including registered-producer sources alongside assembled sections
   * and contexts — a registered source reaches the model through its own
   * producer's injection, not through this compiler, but its price is
   * accounted for here on the same terms as everything else compiled
   * alongside it. `placementCount` is how many distinct placements this
   * session has recorded; each new digest supersedes the one before it.
   * @param session - live session whose latest compile to read.
   * @returns token totals by kind, and the placement count.
   */
  tokenTotals(session: Agent['session']): {
    readonly byKind: Readonly<Partial<Record<ContextSourceKind, number>>>
    readonly placementCount: number
  } {
    const placement = this.ctx.sessionProjections.stateOf(session, 'contextSourcePlacement')
    return { byKind: placement?.tokensByKind ?? {}, placementCount: placement?.placementCount ?? 0 }
  }

  /**
   * Collect registered items and their newly eligible delta ids for one compile.
   * @param agent - the agent the compile is for.
   * @param signal - cancellation forwarded to every provider.
   * @param seenSourceIds - sources the session already included before this compile.
   * @returns source envelopes and delta ids for the compiler's inclusion result.
   */
  private async collectRegistered(
    agent: Agent,
    signal: AbortSignal,
    seenSourceIds: ReadonlySet<string>,
  ): Promise<{ sources: ContextSource[]; deltaSourceIds: Set<string> }> {
    const now = new Date().toISOString()
    const sources: ContextSource[] = []
    const deltaSourceIds = new Set<string>()
    for (const { descriptor, provide } of this.registrations.values()) {
      const items = dropExpired(await provide(agent, signal), now)
      const eligible = filterDelta(descriptor.placement, seenSourceIds, descriptor.producer, items)
      for (const item of eligible) {
        const source = sourceOf(descriptor, item)
        sources.push(source)
        if (descriptor.placement === 'delta') deltaSourceIds.add(source.id)
      }
    }
    return { sources, deltaSourceIds }
  }

  /**
   * Compile one assembly and record each new placement or delta resurface.
   * @param agent - the agent the assembly is for.
   * @param assembly - the assembled prompt contributions.
   * @param signal - cancellation forwarded to every provider.
   * @returns the compiled placement.
   */
  async compile(agent: Agent, assembly: PromptAssembly, signal: AbortSignal = new AbortController().signal): Promise<CompiledContext> {
    const session = agent.session
    const placement = this.ctx.sessionProjections.stateOf(session, 'contextSourcePlacement')
    const seenSourceIds = new Set(placement?.sourceIds ?? [])
    // Optional: the compiler still records a placement when no kernel is
    // mounted, but then it has no durable task facts to make required.
    const view = this.ctx.get('agentKernel')?.state.view(session)
    const registered = await this.collectRegistered(agent, signal, seenSourceIds)
    const compiled = await this.compiler.compile({
      assembly,
      sources: [...sourcesFromView(view), ...registered.sources],
      objective: view?.task.objective ?? '',
      maxTokens: this.maxContextTokens,
      hysteresis: { includedIds: new Set(placement?.includedIds ?? []), omittedIds: new Set(placement?.cutIds ?? []) },
    })
    const resurfacedDelta = compiled.included.some(entry => registered.deltaSourceIds.has(entry.source.id))
    const record = recordOf(compiled, this.maxContextTokens)
    // A surfaced delta is a new durable placement even when compaction left the digest unchanged.
    if (placement?.lastDigest !== record.digest || resurfacedDelta) session.append('context/compiled', record)
    this.includedSources.set(session, new Set(compiled.included.map(entry => entry.source.id)))
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

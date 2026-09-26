/**
 * The compile pipeline: collect the assembled contributions and the durable
 * task facts, score them against the objective, price and rank them, drop
 * duplicates, cut the placement at the ceiling, report disagreements, and
 * digest the result.
 *
 * The pipeline is deterministic. Nothing here reads a clock, a random source,
 * or the network, so the same sources compile to the same digest.
 *
 * @module @deepseek-ai/dsh-agent-context/compile
 */

import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { fitBudget, priceSources } from './budget.ts'
import type { BudgetHysteresis } from './budget.ts'
import { contentDigest, digestPlacement } from './digest.ts'
import { compareCompiled, compareText, scoreSources } from './rank.ts'
import { sourcesFromAssembly } from './sources.ts'
import { admitSources } from './tiers.ts'
import type {
  CompiledContext,
  CompiledSource,
  ContextCompilationEntry,
  ContextCompilationRecord,
  ContextConflict,
  ContextOmission,
  ContextSource,
  ContextTier,
  ContextTierDemand,
} from './types.ts'

/** The version of the placement rules a digest is attributable to. */
export const CONTEXT_COMPILER_VERSION = 'agent-context/1'

/** Everything one compile reads. */
export interface ContextCompileInput {
  /** The assembly `core/system-prompt` produced for this model step. */
  readonly assembly: PromptAssembly
  /** Durable sources beyond the assembly, normally the kernel view's task facts. */
  readonly sources?: readonly ContextSource[]
  /** The task objective relevance is scored against; empty means no scoring. */
  readonly objective?: string
  /** Token ceiling for the placement, or null for no ceiling. */
  readonly maxTokens?: number | null
  /** The prior compile's budget decision in this request series (S1 point 5), or absent at a series boundary. */
  readonly hysteresis?: BudgetHysteresis
  /** Tiers whose sources this compile withholds until `demand` admits them; absent withholds nothing. */
  readonly onDemandTiers?: readonly ContextTier[]
  /** What this compile asks for beyond the tiers it always places. */
  readonly demand?: ContextTierDemand
}

/** Compiles one model step's context from its contributors. */
export interface ContextCompiler {
  /**
   * Compile one placement.
   * @param input - the assembly, the durable sources, and the ceiling.
   * @returns the placed and omitted sources, the retained conflicts, and the placement digest.
   */
  compile(input: ContextCompileInput): Promise<CompiledContext>
}

/** The default compiler: pure, deterministic, and free of I/O. */
export class DefaultContextCompiler implements ContextCompiler {
  /**
   * Compile one placement.
   * @param input - the assembly, the durable sources, and the ceiling.
   * @returns the placement and its digest; a source set the compiler cannot
   *   place deterministically rejects rather than throwing synchronously.
   */
  compile(input: ContextCompileInput): Promise<CompiledContext> {
    return Promise.resolve().then(() => place(input))
  }
}

/**
 * Run the pipeline over one input.
 * @param input - the assembly, the durable sources, and the ceiling.
 * @returns the placement and its digest.
 * @throws When two sources share an id or a source carries no content.
 */
function place(input: ContextCompileInput): CompiledContext {
  const candidates = [...sourcesFromAssembly(input.assembly), ...input.sources ?? []]
  assertSources(candidates)
  const admission = admitSources(candidates, input.onDemandTiers ?? [], input.demand)
  const priced = priceSources(scoreSources(admission.admitted, input.objective ?? '')).sort(compareCompiled)
  const deduplicated = deduplicate(priced)
  const maxTokens = input.maxTokens ?? null
  const placement = fitBudget(deduplicated.kept, maxTokens, input.hysteresis)
  const conflicts = conflictsOf(placement.included)
  const omitted = [...deduplicated.omitted, ...placement.omitted]
  return {
    included: placement.included,
    omitted,
    deferred: admission.deferred,
    conflicts,
    tokenEstimate: placement.tokenEstimate,
    digest: digestPlacement(CONTEXT_COMPILER_VERSION, maxTokens, placement.included, omitted, conflicts),
    compilerVersion: CONTEXT_COMPILER_VERSION,
  }
}

/**
 * Project one placement into its durable record. The prompt text stays on the
 * `system/message` surface, so the record carries identities and prices only.
 * @param compiled - the placement to record.
 * @param maxTokens - the ceiling the placement was fitted to, or null.
 * @returns the record to append as `context/compiled`.
 */
export function recordOf(compiled: CompiledContext, maxTokens: number | null): ContextCompilationRecord {
  return {
    digest: compiled.digest,
    compilerVersion: compiled.compilerVersion,
    maxTokens,
    tokenEstimate: compiled.tokenEstimate,
    included: compiled.included.map(entryOf),
    omitted: compiled.omitted,
    conflicts: compiled.conflicts,
  }
}

/**
 * Reject a source set the compiler cannot place deterministically.
 * @param sources - the envelopes one compile will place.
 * @throws When two sources share an id or a source carries no content.
 */
function assertSources(sources: readonly ContextSource[]): void {
  const seen = new Set<string>()
  for (const source of sources) {
    if (source.content.length === 0) {
      throw new Error(`agent-context: context source "${source.id}" carries no content`)
    }
    if (seen.has(source.id)) {
      throw new Error(`agent-context: duplicate context source id "${source.id}"`)
    }
    seen.add(source.id)
  }
}

/** One placed source as the durable record keeps it. */
function entryOf(entry: CompiledSource): ContextCompilationEntry {
  return {
    id: entry.source.id,
    kind: entry.source.kind,
    trust: entry.source.trust,
    retention: entry.source.retention,
    tokens: entry.tokens,
    relevance: entry.relevance,
  }
}

/**
 * Drop a droppable source whose content an already-ranked source carries.
 * A required source is never dropped this way, so authority is never removed
 * because untrusted content happened to say the same thing.
 * @param ranked - the priced sources in placement order.
 * @returns the sources to keep and the duplicates to report.
 */
function deduplicate(ranked: readonly CompiledSource[]): { kept: CompiledSource[]; omitted: ContextOmission[] } {
  const seen = new Set<string>()
  const kept: CompiledSource[] = []
  const omitted: ContextOmission[] = []
  for (const entry of ranked) {
    const digest = contentDigest(entry.source.content)
    if (entry.source.retention === 'required' || !seen.has(digest)) {
      seen.add(digest)
      kept.push(entry)
      continue
    }
    omitted.push({ id: entry.source.id, reason: 'duplicate' })
  }
  return { kept, omitted }
}

/**
 * Report every claim the placement's required sources disagree about. Without a
 * declared subject there is no claim to compare, so the compiler reports
 * nothing rather than guessing at semantic equivalence.
 * @param included - the placed sources.
 * @returns one conflict per disputed subject, in subject order.
 */
function conflictsOf(included: readonly CompiledSource[]): ContextConflict[] {
  const bySubject = new Map<string, CompiledSource[]>()
  for (const entry of included) {
    const { subject, retention } = entry.source
    if (subject === undefined || retention !== 'required') continue
    const group = bySubject.get(subject)
    if (group === undefined) bySubject.set(subject, [entry])
    else group.push(entry)
  }
  const conflicts: ContextConflict[] = []
  for (const [subject, group] of bySubject) {
    if (group.length < 2) continue
    if (new Set(group.map(entry => contentDigest(entry.source.content))).size < 2) continue
    conflicts.push({ subject, sources: group.map(entry => entry.source.id) })
  }
  return conflicts.sort((a, b) => compareText(a.subject, b.subject))
}

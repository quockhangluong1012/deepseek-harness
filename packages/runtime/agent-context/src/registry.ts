/**
 * S2's context source registry: pre-step producers register a descriptor and
 * a provider instead of appending prompt sections directly, and the compiler
 * places their items alongside the assembly and the kernel's task facts.
 * Delta items are withheld only after a context/compiled record includes their
 * source id; compaction clears that placement history.
 * @module @deepseek-ai/dsh-agent-context/registry
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { ContextSource, ContextSourceKind, RetentionClass } from './types.ts'

/**
 * Where a registered source is placed. `stable-core` items are required on
 * every compile, including identity and recovery sources; `delta` items are
 * compressible and withheld after inclusion until compaction; `tail-reminder`
 * items are compressible and offered on every compile.
 */
export type ContextPlacement = 'stable-core' | 'delta' | 'tail-reminder'

/** One producer's registered source: what it is, and how it may be placed. */
export interface ContextSourceDescriptor {
  /** Registering plugin's stable name; prefixes every item id this producer contributes. */
  readonly producer: string
  /** What the source is for. */
  readonly kind: ContextSourceKind
  /** Whether the producer's content is instruction authority or data. */
  readonly trust: TrustLabel
  /** Placement class; governs delta dedup and drop order. */
  readonly placement: ContextPlacement
  /** Byte budget one item's rendered text is truncated to. */
  readonly maxBytes: number
}

/** One item a registered producer contributes to one compile. */
export interface ContextItem {
  /** Item identity, unique within its producer; deduplicates `delta` placement across compiles. */
  readonly id: string
  /** Rendered text; truncated to the descriptor's `maxBytes` before placement. */
  readonly text: string
  /** Lexical relevance in [0,1] the compiler's own ranking may still adjust. */
  readonly relevance: number
  /** ISO-8601 instant after which the item is no longer offered, or absent for no expiry. */
  readonly expiresAt?: string
}

/** A registered producer's item supplier for one compile. */
export type ContextSourceProvider = (agent: Agent, signal: AbortSignal) => Promise<readonly ContextItem[]>

/** Registration seam pre-step producers use instead of appending prompt sections directly. */
export interface ContextSourceRegistry {
  /**
   * Register one producer's descriptor and item supplier.
   * @param descriptor - the producer's source descriptor.
   * @param provide - the item supplier, called once per compile.
   * @returns a disposer that unregisters the producer.
   */
  register(descriptor: ContextSourceDescriptor, provide: ContextSourceProvider): () => void
}

/** Retention a placement class carries: only the producer's stable core resists a budget cut. */
export function retentionOfPlacement(placement: ContextPlacement): RetentionClass {
  return placement === 'stable-core' ? 'required' : 'compressible'
}
/**
 * Drop `delta` items whose source ids a session already placed.
 * @param placement - the producer's placement class.
 * @param seen - source ids (for example, `producer:itemId`) already included.
 * @param producer - the registering producer, for the source-id namespace.
 * @param items - the producer's items for this compile.
 * @returns the items still eligible for placement, in input order.
 */
export function filterDelta(
  placement: ContextPlacement,
  seen: ReadonlySet<string>,
  producer: string,
  items: readonly ContextItem[],
): readonly ContextItem[] {
  if (placement !== 'delta') return items
  return items.filter(item => !seen.has(`${producer}:${item.id}`))
}

/**
 * Drop an item past its expiry.
 * @param items - candidate items.
 * @param now - ISO-8601 instant to compare against.
 * @returns the items whose `expiresAt` is absent or still ahead of `now`.
 */
export function dropExpired(items: readonly ContextItem[], now: string): readonly ContextItem[] {
  return items.filter(item => item.expiresAt === undefined || item.expiresAt > now)
}

/**
 * Wrap one registered item as a context source envelope.
 * @param descriptor - the registering producer's descriptor.
 * @param item - the item to wrap.
 * @returns the envelope the compiler places alongside the assembly and the kernel's task facts.
 */
export function sourceOf(descriptor: ContextSourceDescriptor, item: ContextItem): ContextSource {
  const text = item.text.length > descriptor.maxBytes ? item.text.slice(0, descriptor.maxBytes) : item.text
  return {
    id: `${descriptor.producer}:${item.id}`,
    kind: descriptor.kind,
    content: text,
    trust: descriptor.trust,
    provenance: { source: 'tool', locator: descriptor.producer },
    retention: retentionOfPlacement(descriptor.placement),
  }
}

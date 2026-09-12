/**
 * Stable identity shared by every fallback switch in one step chain.
 * @module @deepseek-ai/dsh-llm-fallback/brand
 */

import { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque fallback-chain identity. */
export type FallbackId = Branded<'FallbackId'>

/**
 * Brand an implementation-minted fallback-chain identity.
 * @param id - opaque fallback identity.
 * @returns the branded identity.
 */
export function FallbackId(id: string): FallbackId {
  return id as FallbackId
}

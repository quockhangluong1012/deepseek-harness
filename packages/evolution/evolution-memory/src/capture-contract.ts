/**
 * Admission gate for skill proposals: a capture contract proves a proposed
 * skill carries both procedural evidence (what it was derived from) and
 * independent validation evidence (a separate check that it works). A
 * proposal whose validation merely restates its procedure, or that leans on
 * one source for both, is refused with the missing evidence named, so the
 * same proposal is not silently retried.
 * @module @deepseek-ai/dsh-evolution-memory/src/capture-contract
 */

import type { CaptureContract } from './types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type { CaptureContract } from './types.ts'

/**
 * Outcome of validating one staged skill payload's capture contract.
 */
export type CaptureContractVerdict =
  | { readonly ok: true; readonly contract: CaptureContract }
  | { readonly ok: false; readonly issues: readonly string[] }

/**
 * Read the non-empty strings of one contract field.
 * @param value - raw field value.
 * @returns the trimmed non-empty entries, or undefined when the field is not a usable list.
 */
function stringListOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) return undefined
    entries.push(entry.trim())
  }
  return entries
}

/**
 * Validate one staged skill payload's capture contract. Every check names
 * the evidence it needs, so a blocked proposal tells its approver exactly
 * what to supply.
 * @param value - the raw `contract` field of a skill-kind staged payload.
 * @returns the contract when it admits the skill, or the missing evidence.
 */
export function validateCaptureContract(value: unknown): CaptureContractVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['contract must be an object'] }
  }
  const fields = value as Record<string, unknown>
  const issues: string[] = []
  const capability = fields['capability']
  if (typeof capability !== 'string' || capability.trim().length === 0) {
    issues.push('capability must be a non-empty string')
  }
  const procedureRefs = stringListOf(fields['procedureRefs'])
  if (procedureRefs === undefined || procedureRefs.length === 0) {
    issues.push('procedureRefs must list at least one procedure')
  }
  const validationRefs = stringListOf(fields['validationRefs'])
  if (validationRefs === undefined || validationRefs.length === 0) {
    issues.push('validationRefs must list at least one independent validation')
  }
  if (procedureRefs !== undefined && validationRefs !== undefined) {
    const procedure = new Set(procedureRefs.map(ref => ref.toLowerCase()))
    const overlap = validationRefs.filter(ref => procedure.has(ref.toLowerCase()))
    if (overlap.length > 0) {
      issues.push(`validationRefs must be independent of procedureRefs (overlap: ${overlap.join(', ')})`)
    }
  }
  const validationSummary = fields['validationSummary']
  if (typeof validationSummary !== 'string' || validationSummary.trim().length === 0) {
    issues.push('validationSummary must be a non-empty string')
  }
  const limitations = fields['limitations']
  if (typeof limitations !== 'string' || limitations.trim().length === 0) {
    issues.push('limitations must be a non-empty string')
  }
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    contract: {
      capability: (capability as string).trim(),
      procedureRefs: procedureRefs as readonly string[],
      validationRefs: validationRefs as readonly string[],
      validationSummary: (validationSummary as string).trim(),
      limitations: (limitations as string).trim(),
    },
  }
}

/**
 * Materialize one validated contract as mutable JSON for a staged payload.
 * The durable payload type has no readonly arrays, so the store never keeps
 * the validator's readonly view by reference.
 * @param contract - validated admission evidence.
 * @returns the same evidence as a JSON object.
 */
export function contractJson(contract: CaptureContract): { [key: string]: JsonValue } {
  return {
    capability: contract.capability,
    procedureRefs: [...contract.procedureRefs],
    validationRefs: [...contract.validationRefs],
    validationSummary: contract.validationSummary,
    limitations: contract.limitations,
  }
}

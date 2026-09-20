import { describe, expect, it } from 'vitest'
import { contractJson, validateCaptureContract } from '../src/capture-contract.ts'

/** One fully valid contract the tests mutate. */
function valid(): Record<string, unknown> {
  return {
    capability: 'summarize test output',
    procedureRefs: ['/w/out.ts'],
    validationRefs: ['session s9 replay'],
    validationSummary: 'replay passed 3 scenarios',
    limitations: 'none known',
  }
}

describe('validateCaptureContract', () => {
  it('admits a valid contract and trims its text', () => {
    const verdict = validateCaptureContract({ ...valid(), capability: '  summarize  ' })
    expect(verdict).toEqual({
      ok: true,
      contract: {
        capability: 'summarize',
        procedureRefs: ['/w/out.ts'],
        validationRefs: ['session s9 replay'],
        validationSummary: 'replay passed 3 scenarios',
        limitations: 'none known',
      },
    })
  })

  it('refuses a non-object outright', () => {
    for (const value of ['contract', null, ['contract'], 42]) {
      expect(validateCaptureContract(value)).toEqual({ ok: false, issues: ['contract must be an object'] })
    }
  })

  it('names every missing field at once', () => {
    expect(validateCaptureContract({})).toEqual({
      ok: false,
      issues: [
        'capability must be a non-empty string',
        'procedureRefs must list at least one procedure',
        'validationRefs must list at least one independent validation',
        'validationSummary must be a non-empty string',
        'limitations must be a non-empty string',
      ],
    })
  })

  it('refuses blank text and mistyped fields', () => {
    const verdict = validateCaptureContract({
      capability: '   ',
      procedureRefs: 'not a list',
      validationRefs: ['ok', ''],
      validationSummary: 7,
      limitations: [],
    })
    expect(verdict).toEqual({
      ok: false,
      issues: [
        'capability must be a non-empty string',
        'procedureRefs must list at least one procedure',
        'validationRefs must list at least one independent validation',
        'validationSummary must be a non-empty string',
        'limitations must be a non-empty string',
      ],
    })
  })

  it('refuses empty ref lists', () => {
    const verdict = validateCaptureContract({ ...valid(), procedureRefs: [], validationRefs: [] })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.issues).toEqual([
        'procedureRefs must list at least one procedure',
        'validationRefs must list at least one independent validation',
      ])
    }
  })

  it('refuses validation that restates the procedure, case-insensitively', () => {
    const verdict = validateCaptureContract({ ...valid(), validationRefs: ['other', '/W/OUT.ts'] })
    expect(verdict).toEqual({
      ok: false,
      issues: ['validationRefs must be independent of procedureRefs (overlap: /W/OUT.ts)'],
    })
  })

  it('materializes a validated contract as mutable JSON', () => {
    const verdict = validateCaptureContract(valid())
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(contractJson(verdict.contract)).toEqual({ ...valid() })
    }
  })
})

import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/index.ts'

describe('evolution-reviewer config', () => {
  it('rejects a lone provider without a model', () => {
    expect(() => resolveConfig({ provider: 'deepseek' })).toThrow()
    expect(() => resolveConfig({ model: 'chat' })).toThrow()
  })

  it('accepts defaults and a complete pair', () => {
    expect(resolveConfig({}).enabled).toBe(true)
    expect(resolveConfig().profile).toBe('default')
    expect(resolveConfig().writeApproval).toBe(false)
    expect(resolveConfig({ provider: 'p', model: 'm' }).provider).toBe('p')
  })

  it('rejects a malformed profile', () => {
    expect(() => resolveConfig({ profile: '' })).toThrow('profile must be non-empty')
    expect(() => resolveConfig({ profile: 'a:b' })).toThrow("must not contain ':'")
  })

  it('defaults to the defer queue with a 30-minute ceiling', () => {
    expect(Config({}).defer).toBe('auto')
    expect(Config({}).deferMaxAgeMs).toBe(1800000)
    expect(resolveConfig({}).defer).toBe('auto')
    expect(resolveConfig({}).deferMaxAgeMs).toBe(1800000)
    expect(resolveConfig({ defer: 'never', deferMaxAgeMs: 0 })).toMatchObject({ defer: 'never', deferMaxAgeMs: 0 })
  })

  it('rejects an unknown defer mode and a negative defer ceiling', () => {
    expect(() => Config({ defer: 'sometimes' as never })).toThrow()
    expect(() => Config({ deferMaxAgeMs: -1 })).toThrow()
  })

  it('defaults the recall, relevance, and output budgets', () => {
    expect(resolveConfig({})).toMatchObject({
      maxOutputTokens: 2048,
      recallLimit: 20,
      recallQueryChars: 160,
      relevantArtifactLimit: 20,
    })
    expect(Config({}).relevantArtifactLimit).toBe(20)
    expect(resolveConfig({ recallLimit: 3, recallQueryChars: 40, relevantArtifactLimit: 5 })).toMatchObject({
      recallLimit: 3,
      recallQueryChars: 40,
      relevantArtifactLimit: 5,
    })
    // A window of zero would show the model no artifact to decide about.
    expect(() => Config({ relevantArtifactLimit: 0 })).toThrow()
  })
})

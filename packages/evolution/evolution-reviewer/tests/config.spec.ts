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

  it('defaults the recall and squeeze budgets', () => {
    expect(resolveConfig({})).toMatchObject({
      recallLimit: 20,
      recallQueryChars: 160,
      squeezeBytes: 65536,
    })
    expect(resolveConfig({}).squeezeOrder).toEqual(['## References', '## Decisions', '## Preferences', '## Purpose'])
    expect(resolveConfig({ recallLimit: 3, recallQueryChars: 40, squeezeBytes: 512 }).squeezeBytes).toBe(512)
  })

  it('rejects a pressure order that drops a lesson heading', () => {
    expect(() => resolveConfig({ squeezeOrder: ['## Purpose'] }))
      .toThrow('must list exactly the lessons headings')
    expect(() => resolveConfig({ squeezeOrder: ['## Purpose', '## Preferences', '## Decisions', '## Elsewhere'] }))
      .toThrow('must list exactly the lessons headings')
    expect(() => resolveConfig({ squeezeOrder: ['## Purpose', '## Preferences', '## Decisions', '## References'] }))
      .not.toThrow()
  })
})

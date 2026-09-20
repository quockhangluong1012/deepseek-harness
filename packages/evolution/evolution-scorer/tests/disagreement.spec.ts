import { describe, expect, it } from 'vitest'
import { evaluatorDisagreement } from '../src/disagreement.ts'

describe('evaluatorDisagreement', () => {
  it('reports unanimous approval and unanimous rejection', () => {
    expect(evaluatorDisagreement([
      { channel: 'routing', ok: true },
      { channel: 'contract', ok: true },
      { channel: 'replay', ok: true },
    ])).toEqual({ unanimous: true, approving: ['contract', 'routing', 'replay'], dissenting: [] })
    expect(evaluatorDisagreement([
      { channel: 'contract', ok: false },
      { channel: 'routing', ok: false },
    ])).toEqual({ unanimous: true, approving: [], dissenting: ['contract', 'routing'] })
  })

  it('names the dissenting channel on a split verdict', () => {
    expect(evaluatorDisagreement([
      { channel: 'replay', ok: false },
      { channel: 'routing', ok: true },
      { channel: 'contract', ok: true },
    ])).toEqual({ unanimous: false, approving: ['contract', 'routing'], dissenting: ['replay'] })
  })

  it('orders a lone channel trivially unanimous and refuses zero channels', () => {
    expect(evaluatorDisagreement([{ channel: 'routing', ok: true }]))
      .toEqual({ unanimous: true, approving: ['routing'], dissenting: [] })
    expect(() => evaluatorDisagreement([])).toThrow('at least one channel verdict')
  })
})

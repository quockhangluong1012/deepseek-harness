import { describe, expect, it } from 'vitest'
import { evaluatorDisagreement } from '../src/disagreement.ts'
import type { DisagreementChannel } from '../src/types.ts'

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

  it('sorts an unknown channel after the canonical set', () => {
    expect(evaluatorDisagreement([
      { channel: 'bonus' as DisagreementChannel, ok: true },
      { channel: 'replay', ok: false },
    ])).toEqual({ unanimous: false, approving: ['bonus'], dissenting: ['replay'] })
    // Two unknown channels exercise both fallback operands of the sort.
    expect(evaluatorDisagreement([
      { channel: 'x' as DisagreementChannel, ok: true },
      { channel: 'y' as DisagreementChannel, ok: false },
    ])).toEqual({ unanimous: false, approving: ['x'], dissenting: ['y'] })
  })
})

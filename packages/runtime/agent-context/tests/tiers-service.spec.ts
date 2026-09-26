/**
 * The service-side tier gate: a registered producer's lower tier is withheld
 * from the placement until a caller admits it, and withheld again once the
 * caller withdraws the demand.
 */
import { describe, expect, it } from 'vitest'
import type { ContextCompileInput } from '../src/compile.ts'
import { makeAgent, rig } from './rig.ts'

/** An empty assembly; the service's own registrations carry the candidates. */
const EMPTY_ASSEMBLY: ContextCompileInput['assembly'] = { sections: [], contexts: [], tools: [], variables: {} }

describe('the service demand', () => {
  it('withholds a registered lower tier until a caller admits it', async () => {
    const { ctx, service } = await rig({ onDemandTiers: ['L3'] })
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'memory', kind: 'memory', trust: 'untrusted', placement: 'tail-reminder', maxBytes: 4000 },
      () => Promise.resolve([{ id: 'one', text: 'a remembered fact', relevance: 1 }]),
    )

    const withheld = await service.compile(agent, EMPTY_ASSEMBLY)
    expect(withheld.included).toEqual([])
    expect(withheld.deferred).toEqual([{ id: 'memory:one', kind: 'memory', tier: 'L3' }])

    const withdraw = service.admit(agent.session, { sourceIds: ['memory:one'] })
    const admitted = await service.compile(agent, EMPTY_ASSEMBLY)
    expect(admitted.included.map(entry => entry.source.id)).toEqual(['memory:one'])
    expect(admitted.deferred).toEqual([])

    withdraw()
    const released = await service.compile(agent, EMPTY_ASSEMBLY)
    expect(released.included).toEqual([])
    expect(released.deferred).toEqual([{ id: 'memory:one', kind: 'memory', tier: 'L3' }])
  })

  it('rejects a configured tier that is not a tier', async () => {
    await expect(rig({ onDemandTiers: ['L9'] as never })).rejects.toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { DEPLOYMENT_STATES, nextStage, transitionAllowed } from '../src/stages.ts'

describe('nextStage', () => {
  it('walks the rollout ladder and ends at the exits', () => {
    expect(nextStage('shadow')).toBe('canary')
    expect(nextStage('canary')).toBe('promoted')
    expect(nextStage('promoted')).toBeNull()
    expect(nextStage('rolled-back')).toBeNull()
    expect(nextStage('rejected')).toBeNull()
  })
})

describe('transitionAllowed', () => {
  it('advances one ladder step and allows the staged exits', () => {
    expect(transitionAllowed('shadow', 'canary')).toBe(true)
    expect(transitionAllowed('canary', 'promoted')).toBe(true)
    expect(transitionAllowed('shadow', 'rejected')).toBe(true)
    expect(transitionAllowed('canary', 'rolled-back')).toBe(true)
  })

  it('forbids skipping, terminal exits, and cross exits', () => {
    expect(transitionAllowed('shadow', 'promoted')).toBe(false)
    expect(transitionAllowed('canary', 'rejected')).toBe(false)
    expect(transitionAllowed('shadow', 'rolled-back')).toBe(false)
    expect(transitionAllowed('promoted', 'shadow')).toBe(false)
    expect(transitionAllowed('rejected', 'canary')).toBe(false)
  })

  it('covers the topology in ladder order', () => {
    expect(DEPLOYMENT_STATES).toEqual(['shadow', 'canary', 'promoted', 'rolled-back', 'rejected'])
  })
})

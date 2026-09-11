// @vitest-environment jsdom
/**
 * What the current-session panel draws: the live session header and its
 * cumulative stat cards — no filter, no Remote fetch, no cross-session table.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { UsageDashboard } from '../src/client/UsageDashboard.tsx'
import { harness } from './fixtures.client.ts'

afterEach(cleanup)

function text(container: HTMLElement, selector: string): string | null {
  return container.querySelector(selector)?.textContent ?? null
}

describe('UsageDashboard — current session', () => {
  it('draws the session header from the live projections', () => {
    const h = harness()
    const view = render(<UsageDashboard {...h.props()} />)
    expect(view.container.querySelector('[data-usage-state]')?.getAttribute('data-usage-state')).toBe('ready')
    expect(text(view.container, '[data-usage-session-line]')).toBe(
      'session.requests: 4 · session.input: 130 · session.output: 50 · session.cacheHit: 15.4%',
    )
  })

  it('draws cumulative session cards beside the header', () => {
    const h = harness()
    const view = render(<UsageDashboard {...h.props()} />)
    expect(text(view.container, '[data-usage-section="cards"]')).toContain('4')
    expect(text(view.container, '[data-usage-section="cards"]')).toContain('130')
    expect(text(view.container, '[data-usage-section="cards"]')).toContain('50')
    expect(text(view.container, '[data-usage-section="cards"]')).toContain('15.4%')
  })

  it('zeroes the session figures without projections', () => {
    const h = harness({}, {})
    const view = render(<UsageDashboard {...h.props()} />)
    expect(text(view.container, '[data-usage-session-line]')).toBe(
      'session.requests: 0 · session.input: 0 · session.output: 0 · session.cacheHit: 0.0%',
    )
    expect(text(view.container, '[data-usage-section="cards"]')).toContain('0.0%')
  })

  it('carries no range filter and performs no fetch', () => {
    const h = harness()
    const view = render(<UsageDashboard {...h.props()} />)
    expect(view.container.querySelector('[data-usage-section="filter"]')).toBeNull()
    expect(view.container.querySelector('[data-usage-section="chart"]')).toBeNull()
    expect(view.container.querySelector('[data-usage-section="models"]')).toBeNull()
    expect(h.fetch).not.toHaveBeenCalled()
  })
})

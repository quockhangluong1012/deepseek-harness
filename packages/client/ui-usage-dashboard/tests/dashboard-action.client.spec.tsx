// @vitest-environment jsdom
/**
 * The left-sidebar Dashboard entry: the footer trigger row plus the
 * full-viewport all-sessions panel — the range filter, the window cards, the
 * stacked chart, the model table, the loading/failure states, and the close
 * paths.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DashboardAction, DASHBOARD_OVERLAY_ID } from '../src/client/DashboardAction.tsx'
import { emptyDay, failure, harness, settle, summary } from './fixtures.client.ts'

afterEach(cleanup)

function text(container: HTMLElement, selector: string): string | null {
  return container.querySelector(selector)?.textContent ?? null
}

function click(container: HTMLElement, selector: string): void {
  const button = container.querySelector<HTMLButtonElement>(selector)
  if (button === null) throw new Error(`expected ${selector}`)
  fireEvent.click(button)
}

describe('DashboardAction — trigger', () => {
  it('renders the Dashboard label wide and icon-only on the rail', () => {
    const h = harness()
    const wide = render(<DashboardAction {...h.overlayProps(true)} />)
    expect(text(wide.container, '[data-dashboard-action="trigger"]')).toContain('action.open')
    expect(wide.container.querySelector('[data-dashboard-action="overlay"]')).toBeNull()
    wide.unmount()
    const rail = render(<DashboardAction {...h.overlayProps(false)} />)
    expect(rail.container.querySelector('[data-dashboard-action="trigger"]')?.getAttribute('aria-label')).toBe('action.open')
    expect(rail.container.querySelector('[data-dashboard-action="trigger"]')?.textContent).toBe('')
  })
})

describe('DashboardAction — all-sessions overlay', () => {
  it('opens the dialog on trigger click and draws cards, chart, and table', async () => {
    const h = harness({ today: { ok: true, value: summary('today') } })
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('overlay.title')
    expect(view.container.querySelector('[data-usage-summary="loading"]')).not.toBeNull()
    await settle()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.fetch).toHaveBeenCalledWith('today', expect.any(AbortSignal))
    expect(text(view.container, '[data-usage-section="cards"]')).toContain('3')
    expect(text(view.container, '[data-usage-section="cards"]')).toContain('1,300')
    expect(view.container.querySelectorAll('[data-usage-day]')).toHaveLength(2)
    expect(view.container.querySelector('[data-usage-model="deepseek/deepseek-chat"]')).not.toBeNull()
    expect(view.container.querySelector('[data-usage-no-data]')).toBeNull()
  })

  it('switches ranges through the filter and reuses settled summaries', async () => {
    const h = harness({ today: { ok: true, value: summary('today') }, '7d': { ok: true, value: summary('7d') } })
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    click(view.container, '[data-usage-filter="7d"]')
    await settle()
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.fetch).toHaveBeenLastCalledWith('7d', expect.any(AbortSignal))
    expect(view.container.querySelector('[data-usage-filter="7d"]')?.getAttribute('aria-pressed')).toBe('true')
    click(view.container, '[data-usage-filter="today"]')
    await settle()
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('frames an empty chart with the no-data line and the empty table', async () => {
    const h = harness({ today: { ok: true, value: emptyDay('today') } })
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    expect(view.container.querySelector('[data-usage-chart]')?.getAttribute('data-usage-chart')).toBe('empty')
    expect(text(view.container, '[data-usage-no-data]')).toBe('chart.noData')
    expect(text(view.container, '[data-usage-models-empty]')).toBe('table.empty')
    expect(view.container.querySelector('[data-usage-day="2026-09-09"]')).not.toBeNull()
  })

  it('draws an empty frame when the window has no days at all', async () => {
    const h = harness({ all: { ok: true, value: { ...emptyDay('all'), daily: [] } } })
    h.instance.actions.selectRange(DASHBOARD_OVERLAY_ID, 'all')
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    expect(view.container.querySelectorAll('[data-usage-day]')).toHaveLength(0)
    expect(text(view.container, '[data-usage-no-data]')).toBe('chart.noData')
  })

  it('reports a failed fetch with a retry that reloads the range', async () => {
    const h = harness({ today: failure() })
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    expect(text(view.container, '[data-usage-summary="failed"]')).toContain('state.failed')
    h.script('today', { ok: true, value: summary('today') })
    click(view.container, '[data-usage-retry]')
    await settle()
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-usage-summary="failed"]')).toBeNull()
    expect(view.container.querySelector('[data-usage-model="deepseek/deepseek-chat"]')).not.toBeNull()
  })

  it('retries beside a settled summary and hides the failure while reloading', async () => {
    const h = harness({ today: { ok: true, value: summary('today') } })
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    h.instance.actions.failed(DASHBOARD_OVERLAY_ID, { code: 'gateway/internal', message: 'boom', details: {} } as never)
    await settle()
    expect(view.container.querySelector('[data-usage-summary="failed"]')).not.toBeNull()
    click(view.container, '[data-usage-retry]')
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-usage-summary="failed"]')).toBeNull()
    await settle()
    expect(view.container.querySelector('[data-usage-summary="failed"]')).toBeNull()
    expect(view.container.querySelector('[data-usage-model="deepseek/deepseek-chat"]')).not.toBeNull()
  })

  it('closes through the close button, the mask, and Escape but not other keys', async () => {
    const h = harness({ today: { ok: true, value: summary('today') } })
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(view.container.querySelector('[data-dashboard-action="overlay"]')).not.toBeNull()
    click(view.container, '[data-dashboard-action="close"]')
    expect(view.container.querySelector('[data-dashboard-action="overlay"]')).toBeNull()
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    click(view.container, '[data-dashboard-action="mask"]')
    expect(view.container.querySelector('[data-dashboard-action="overlay"]')).toBeNull()
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.container.querySelector('[data-dashboard-action="overlay"]')).toBeNull()
  })

  it('reads its settled summary without refetching on reopen', async () => {
    const h = harness({ today: { ok: true, value: summary('today') } })
    const view = render(<DashboardAction {...h.overlayProps()} />)
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    click(view.container, '[data-dashboard-action="close"]')
    click(view.container, '[data-dashboard-action="trigger"]')
    await settle()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-usage-model="deepseek/deepseek-chat"]')).not.toBeNull()
  })
})

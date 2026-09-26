// @vitest-environment jsdom
/**
 * The review panel in a real DOM: one settled independent review shown as its
 * kind, target, verdict, and every finding grouped in the order a reader
 * should act on them — including the clean review and the localized copy.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ReviewPanel } from '../src/client/ReviewPanel.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { ReviewPanelData } from '../src/client/review-definition.ts'

afterEach(cleanup)

/** Both of these are the panel's own keyed payload; the slot locale supplies `t`. */
type PanelProps = Parameters<typeof ReviewPanel>[0]

/** The English copy this suite renders, spread so it carries string-valued keys. */
const ENGLISH = { ...en }

/** Render one settled review and return the container to query. */
function renderPanel(data: ReviewPanelData, dictionary: Record<string, string> = ENGLISH): HTMLElement {
  const props = { node: { data }, t: makeTranslate(dictionary) } as unknown as PanelProps
  return render(<ReviewPanel {...props} />).container
}

/** One review report with the findings a case needs. */
function review(overrides: Partial<ReviewPanelData> = {}): ReviewPanelData {
  return {
    kind: 'code',
    target: '',
    summary: 'Two issues found.',
    findings: [
      { file: 'a.ts', line: '10', severity: 'low', message: 'minor nit' },
      { file: 'b.ts', line: '20-25', severity: 'high', message: 'SQL injection risk' },
      { file: 'c.ts', severity: 'medium', message: 'missing boundary check' },
    ],
    ...overrides,
  }
}

/** Every rendered finding, in DOM order, as its severity and text. */
function foundRows(container: HTMLElement): { severity: string | null; text: string }[] {
  return [...container.querySelectorAll('[data-review-severity]')]
    .map(row => ({ severity: row.getAttribute('data-review-severity'), text: row.textContent ?? '' }))
}

describe('ReviewPanel', () => {
  it('shows the review kind, target, verdict, and count', () => {
    const container = renderPanel(review())
    expect(container.querySelector('[data-review-panel]')?.getAttribute('data-review-panel')).toBe('code')
    expect(container.textContent).toContain('Code review')
    expect(container.textContent).toContain('Uncommitted changes')
    expect(container.textContent).toContain('Two issues found.')
    expect(container.querySelector('[data-review-count]')?.getAttribute('data-review-count')).toBe('3')
    expect(container.textContent).toContain('3 findings')
  })

  it('orders findings high, then medium, then low, with file and line', () => {
    const rows = foundRows(renderPanel(review()))
    expect(rows.map(row => row.severity)).toEqual(['high', 'medium', 'low'])
    expect(rows[0]?.text).toContain('b.ts:20-25')
    expect(rows[0]?.text).toContain('SQL injection risk')
    expect(rows[1]?.text).toContain('c.ts')
    expect(rows[2]?.text).toContain('a.ts:10')
  })

  it('shows a security review against a named reference', () => {
    const container = renderPanel(review({ kind: 'security', target: 'main' }))
    expect(container.textContent).toContain('Security review')
    expect(container.textContent).toContain('Against main')
    expect(container.querySelector('[data-review-panel]')?.getAttribute('data-review-panel')).toBe('security')
  })

  it('shows a clean review without any finding row', () => {
    const container = renderPanel(review({ summary: 'Nothing to fix.', findings: [] }))
    expect(container.textContent).toContain('Nothing to fix.')
    expect(container.textContent).toContain('No findings')
    expect(container.textContent).toContain('0 findings')
    expect(foundRows(container)).toEqual([])
  })

  it('uses the singular count for one finding', () => {
    const container = renderPanel(review({ findings: [{ file: 'a.ts', severity: 'low', message: 'nit' }] }))
    expect(container.textContent).toContain('1 finding')
  })

  it('renders the copy of the dictionary it is given', () => {
    const container = renderPanel(review({
      kind: 'security',
      target: 'release/2.0',
      findings: [{ file: 'a.ts', line: '7', severity: 'high', message: 'command injection' }],
    }), zh)
    expect(container.textContent).toContain('安全审查')
    expect(container.textContent).toContain('与 release/2.0 比较')
    expect(container.textContent).toContain('高')
    expect(container.textContent).toContain('1 个问题')
    // Reviewer-authored words stay verbatim in every locale.
    expect(container.textContent).toContain('command injection')
    expect(container.textContent).toContain('a.ts:7')
  })
})

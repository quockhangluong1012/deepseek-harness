// @vitest-environment jsdom
/**
 * The kernel-task panel in a real DOM: the row carries the facts a reader
 * checks first, and the expanded body carries the plan, budget, verification,
 * checkpoint, and research record the log folded into one task.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { KernelTaskData } from '../src/client/task-definition.ts'
import { KernelTaskPanel } from '../src/client/KernelTaskPanel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** Both panels below are the panel's own keyed payload; the slot locale supplies `t`. */
type PanelProps = Parameters<typeof KernelTaskPanel>[0]

/** Translate one key with its parameters substituted, as the slot locale does. */
function translate(key: string, params: Record<string, string | number> = {}): string {
  return (en[key as keyof typeof en] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

/** Render one folded task and return the container to query. */
function renderPanel(data: KernelTaskData): HTMLElement {
  const props = { node: { data }, t: translate } as unknown as PanelProps
  return render(<KernelTaskPanel {...props} />).container
}

/** The text of the one node carrying `attribute`, or `undefined` when absent. */
function line(container: HTMLElement, attribute: string): string | undefined {
  return container.querySelector(`[${attribute}]`)?.textContent ?? undefined
}

/** One task whose log recorded every fact the panel renders. */
const FULL: KernelTaskData = {
  objective: 'repair the reader',
  status: 'executing',
  interrupted: false,
  revision: 3,
  agentProfile: 'worker',
  policyProfile: 'default',
  budget: { maxSteps: 8, maxToolCalls: 4 },
  planRevision: 2,
  planSteps: ['reproduce', 'repair'],
  openActions: 1,
  unresolvedFailures: ['tool-transient'],
  verification: {
    status: 'fail',
    criteria: [{ criterionId: 'crit-1', status: 'fail', evidence: [] }],
    verifierVersion: 'kernel-1',
  },
  checkpoint: { checkpointId: 'checkpoint-1', reason: 'turn-boundary', revision: 2, sessionSeq: 9 },
  evidence: 2,
  claims: 1,
  hypotheses: 3,
}

describe('KernelTaskPanel', () => {
  it('shows the objective, status, and open counts in the row', () => {
    const container = renderPanel(FULL)

    expect(container.textContent).toContain('repair the reader')
    expect(line(container, 'data-task-status-text')).toBe('Executing')
    expect(line(container, 'data-task-summary')).toBe(
      'Revision 3 · Open actions 1 · Unresolved failures 1',
    )
    expect(container.querySelector('[data-task-status]')?.getAttribute('data-task-status')).toBe('executing')
  })

  it('shows the plan, budget, verification, checkpoint, and research record when open', () => {
    const container = renderPanel(FULL)

    expect(line(container, 'data-task-plan')).toBe('Plan revision 2: reproduce → repair')
    expect(line(container, 'data-task-budget')).toBe('Budget: maxSteps=8, maxToolCalls=4')
    expect(line(container, 'data-task-verification')).toBe('Verification: fail · Verifier kernel-1 · Criterion crit-1: fail')
    expect(line(container, 'data-task-checkpoint')).toBe('Checkpoint checkpoint-1 · Reason: turn-boundary · Covers session seq 9')
    expect(line(container, 'data-task-research')).toBe('Research record: Evidence 2, claims 1, hypotheses 3')
    expect(line(container, 'data-task-profile')).toBe('Agent profile: worker')
    expect(line(container, 'data-task-policy')).toBe('Policy profile: default')
    expect(container.querySelector('[data-task-failures]')?.getAttribute('data-task-failure-kinds'))
      .toBe('tool-transient')
  })

  it('states the absent records of a task that recorded no plan, verification, checkpoint, or ceiling', () => {
    // The absent records are deleted rather than set to `undefined`, because an
    // optional payload field is either present with a value or absent.
    const bare: Record<string, unknown> = { ...FULL }
    delete bare.planRevision
    delete bare.verification
    delete bare.checkpoint
    Object.assign(bare, {
      budget: {}, planSteps: [], openActions: 0, unresolvedFailures: [], evidence: 0, claims: 0, hypotheses: 0,
    })

    const container = renderPanel(bare as unknown as KernelTaskData)

    expect(line(container, 'data-task-plan')).toBe('No recorded plan')
    expect(line(container, 'data-task-budget')).toBe('Budget: Unbounded')
    expect(line(container, 'data-task-verification')).toBe('Verification never ran')
    expect(line(container, 'data-task-checkpoint')).toBeUndefined()
    expect(line(container, 'data-task-summary')).toBe('Revision 3')
  })

  it('renders a task the log stopped mid-flight as interrupted and collapsed', () => {
    const container = renderPanel({ ...FULL, interrupted: true })

    expect(line(container, 'data-task-status-text')).toBe('Interrupted')
    expect(line(container, 'data-task-summary')).toContain('Interrupted')
    expect(container.querySelector('[data-task-status]')?.getAttribute('data-task-interrupted')).toBe('true')
    expect(line(container, 'data-task-plan')).toBeUndefined()
  })
})

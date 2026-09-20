import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { sourcesFromAssembly, sourcesFromView } from '../src/sources.ts'
import { actionId, failureId, viewOf } from './rig.ts'

/** One assembly with the given sections and runtime contexts. */
function assembly(sections: [string, string][], contexts: [string, string][] = []): PromptAssembly {
  return {
    sections: sections.map(([name, text]) => ({ name, text })),
    contexts: contexts.map(([name, text]) => ({ name, text })),
    tools: [],
    variables: {},
  }
}

describe('assembly facade', () => {
  it('wraps every non-empty contribution with its family classification', () => {
    const sources = sourcesFromAssembly(assembly(
      [['tool:read', 'Read files.'], ['deployment:persona-prefix', 'Be precise.']],
      [['sandbox:policy', 'Read-only workspace.']],
    ))

    expect(sources.map(source => source.id)).toEqual(['tool:read', 'deployment:persona-prefix', 'sandbox:policy'])
    expect(sources[0]).toEqual({
      id: 'tool:read',
      kind: 'tool',
      content: 'Read files.',
      trust: 'trusted',
      provenance: { source: 'tool', locator: 'tool:read' },
      retention: 'compressible',
    })
    expect(sources[1]).toMatchObject({ kind: 'policy', trust: 'trusted', retention: 'required' })
    expect(sources[2]).toMatchObject({ kind: 'policy', provenance: { source: 'policy', locator: 'sandbox:policy' } })
  })

  it('treats an unlisted contribution family as droppable data', () => {
    const sources = sourcesFromAssembly(assembly([['mystery:thing', 'content']]))
    expect(sources[0]).toMatchObject({ kind: 'artifact', trust: 'untrusted', retention: 'compressible' })
  })

  it('omits a contribution that resolved to no text', () => {
    expect(sourcesFromAssembly(assembly([['tool:read', '']], [['sandbox:policy', '']]))).toEqual([])
  })
})

describe('kernel view facade', () => {
  it('projects nothing without a view', () => {
    expect(sourcesFromView(undefined)).toEqual([])
  })

  it('makes the objective, criteria, constraints, plan, and open work required', () => {
    const view = viewOf({
      task: {
        ...viewOf().task,
        objective: 'ship the parser',
        constraints: [{ kind: 'style', statement: 'no new dependencies' }, { kind: 'scope', statement: 'runtime only' }],
        acceptance: [
          { id: 'build', description: 'the package builds', verifier: 'build', required: true },
          { id: 'review', description: 'a human read the diff', verifier: 'human', required: false },
        ],
      },
      plan: { revision: 2, steps: ['read the spec', 'write the parser'], createdAt: 1 },
      openActionIds: [actionId('call-1')],
      unresolvedFailures: [{ failureId: failureId('failure-1'), kind: 'verification-failed' }],
    })

    const sources = sourcesFromView(view)
    expect(sources.map(source => source.id)).toEqual([
      'task:objective',
      'task:acceptance:build',
      'task:acceptance:review',
      'task:constraint:0',
      'task:constraint:1',
      'plan:2',
      'action:call-1',
      'failure:failure-1',
    ])
    expect(sources[0]).toMatchObject({ kind: 'task', content: 'ship the parser', retention: 'required', subject: 'objective' })
    expect(sources[1]?.content).toBe('the package builds (verifier: build, required)')
    expect(sources[2]?.content).toBe('a human read the diff (verifier: human)')
    expect(sources[3]?.content).toBe('style: no new dependencies')
    expect(sources[5]).toMatchObject({ kind: 'plan', content: 'read the spec\nwrite the parser', subject: 'plan' })
    expect(sources[6]).toMatchObject({ kind: 'tool', content: 'unsettled action: call-1', retention: 'required' })
    expect(sources[7]).toMatchObject({ content: 'unresolved failure: verification-failed' })
    expect(sources.every(source => source.provenance.source === 'kernel')).toBe(true)
  })

  it('omits the objective when the contract states none and the plan when there is none', () => {
    const view = viewOf({ task: { ...viewOf().task, objective: '' } })
    expect(sourcesFromView(view).map(source => source.id)).toEqual([])
  })
})

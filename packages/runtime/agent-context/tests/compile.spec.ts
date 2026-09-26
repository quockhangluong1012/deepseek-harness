import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { CONTEXT_COMPILER_VERSION, DefaultContextCompiler, recordOf } from '../src/compile.ts'
import type { ContextSource, ContextSourceKind, RetentionClass } from '../src/types.ts'

/** One envelope fixture. */
function source(
  id: string,
  content: string,
  options: { kind?: ContextSourceKind; retention?: RetentionClass; subject?: string; trust?: ContextSource['trust'] } = {},
): ContextSource {
  return {
    id,
    kind: options.kind ?? 'task',
    content,
    trust: options.trust ?? 'trusted',
    sourceRef: { source: 'kernel', locator: id },
    retention: options.retention ?? 'required',
    ...options.subject === undefined ? {} : { subject: options.subject },
  }
}

/** An assembly with one section per given name and text. */
function assembly(sections: [string, string][]): PromptAssembly {
  return { sections: sections.map(([name, text]) => ({ name, text })), contexts: [], tools: [], variables: {} }
}

/** A compiler with no configuration. */
const compiler = new DefaultContextCompiler()

describe('compile', () => {
  it('places the assembled contributions and the durable facts together', async () => {
    const compiled = await compiler.compile({
      assembly: assembly([['tool:read', 'read a file'], ['sandbox:policy', 'read only']]),
      sources: [source('task:acceptance:build', 'the package builds')],
      objective: 'read the build',
    })

    expect(compiled.compilerVersion).toBe(CONTEXT_COMPILER_VERSION)
    expect(compiled.included.map(entry => entry.source.id)).toEqual(['sandbox:policy', 'task:acceptance:build', 'tool:read'])
    expect(compiled.omitted).toEqual([])
    expect(compiled.conflicts).toEqual([])
    expect(compiled.tokenEstimate).toBe(compiled.included.reduce((total, entry) => total + entry.tokens, 0))
    expect(compiled.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a source that carries no content', async () => {
    await expect(compiler.compile({ assembly: assembly([]), sources: [source('task:x', '')] }))
      .rejects.toThrow('agent-context: context source "task:x" carries no content')
  })

  it('rejects two sources that share an id', async () => {
    await expect(compiler.compile({
      assembly: assembly([['tool:read', 'read a file']]),
      sources: [source('tool:read', 'read it')],
    })).rejects.toThrow('agent-context: duplicate context source id "tool:read"')
  })

  it('drops a droppable source whose content an earlier source already carries', async () => {
    const compiled = await compiler.compile({
      assembly: assembly([]),
      sources: [
        source('policy:a', 'same text', { kind: 'policy' }),
        source('tool:b', 'same text', { kind: 'tool', retention: 'compressible' }),
      ],
    })
    expect(compiled.included.map(entry => entry.source.id)).toEqual(['policy:a'])
    expect(compiled.omitted).toEqual([{ id: 'tool:b', reason: 'duplicate' }])
  })

  it('keeps the required source and drops the untrusted duplicate of it', async () => {
    const compiled = await compiler.compile({
      assembly: assembly([]),
      sources: [
        source('tool:a', 'same text', { kind: 'tool', retention: 'compressible', trust: 'untrusted' }),
        source('task:b', 'same text'),
      ],
    })
    expect(compiled.included.map(entry => entry.source.id)).toEqual(['task:b'])
    expect(compiled.omitted).toEqual([{ id: 'tool:a', reason: 'duplicate' }])
  })

  it('reports required sources that disagree about one subject', async () => {
    const compiled = await compiler.compile({
      assembly: assembly([]),
      sources: [
        source('plan:2', 'write the parser', { kind: 'plan', subject: 'plan' }),
        source('plan:1', 'write the lexer', { kind: 'plan', subject: 'plan' }),
        source('note:a', 'nothing', { kind: 'plan', subject: 'aaa' }),
        source('note:b', 'different', { kind: 'plan', subject: 'aaa' }),
      ],
    })
    expect(compiled.conflicts).toEqual([
      { subject: 'aaa', sources: ['note:a', 'note:b'] },
      { subject: 'plan', sources: ['plan:1', 'plan:2'] },
    ])
  })

  it('reports no conflict when a subject agrees, is claimed once, or is claimed only by droppable sources', async () => {
    const compiled = await compiler.compile({
      assembly: assembly([]),
      sources: [
        source('plan:1', 'write the parser', { kind: 'plan', subject: 'plan' }),
        source('plan:2', 'write the parser', { kind: 'plan', subject: 'plan' }),
        source('solo:a', 'alone', { kind: 'plan', subject: 'solo' }),
        source('free:a', 'one', { kind: 'plan', subject: 'free', retention: 'compressible' }),
        source('free:b', 'two', { kind: 'plan', subject: 'free', retention: 'compressible' }),
      ],
    })
    expect(compiled.conflicts).toEqual([])
  })

  it('places the same sources identically whatever order they arrive in', async () => {
    const sources = [
      source('task:objective', 'fix the failing build', { subject: 'objective' }),
      source('tool:b', 'unrelated', { kind: 'tool', retention: 'compressible' }),
      source('tool:a', 'fix the build', { kind: 'tool', retention: 'compressible' }),
    ]
    const first = await compiler.compile({ assembly: assembly([]), sources, objective: 'fix the failing build' })
    const second = await compiler.compile({ assembly: assembly([]), sources: [...sources].reverse(), objective: 'fix the failing build' })
    expect(second.included.map(entry => entry.source.id)).toEqual(first.included.map(entry => entry.source.id))
    expect(second.digest).toBe(first.digest)
  })

  it('places the source that matches the objective ahead of an unrelated one', async () => {
    const compiled = await compiler.compile({
      assembly: assembly([['tool:a', 'totally unrelated prose'], ['tool:b', 'fix the failing build']]),
      objective: 'fix the failing build',
    })
    expect(compiled.included.map(entry => entry.source.id)).toEqual(['tool:b', 'tool:a'])
    expect(compiled.included[0]?.relevance).toBe(1)
    expect(compiled.included[1]?.relevance).toBe(0)
  })

  it('projects a placement into its durable record', async () => {
    const compiled = await compiler.compile({
      assembly: assembly([['tool:read', 'read a file']]),
      objective: 'read file',
      maxTokens: 500,
    })
    const record = recordOf(compiled, 500)
    expect(record).toEqual({
      digest: compiled.digest,
      compilerVersion: CONTEXT_COMPILER_VERSION,
      maxTokens: 500,
      tokenEstimate: compiled.tokenEstimate,
      included: [{
        id: 'tool:read',
        kind: 'tool',
        trust: 'trusted',
        retention: 'compressible',
        tokens: compiled.included[0]?.tokens,
        relevance: 1,
      }],
      omitted: [],
      conflicts: [],
    })
    expect(JSON.stringify(record)).not.toContain('read a file')
  })

  it('records an unbounded placement when no ceiling applies', async () => {
    const compiled = await compiler.compile({ assembly: assembly([['tool:read', 'read a file']]) })
    expect(recordOf(compiled, null).maxTokens).toBeNull()
    expect(compiled.included[0]?.relevance).toBe(0)
  })
})

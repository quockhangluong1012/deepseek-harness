/**
 * Mutation framing, parsing, and the single streamed call: a fenced answer
 * parses, prose does not, and nothing usable means no mutation.
 */
import { describe, expect, it } from 'vitest'
import {
  distributeCandidates,
  frameMutationInput,
  MUTATION_OPERATORS,
  mutateOnce,
  mutationInstructions,
  parseMutationResponse,
  resolveOperators,
} from '../src/mutate.ts'
import type { MutationFork } from '../src/mutate.ts'

describe('frameMutationInput', () => {
  it('frames the skill body whole and reports no truncation when it fits', () => {
    const framed = frameMutationInput('writer', 'body', 'evidence', 3, 16384, MUTATION_OPERATORS[0]!.instruction)
    expect(framed.text).toContain('Skill: writer')
    expect(framed.text).toContain('Current SKILL.md:\nbody')
    expect(framed.truncated).toBe(false)
  })

  it('halves the evidence, never the body, until the frame fits', () => {
    const full = frameMutationInput('writer', 'body', 'e'.repeat(1000), 3, 16384, MUTATION_OPERATORS[0]!.instruction)
    const framed = frameMutationInput('writer', 'body', 'e'.repeat(1000), 3, full.inputBytes - 500, MUTATION_OPERATORS[0]!.instruction)
    expect(framed.text).toContain('Current SKILL.md:\nbody')
    expect(framed.text.length).toBeLessThan(full.text.length)
    expect(framed.truncated).toBe(true)
    expect(framed.inputBytes).toBeLessThanOrEqual(full.inputBytes - 500)
  })
})

describe('mutation operators', () => {
  it('carries the selected operator instruction into the header', () => {
    const text = mutationInstructions(2, MUTATION_OPERATORS[1]!.instruction)
    expect(text).toContain(MUTATION_OPERATORS[1]!.instruction)
    expect(text).toContain('exactly 2 strings')
  })

  it('resolves configured ids in order and rejects an unknown one', () => {
    expect(resolveOperators(['compress', 'rewrite']).map(operator => operator.id)).toEqual(['compress', 'rewrite'])
    expect(() => resolveOperators(['nope'])).toThrow("unknown mutation operator 'nope'")
  })

  it('resolves every portfolio operator with a distinct instruction', () => {
    const ids = ['rewrite', 'compress', 'guard', 'exemplify', 'generalize', 'decompose', 'compose', 'reorder', 'remove-step', 'change-tool', 'change-retrieval', 'change-evaluator']
    expect(MUTATION_OPERATORS.map(operator => operator.id).sort()).toEqual([...ids].sort())
    expect(new Set(MUTATION_OPERATORS.map(operator => operator.instruction)).size).toBe(ids.length)
    expect(resolveOperators(ids).map(operator => operator.id)).toEqual(ids)
  })

  it('splits the candidate budget across the portfolio, leading operators taking the remainder', () => {
    const three = resolveOperators(['rewrite', 'compress'])
    expect(distributeCandidates(3, three).map(entry => [entry.operator.id, entry.count])).toEqual([['rewrite', 2], ['compress', 1]])
    expect(distributeCandidates(1, three).map(entry => entry.operator.id)).toEqual(['rewrite'])
  })
})

describe('parseMutationResponse', () => {
  it('unfences a json block and drops the baseline body', () => {
    const bodies = parseMutationResponse('```json\n["body", "fresh"]\n```', 'body', 3)
    expect(bodies).toEqual(['fresh'])
  })
  it('stops at the requested count', () => {
    const bodies = parseMutationResponse(JSON.stringify(['a', 'b', 'c', 'd']), 'body', 2)
    expect(bodies).toEqual(['a', 'b'])
  })
  it('absorbs prose, non-arrays, and non-strings as no mutation', () => {
    expect(parseMutationResponse('here are some ideas', 'body', 3)).toEqual([])
    expect(parseMutationResponse('{"one": 1}', 'body', 3)).toEqual([])
    expect(parseMutationResponse(JSON.stringify([7, null]), 'body', 3)).toEqual([])
  })
})

describe('mutateOnce', () => {
  function fork(text: string): MutationFork {
    return {
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }
  }

  const options = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxOutputTokens: 2048,
    input: 'frame',
    signal: new AbortController().signal,
  }

  it('streams one answer and parses its bodies', async () => {
    const bodies = await mutateOnce(fork(JSON.stringify(['fresh'])), options, 'body', 3)
    expect(bodies).toEqual(['fresh'])
  })

  it('throws the model failure instead of parsing it', async () => {
    const failing: MutationFork = {
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'llm/down' } } }
      })(),
    }
    await expect(mutateOnce(failing, options, 'body', 3)).rejects.toThrow('boom')
  })
})

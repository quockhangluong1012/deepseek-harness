/**
 * Mutation framing, parsing, and the single streamed call: a fenced answer
 * parses, prose does not, and nothing usable means no mutation.
 */
import { describe, expect, it } from 'vitest'
import {
  MUTATION_OPERATOR_CATALOG as OPERATOR_CATALOG,
  MUTATION_OPERATORS as STORE_OPERATORS,
} from '@deepseek-ai/dsh-evolution-operators'
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

  it('halves the evidence until the frame fits, keeping the body whole while it can', () => {
    const full = frameMutationInput('writer', 'body', 'e'.repeat(1000), 3, 16384, MUTATION_OPERATORS[0]!.instruction)
    const framed = frameMutationInput('writer', 'body', 'e'.repeat(1000), 3, full.inputBytes - 500, MUTATION_OPERATORS[0]!.instruction)
    expect(framed.text).toContain('Current SKILL.md:\nbody')
    expect(framed.text.length).toBeLessThan(full.text.length)
    expect(framed.truncated).toBe(true)
    expect(framed.inputBytes).toBeLessThanOrEqual(full.inputBytes - 500)
  })

  it('truncates an oversized body to exactly the byte budget', () => {
    const maxBytes = 2000
    const framed = frameMutationInput('writer', 'b'.repeat(5000), 'evidence', 3, maxBytes, MUTATION_OPERATORS[0]!.instruction)
    expect(framed.inputBytes).toBe(maxBytes)
    expect(framed.text.startsWith('You improve one skill package')).toBe(true)
    expect(framed.truncated).toBe(true)
  })

  it('keeps the frame at the budget when a multi-byte character straddles it', () => {
    const maxBytes = 1000
    const framed = frameMutationInput('writer', 'é'.repeat(2000), 'evidence', 3, maxBytes, MUTATION_OPERATORS[0]!.instruction)
    expect(framed.inputBytes).toBeLessThanOrEqual(maxBytes)
    expect(Buffer.from(framed.text, 'utf8').toString('utf8')).toBe(framed.text)
  })
})

describe('mutation operators', () => {
  it('shares one vocabulary with the operator store', () => {
    expect(MUTATION_OPERATORS).toBe(OPERATOR_CATALOG)
    expect(MUTATION_OPERATORS.map(operator => operator.id)).toEqual([...STORE_OPERATORS])
    for (const id of STORE_OPERATORS) expect(resolveOperators([id]).map(operator => operator.id)).toEqual([id])
  })
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
    const ids = [...STORE_OPERATORS]
    expect(resolveOperators(ids).map(operator => operator.id)).toEqual(ids)
    expect(new Set(MUTATION_OPERATORS.map(operator => operator.instruction)).size).toBe(ids.length)
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
    const run = await mutateOnce(fork(JSON.stringify(['fresh'])), options, 'body', 3)
    expect(run.bodies).toEqual(['fresh'])
    // The answer reported no usage, so nothing measured the call's tokens.
    expect(run.tokens).toBe(0)
  })

  it('reports the tokens the answer consumed', async () => {
    const metered: MutationFork = {
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(['fresh']) } }
        yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }
    expect((await mutateOnce(metered, options, 'body', 3)).tokens).toBe(42)

    // A provider that reports the buckets without a total still settles the
    // call: the sum is what it billed.
    const buckets: MutationFork = {
      stream: () => (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(['fresh']) } }
        yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }
    expect((await mutateOnce(buckets, options, 'body', 3)).tokens).toBe(42)
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

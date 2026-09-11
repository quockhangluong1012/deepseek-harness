import { describe, expect, it } from 'vitest'
import { frameExtractionInput, extractionSystemPrompt, truncateUtf8Bytes } from '../src/prompt.ts'
import { resolveConfig } from '../src/index.ts'

describe('workspace-memory-llm config', () => {
  it('rejects a lone provider without a model', () => {
    expect(() => resolveConfig({ provider: 'deepseek' })).toThrow()
    expect(() => resolveConfig({ model: 'chat' })).toThrow()
  })

  it('accepts defaults and a complete pair', () => {
    expect(resolveConfig({}).autoExtract).toBe(true)
    expect(resolveConfig().autoExtract).toBe(true)
    expect(resolveConfig({ provider: 'p', model: 'm' }).provider).toBe('p')
  })

  it('frames transcript rows as JSON', () => {
    const text = frameExtractionInput([{ role: 'user', text: 'hi' }], '')
    expect(text).toContain(JSON.stringify([{ role: 'user', text: 'hi' }]))
    expect(extractionSystemPrompt()).toContain('## Purpose')
  })

  it('truncates at a UTF-8 boundary', () => {
    expect(truncateUtf8Bytes('hello', 10)).toBe('hello')
    expect(truncateUtf8Bytes('hello', 2)).toBe('he')
    // 'a😀b': a takes 1 byte, the emoji takes 4. Cutting at 3 backs up over
    // the emoji's continuation bytes and keeps only 'a'.
    expect(truncateUtf8Bytes('a😀b', 3)).toBe('a')
    expect(truncateUtf8Bytes('a😀b', 0)).toBe('')
  })
})

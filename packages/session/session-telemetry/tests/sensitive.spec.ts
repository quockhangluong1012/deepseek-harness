import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SENSITIVE_PATTERNS,
  SENSITIVE_PLACEHOLDER,
  scrubSensitiveRecord,
  scrubSensitiveValue,
} from '../src/sensitive.ts'

describe('sensitive scrub helpers', () => {
  it('scrubs default secret shapes while preserving structure', () => {
    const body = {
      text: 'key sk-abcdefghij1234567890 and Bearer abcdefghij1234567890 plus AKIAIOSFODNN7EXAMPLE',
      nested: ['plain', 'sk-abcdefghij1234567890'],
      count: 3,
    }
    const scrubbed = scrubSensitiveValue(body) as { text: string; nested: string[]; count: number }
    expect(scrubbed.text).not.toContain('sk-abcdefghij1234567890')
    expect(scrubbed.text).toContain(SENSITIVE_PLACEHOLDER)
    expect(scrubbed.nested[1]).toBe(SENSITIVE_PLACEHOLDER)
    expect(scrubbed.count).toBe(3)
  })

  it('leaves ordinary prose untouched', () => {
    expect(scrubSensitiveValue('hello world')).toBe('hello world')
    expect(scrubSensitiveValue('short sk-abc')).toBe('short sk-abc')
  })

  it('scrubs a record body while keeping its envelope', () => {
    const record = {
      channel: 'ledger' as const,
      time: 1,
      severity: 'info' as const,
      attributes: {},
      body: { text: 'token sk-abcdefghij1234567890' },
    }
    const scrubbed = scrubSensitiveRecord(record)
    expect(scrubbed.channel).toBe('ledger')
    expect(scrubbed.time).toBe(1)
    expect(JSON.stringify(scrubbed.body)).not.toContain('sk-abcdefghij1234567890')
  })

  it('supports custom patterns', () => {
    const custom = [{ name: 'fixture', pattern: /sk-e2efixture[0-9]+/g }]
    expect(scrubSensitiveValue('key sk-e2efixture123', custom)).toBe(`key ${SENSITIVE_PLACEHOLDER}`)
  })

  it('every default pattern is global', () => {
    for (const { name, pattern } of DEFAULT_SENSITIVE_PATTERNS) {
      expect(pattern.global, name).toBe(true)
    }
  })
})

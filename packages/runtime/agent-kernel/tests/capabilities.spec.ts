import { describe, expect, it } from 'vitest'
import { ToolCapabilityRegistry } from '../src/capabilities.ts'
import type { CapabilityDeclaration } from '../src/types.ts'

/**
 * A declaration that resolves one resource per invocation, plus one that throws
 * to prove the registry never swallows a declaring package's defect.
 */
const declaration: CapabilityDeclaration = {
  tool: 'write_file',
  capabilities: ['fs.write', 'fs.edit'],
  resources: () => 'workspace/a.ts',
}

describe('tool capability registry', () => {
  it('resolves every declared capability against the projected resource', () => {
    const registry = new ToolCapabilityRegistry()
    expect(registry.size).toBe(0)
    expect(registry.has('write_file')).toBe(false)
    expect(registry.resolve('write_file', {})).toBeUndefined()

    registry.register(declaration)
    expect(registry.size).toBe(1)
    expect(registry.has('write_file')).toBe(true)
    expect(registry.resolve('write_file', {})).toEqual([
      { capability: 'fs.write', resource: 'workspace/a.ts' },
      { capability: 'fs.edit', resource: 'workspace/a.ts' },
    ])
  })

  it('lets a re-registration replace the earlier declaration, and an earlier disposer then removes nothing', () => {
    const registry = new ToolCapabilityRegistry()
    const disposeFirst = registry.register(declaration)
    const replacement: CapabilityDeclaration = { ...declaration, capabilities: ['fs.read'], resources: () => '**' }
    registry.register(replacement)

    disposeFirst()
    expect(registry.has('write_file')).toBe(true)
    expect(registry.resolve('write_file', {})).toEqual([{ capability: 'fs.read', resource: '**' }])

    const disposeSecond = registry.register(replacement)
    disposeSecond()
    expect(registry.has('write_file')).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('rejects a declaration without required capabilities', () => {
    const registry = new ToolCapabilityRegistry()
    expect(() => registry.register({ ...declaration, capabilities: [] }))
      .toThrow('must declare at least one capability')
  })

  it('propagates a throwing resource projection', () => {
    const registry = new ToolCapabilityRegistry()
    registry.register({
      tool: 'broken',
      capabilities: ['fs.read'],
      resources: () => { throw new Error('bad projection') },
    })
    expect(() => registry.resolve('broken', {})).toThrow('bad projection')
  })
})

/**
 * What the `usage` type claims, and how it is opened: a builtin page with a
 * guide entry, claimed by kind through the real registry.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { USAGE_ID, USAGE_KIND, usageDefinition } from '../src/client/definition.ts'

function t(key: string): string {
  return key
}

describe('usageDefinition', () => {
  it('is a builtin page with a guide entry, titled on demand', () => {
    const definition = usageDefinition(t)
    expect(definition.id).toBe(USAGE_ID)
    expect(definition.kind).toBe(USAGE_KIND)
    expect(definition.priority).toBe('builtin')
    expect(definition.patterns).toBeUndefined()
    expect(definition.title('sidebar://usage')).toBe('type.label')
    expect(definition.guide).toHaveLength(1)
    expect(definition.guide?.[0]?.title()).toBe('guide.title')
    expect(definition.guide?.[0]?.description()).toBe('guide.description')
    expect(definition.guide?.[0]?.order).toBe(20)
  })
})

describe('usage type in the registry', () => {
  function registry() {
    const tabs = new SidebarRightTabRegistry(new Context())
    tabs.register(usageDefinition(t))
    return tabs
  }

  it('opens by kind as a page', () => {
    const tabs = registry()
    expect(tabs.claim('sidebar://usage', USAGE_KIND)).toEqual({
      kind: USAGE_KIND, contentId: 'sidebar://usage', title: 'type.label',
    })
  })

  it('lists its guide box for the guide page', () => {
    const tabs = registry()
    expect(tabs.guide().map(box => box.kind)).toContain(USAGE_KIND)
  })
})

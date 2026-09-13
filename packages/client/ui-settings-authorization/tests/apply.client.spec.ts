// @vitest-environment jsdom
/** Registration of the sign-in companion on the Models provider-card seat. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { SignInCard } from '../src/client/SignInCard.tsx'

describe('the sign-in companion plugin', () => {
  it('declares its Remote dependency and registers the llm-pi-ai seat', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.authorization'])
    const register = vi.fn(() => () => {})
    const seen: Array<{ name: string; factory: () => unknown }> = []
    const locale = { register: vi.fn(), bind: vi.fn(() => (key: string) => key) }
    const ctx = {
      effect: (effect: () => void) => {
        effect()
        return () => {}
      },
      locale,
      remote: {},
      slots: {
        inject: (name: string, factory: () => unknown) => {
          seen.push({ name, factory })
          return () => {}
        },
        register,
      },
    } as unknown as Context
    apply(ctx)
    expect(locale.register).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe('settings.models.provider-card')
    seen[0]?.factory()
    expect(register).toHaveBeenCalledTimes(1)
    const [spec, component] = register.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
    expect(spec).toMatchObject({ name: 'settings.models.provider-card', key: 'llm-pi-ai' })
    expect(component).toBe(SignInCard)
    expect(typeof spec['locale']).toBe('string')
    const face = spec['inject'] as () => Record<string, unknown>
    expect(Object.keys(face()).sort()).toEqual(['operations', 't'])
  })
})

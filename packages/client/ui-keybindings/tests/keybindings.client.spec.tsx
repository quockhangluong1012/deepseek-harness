// @vitest-environment jsdom
/**
 * Browser half on a real cordis Context with a fake session scope: the window
 * keymap resolves the session the interface shows, seeds the command menu, and
 * re-binds when the durable settings change.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { KEYBINDINGS_SETTINGS_NAMESPACE } from '../src/keybindings-settings.ts'
import type { KeybindingsSettings } from '../src/keybindings-settings.ts'

usePinnedBrowserLanguages('en-US')

const SID = 'session-1'

async function bench(draft: string) {
  const runtime = await SlotTestRuntime.create()
  const form = stubConfigForm<KeybindingsSettings>()
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (namespace: string) => (namespace === KEYBINDINGS_SETTINGS_NAMESPACE ? form.scope : stubConfigForm().scope),
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({ 'settings.general.item': { kind: 'list', scope: 'root' } }, () => null)

  const setDraft = vi.fn<(text: string) => void>()
  const focus = vi.fn<() => void>()
  const id = await runtime.sessions.add({ id: SID })
  runtime.sessions.retainFor(runtime.ctx, id, { source: 'mainView' })
  const scope = runtime.sessions.scope(SID)
  if (scope === undefined) throw new Error('the fixture session must have a scope')
  scope.provide('conversation', {
    input: { for: () => ({ state: createSnapshotStore({ draft }), setDraft, focus }) },
  } as never)

  await runtime.mount({ inject: [...inject], apply })
  return { runtime, form, composer: { setDraft, focus } }
}

/** Dispatch one keydown on the jsdom window. */
async function press(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }))
}

describe('keybindings browser half', () => {
  it('opens the command menu in the displayed session and re-binds on a settings change', async () => {
    const test = await bench('')
    try {
      // jsdom reports a non-Mac platform, so `mod` resolves to Control here.
      await press('k', { ctrlKey: true })
      expect(test.composer.setDraft).toHaveBeenCalledWith('/')
      expect(test.composer.focus).toHaveBeenCalledTimes(1)

      // The durable chord replacement takes effect without a remount.
      test.form.publish({ value: { commandPalette: 'mod+shift+p', focusComposer: 'mod+i' } })
      await press('k', { ctrlKey: true })
      expect(test.composer.setDraft).toHaveBeenCalledTimes(1)
      await press('p', { ctrlKey: true, shiftKey: true })
      expect(test.composer.setDraft).toHaveBeenCalledTimes(2)
    } finally {
      await test.runtime.dispose()
    }
  })

  it('focuses an in-progress draft instead of replacing it', async () => {
    const test = await bench('half-written message')
    try {
      await press('k', { ctrlKey: true })
      expect(test.composer.setDraft).not.toHaveBeenCalled()
      expect(test.composer.focus).toHaveBeenCalledTimes(1)

      await press('i', { ctrlKey: true })
      expect(test.composer.focus).toHaveBeenCalledTimes(2)
      expect(test.composer.setDraft).not.toHaveBeenCalled()
    } finally {
      await test.runtime.dispose()
    }
  })
})

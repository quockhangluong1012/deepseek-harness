// @vitest-environment jsdom
/** Rewind dialog: mode choice, optional replacement message, and the stated consequence. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RewindDialog } from '../src/client/chat/RewindDialog.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(zh, commonZh)

/** Render the dialog for one turn and return its recorder callbacks. */
function show(turn = 3) {
  const onRewind = vi.fn()
  const onClose = vi.fn()
  render(<RewindDialog turn={turn} t={t} onRewind={onRewind} onClose={onClose} />)
  return { onRewind, onClose }
}

describe('RewindDialog', () => {
  it('states the combined consequence and rewinds both halves by default', () => {
    const { onRewind, onClose } = show()
    expect(screen.getByRole('dialog', { name: zh['rewind.title'].replace('{turn}', '3') })).toBeTruthy()
    expect(screen.getByText(zh['rewind.effect.both'].replace('{turn}', '3'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: zh['rewind.confirm'] }))
    expect(onRewind).toHaveBeenCalledExactlyOnceWith({ mode: 'both', edit: undefined })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('narrows to code only and states that replaced content is gone', () => {
    const { onRewind } = show()
    fireEvent.click(screen.getByRole('tab', { name: zh['rewind.mode.code'] }))
    expect(screen.getByText(zh['rewind.effect.code'].replace('{turn}', '3'))).toBeTruthy()

    const field = screen.getByLabelText(zh['rewind.edit.label'])
    expect(field).toHaveProperty('disabled', true)
    fireEvent.change(field, { target: { value: 'ignored' } })
    fireEvent.click(screen.getByRole('button', { name: zh['rewind.confirm'] }))
    expect(onRewind).toHaveBeenCalledExactlyOnceWith({ mode: 'code', edit: undefined })
  })

  it('sends the typed replacement for a conversation rewind', () => {
    const { onRewind } = show()
    fireEvent.click(screen.getByRole('tab', { name: zh['rewind.mode.conversation'] }))
    expect(screen.getByText(zh['rewind.effect.conversation'].replace('{turn}', '3'))).toBeTruthy()

    fireEvent.change(screen.getByLabelText(zh['rewind.edit.label']), { target: { value: '  use the loader  ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['rewind.confirm'] }))
    expect(onRewind).toHaveBeenCalledExactlyOnceWith({ mode: 'conversation', edit: 'use the loader' })
  })

  it('cancels without rewinding', () => {
    const { onRewind, onClose } = show()
    fireEvent.click(screen.getByRole('button', { name: zh['rewind.cancel'] }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onRewind).not.toHaveBeenCalled()
  })
})

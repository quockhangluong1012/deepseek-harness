// Turn-tail rewind dialog: one mode choice, an optional replacement message,
// and the consequence of the chosen mode, stated before the command dispatches.

import { useState } from 'react'
import { Button, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatKey } from '../locale.ts'
import css from './RewindDialog.module.css'

/** One rewind mode: the code half, the conversation half, or both. */
type RewindMode = 'code' | 'conversation' | 'both'

export interface RewindDialogProps {
  /** Turn the rewind targets. */
  turn: number
  /** Dismiss without rewinding. */
  onClose: () => void
  /** Dispatch the confirmed rewind: the mode plus an optional replacement message. */
  onRewind: (request: { mode: RewindMode; edit: string | undefined }) => void
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/** Consequence sentence per mode. */
const EFFECT_KEY: Record<RewindMode, ChatKey> = {
  code: 'rewind.effect.code',
  conversation: 'rewind.effect.conversation',
  both: 'rewind.effect.both',
}

const MODE_ORDER: readonly RewindMode[] = ['code', 'conversation', 'both']

/**
 * Render the rewind confirmation for one completed turn. The mode is explicit and
 * starts on the combined one; a replacement message applies to the conversation half
 * only, so the mode choice selects it.
 */
export function RewindDialog({ turn, onClose, onRewind, t }: RewindDialogProps) {
  const [mode, setMode] = useState<RewindMode>('both')
  const [edit, setEdit] = useState('')
  const replacement = edit.trim()
  const options = MODE_ORDER.map(value => ({ value, label: t(`rewind.mode.${value}`) }))
  return (
    <Modal
      open
      onClose={onClose}
      title={t('rewind.title', { turn })}
      closeLabel={t('close')}
      className={css.dialog}
      contentClassName={css.content}
      footer={(
        <>
          <Button variant="outline" className={css.action} onClick={onClose}>{t('rewind.cancel')}</Button>
          <Button
            variant="primary"
            className={css.confirm}
            onClick={() => {
              onRewind({ mode, edit: mode === 'code' || replacement.length === 0 ? undefined : replacement })
              onClose()
            }}
          >
            {t('rewind.confirm')}
          </Button>
        </>
      )}
    >
      <SegmentedControl
        id="rewind-mode"
        label={t('rewind.mode.label')}
        value={mode}
        options={options}
        onChange={setMode}
      />
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('rewind.edit.label')}</span>
        <Input
          value={edit}
          disabled={mode === 'code'}
          placeholder={t('rewind.edit.placeholder')}
          onChange={(event) => { setEdit(event.currentTarget.value) }}
        />
      </label>
      <p className={css.effect}>{t(EFFECT_KEY[mode], { turn })}</p>
    </Modal>
  )
}

/** Bilingual copy for the keybinding Settings row. */

/** Locale namespace owned by this package. */
export const KEYBINDINGS_NS = 'ui-keybindings'

/** Chinese copy. */
export const zh = {
  'settings.keybindings.title': '键盘快捷键',
  'settings.keybindings.description': '点击后按下新的组合键；需包含一个修饰键。',
  'settings.keybindings.commandPalette': '打开命令面板',
  'settings.keybindings.focusComposer': '聚焦输入框',
  'settings.keybindings.capture': '按下组合键…',
  'settings.keybindings.invalid': '不支持该组合键',
}

/** English copy. */
export const en = {
  'settings.keybindings.title': 'Keyboard shortcuts',
  'settings.keybindings.description': 'Click a shortcut, then press the new chord; one modifier is required.',
  'settings.keybindings.commandPalette': 'Open the command palette',
  'settings.keybindings.focusComposer': 'Focus the composer',
  'settings.keybindings.capture': 'Press a chord…',
  'settings.keybindings.invalid': 'Unsupported chord',
}

/** Every key the dictionaries must provide. */
export type KeybindingsKey = keyof typeof zh

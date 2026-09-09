import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en } from '../src/locale.ts'

const script = readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8')
const page = readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../renderer/plugin-manager.css', import.meta.url), 'utf8')

function referencedMessageKeys(): string[] {
  const direct = [...script.matchAll(/messages\.([A-Za-z0-9]+)/gu)].map(match => match[1] as string)
  const dynamic = [...script.matchAll(/(?:[^A-Za-z0-9]message\('([^']+)'|[^A-Za-z0-9]message\("([^"]+)"\))/gu)]
    .map(match => (match[1] ?? match[2]) as string)
  return [...new Set([...direct, ...dynamic])]
}

function referencedElementIds(): string[] {
  return [...new Set(
    [...script.matchAll(/querySelector\('#([A-Za-z-]+)'\)/gu)].map(match => match[1] as string),
  )]
}

describe('desktop plugin-manager renderer contract', () => {
  it('edits versions inline instead of blocking on a native prompt', () => {
    expect(script).not.toMatch(/\.prompt\(/u)
    expect(script).toContain('update-editor')
    expect(styles).toContain('.update-editor')
  })

  it('resolves every referenced copy key from the shell locale dictionary', () => {
    for (const key of referencedMessageKeys()) {
      expect(Object.hasOwn(en, key), `locale key ${key}`).toBe(true)
    }
  })

  it('references only element ids present in the plugin-manager page', () => {
    for (const id of referencedElementIds()) {
      expect(page.includes(`id="${id}"`), `element #${id}`).toBe(true)
    }
  })
})

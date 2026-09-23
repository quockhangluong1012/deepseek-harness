import { readFileSync } from 'node:fs'

function topLevelKeys(source: string, constName: string): string[] {
  const declaration = new RegExp(`^export const ${constName}\\b`, 'm').exec(source)
  if (declaration === null) throw new Error(`missing ${constName}`)
  const body = source.slice(source.indexOf('{', declaration.index) + 1)
  const keys: string[] = []
  let depth = 0
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (c === '{' || c === '[' || c === '(') { depth += 1; continue }
    if (c === '}' || c === ']' || c === ')') { if (depth === 0) break; depth -= 1; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i += 1
      while (i < body.length && body[i] !== q) { if (body[i] === '\\') i += 1; i += 1 }
      continue
    }
    if (depth !== 0) continue
    const m = /^\s*'?([A-Za-z_$][A-Za-z0-9_$./-]*)'?\s*:/.exec(body.slice(i))
    if (m === null) continue
    i += m[0].length - 1
    keys.push(m[1])
  }
  return keys
}

const ours = readFileSync('/tmp/our-gcc.ts', 'utf8')
const theirs = readFileSync('/tmp/up-gcc.ts', 'utf8')
const merged = readFileSync('scripts/gen-cordis-catalog.ts', 'utf8')
for (const name of ['SERVICE_PAGE', 'EVENT_SCOPE_PAGE', 'SERVICE_WALK_EXEMPTIONS', 'EVENT_WALK_EXEMPTIONS', 'LINK_MAP', 'TYPE_LINK_EXEMPTIONS']) {
  try {
    const o = topLevelKeys(ours, name)
    const t = topLevelKeys(theirs, name)
    const m = topLevelKeys(merged, name)
    const union = new Set([...o, ...t])
    const lost = [...union].filter(k => !m.includes(k))
    const extra = m.filter(k => !union.has(k))
    const dupes = m.filter((k, i) => m.indexOf(k) !== i)
    console.log(`${name}: ours=${o.length} theirs=${t.length} merged=${m.length} lostFromUnion=${JSON.stringify(lost.slice(0, 12))}${lost.length > 12 ? ` (+${lost.length - 12})` : ''} extra=${JSON.stringify(extra.slice(0, 6))} dupes=${JSON.stringify(dupes.slice(0, 6))}`)
  } catch (error) {
    console.log(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

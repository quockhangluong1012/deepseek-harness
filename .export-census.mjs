import { readFileSync, globSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

// Which packages export a subpath whose default lands inside lib/types/client?
const emittedClientEntries = []
const nestedDirs = new Set()
for (const f of globSync('packages/*/*/package.json')) {
  const j = JSON.parse(readFileSync(f, 'utf8'))
  for (const [key, value] of Object.entries(j.exports ?? {})) {
    const target = typeof value === 'string' ? value : value?.default
    if (typeof target === 'string' && target.startsWith('./lib/types/')) {
      emittedClientEntries.push([f, key, target])
      if (target.split('/').length > 4) nestedDirs.add(dirname(target))
    }
  }
}
console.log('export defaults into lib/types:', emittedClientEntries.length)
console.log('nested dirs:', [...nestedDirs].join(' '))
console.log('nested (client) entries:')
for (const row of emittedClientEntries.filter(r => r[2].split('/').length > 4)) console.log(' ', row.join(' '))

// Nested directories present in each package's published emitted tree.
const shapes = new Map()
for (const f of globSync('packages/*/*/package.json')) {
  const j = JSON.parse(readFileSync(f, 'utf8'))
  if (!(j.files ?? []).includes('lib/types/**/*.js')) continue
  const dir = dirname(f)
  for (const sub of globSync(`${dir}/lib/types/*/*`)) {
    const name = sub.split(/[\\/]/).slice(-2)[0]
    if (existsSync(sub)) shapes.set(name, (shapes.get(name) ?? 0) + 1)
  }
}
console.log('nested dir names under lib/types:', JSON.stringify([...shapes]))

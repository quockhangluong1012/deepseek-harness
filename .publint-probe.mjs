import { publint } from 'publint'
import { readFileSync, globSync, statSync, readdirSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
const dir = resolve(process.argv[2])
const paths = new Set()
const add = (x) => { const s = statSync(x); if (s.isDirectory()) { for (const e of readdirSync(x, { recursive: true, withFileTypes: true })) if (e.isFile()) paths.add(resolve(e.parentPath, e.name)) } else if (s.isFile()) paths.add(x) }
add(resolve(dir, 'package.json'))
const m = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
for (const pat of [...(m.files ?? []), 'README*', 'LICENSE*']) for (const g of globSync(pat, { cwd: dir })) add(resolve(dir, g))
const files = [...paths].sort().map(f => ({ name: `package/${relative(dir, f).split(sep).join('/')}`, data: readFileSync(f) }))
const r = await publint({ pkgDir: 'package', pack: { files } })
console.log(JSON.stringify(r.messages, null, 1))
console.log('publint version:', JSON.parse(readFileSync('node_modules/publint/package.json', 'utf8')).version)

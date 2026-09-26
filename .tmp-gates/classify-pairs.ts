/**
 * Throwaway: classify bilingual pairs by which side deviates from its recorded
 * consistency record, so the pairing gate can be re-recorded surgically
 * (only pairs whose two sides are both current) instead of with a blanket
 * --write over pairs whose translation genuinely lags.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const SKIP = new Set(['node_modules', '.git', 'lib', '.claude', '.generated', 'dist'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.i18n.yaml')) out.push(path.replaceAll('\\', '/'))
  }
  return out
}

function blobHash(file: string): string {
  const content = readFileSync(file)
  const hash = createHash('sha1')
  hash.update(`blob ${String(content.length)}\0`)
  hash.update(content)
  return hash.digest('hex')
}

const buckets: Record<string, string[]> = { enOnly: [], zhOnly: [], both: [], malformed: [], missingSide: [] }

for (const meta of walk('.')) {
  const source = meta.replace(/\.i18n\.yaml$/, '.md')
  const zh = source.replace(/\.md$/, '.zh.md')
  const pairs = [...readFileSync(meta, 'utf8').matchAll(/^(\S+\.md): ([0-9a-f]{40})$/gmu)].map(m => [m[1]!, m[2]!] as const)
  if (pairs.length !== 2) { buckets.malformed!.push(meta); continue }
  if (!existsSync(source) || !existsSync(zh)) { buckets.missingSide!.push(source); continue }
  const recorded = new Map(pairs)
  const enOk = recorded.get(basename(source)) === blobHash(source)
  const zhOk = recorded.get(basename(zh)) === blobHash(zh)
  if (enOk && zhOk) continue
  ;(enOk ? buckets.zhOnly! : zhOk ? buckets.enOnly! : buckets.both!).push(source)
}

for (const [name, files] of Object.entries(buckets)) {
  console.log(`${name}: ${String(files.length)}`)
  for (const file of files) console.log(`   ${file}`)
}
console.log(`\nRECORDABLE (both/zhOnly):\n${[...buckets.both!, ...buckets.zhOnly!].join('\n')}`)

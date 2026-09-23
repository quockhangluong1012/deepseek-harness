import { readFileSync } from 'node:fs'
const files = [
  'packages/client/ui-evolution/package.json',
  'packages/client/ui-progress/package.json',
  'packages/client/ui-usage-dashboard/package.json',
  'packages/client/ui-workspace-memory/package.json',
]
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const round = JSON.stringify(JSON.parse(text), null, 2) + '\n'
  console.log(f, text === round ? 'LOSSLESS' : 'DIFFERS')
  if (text !== round) {
    const a = text.split('\n')
    const b = round.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.log('  first diff line', i + 1, JSON.stringify(a[i]), '!=', JSON.stringify(b[i]))
        break
      }
    }
  }
}

import { readFileSync, globSync } from 'node:fs'
const interesting = ['react', 'react-dom', 'clsx']
const counts = {}
for (const f of globSync('packages/*/*/package.json')) {
  const j = JSON.parse(readFileSync(f, 'utf8'))
  for (const name of interesting) {
    for (const sec of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (j[sec]?.[name]) {
        counts[`${sec} ${name}`] = (counts[`${sec} ${name}`] ?? 0) + 1
        if (sec === 'dependencies') console.log('DEP:', f)
      }
    }
  }
}
console.log(JSON.stringify(counts, null, 1))

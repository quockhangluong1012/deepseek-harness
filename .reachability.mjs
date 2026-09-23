import { readFileSync, globSync } from 'node:fs'

const intoClient = []
const intoOtherSrcPlane = []
let scanned = 0
for (const f of globSync('packages/*/*/lib/**/*.js')) {
  if (f.endsWith('.map')) continue
  scanned += 1
  const source = readFileSync(f, 'utf8')
  for (const m of source.matchAll(/from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]/g)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec) continue
    // Reach from a published entry (lib root or lib/types/*.js) into lib/types/client/.
    if (/(?:^|\/)(?:lib\/types\/[^/]+|lib\/[^/]+)\.js$/.test(f) && /\/client\//.test(spec)) {
      intoClient.push(`${f} -> ${spec}`)
    }
    if (/^\.\.\/\.\.\/src\//.test(spec) || /(?:^|\/)src\//.test(spec)) intoOtherSrcPlane.push(`${f} -> ${spec}`)
  }
}
console.log('scanned published js:', scanned)
console.log('published entry -> lib/types/client:', intoClient.length)
console.log(intoClient.slice(0, 10).join('\n'))
console.log('published js -> src plane:', intoOtherSrcPlane.length)
console.log(intoOtherSrcPlane.slice(0, 10).join('\n'))

// Does any published bundle (lib/client.js) or lib/index.js reference the emitted client subtree?
const bundleRefs = []
for (const f of globSync('packages/*/*/lib/client.js')) {
  const source = readFileSync(f, 'utf8')
  if (/types\/client\//.test(source)) bundleRefs.push(f)
}
console.log('bundles referencing types/client:', bundleRefs.length, bundleRefs.slice(0, 5).join(' '))

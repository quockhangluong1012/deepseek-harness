/**
 * Throwaway: emit the typert faces of named packages without a repo-wide build.
 * Mirrors the tsdown plugin's emitArtifacts (packages/typert/generator/src/tsdown-plugin.ts).
 * Usage: npx tsx .tmp/gen-typert-scoped.mts <package-name> [...]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceTypertGenerator } from '../packages/typert/generator/lib/types/index.js'

const packages = process.argv.slice(2)
if (packages.length === 0) throw new Error('name at least one package')
const generator = new WorkspaceTypertGenerator(process.cwd(), { checkDiagnostics: false })
for (const artifact of generator.generate(packages, ['host'])) {
  const output = join(process.cwd(), artifact.packageRoot, 'lib')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
  writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
  if (artifact.remote !== undefined) {
    writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  } else if (artifact.face === 'host') {
    for (const file of ['typert.remote-client.js', 'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map']) {
      rmSync(join(output, file), { force: true })
    }
  }
  console.log(`${artifact.package} ${artifact.face}: ${artifact.exports.length} exports, remote=${artifact.remote === undefined ? 'none' : 'yes'}`)
}

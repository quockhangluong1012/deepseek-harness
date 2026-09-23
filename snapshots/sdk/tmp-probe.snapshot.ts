/** TEMPORARY probe: replicate the SDK snapshot spawn and capture child stderr. */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { materializeProfilePatch, parseSnapshotManifest, sessionFixtureNames } from '@deepseek-ai/dsh-session-snapshot'

const scenarioDir = fileURLToPath(new URL('./text-turn', import.meta.url))
const builtBin = fileURLToPath(new URL('../../apps/cli/lib/bin.js', import.meta.url))
const sourceBin = fileURLToPath(new URL('../../apps/cli/src/bin.ts', import.meta.url))
const tsxLoader = fileURLToPath(new URL('../../node_modules/tsx/dist/esm/index.mjs', import.meta.url))

interface Prepared { cwd: string; dshHome: string; patches: string[]; env: Record<string, string> }

async function prepare(): Promise<Prepared> {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-probe-'))
  const dshHome = join(cwd, '.dsh')
  const patchRoot = join(cwd, '.snapshot-patches')
  await mkdir(patchRoot, { recursive: true })
  const patches = [join(scenarioDir, 'cordis.yml'), join(scenarioDir, 'cordis.snapshot.yml')]
    .map((patch, index) => materializeProfilePatch(patch, cwd, patchRoot, index))
  const fixture = await readFile(join(scenarioDir, 'session.v3.jsonl'), 'utf8')
  const route = fixture.split('\n').flatMap((line) => {
    if (line.trim() === '') return []
    const record = JSON.parse(line) as { data?: { header?: { config?: { provider?: string; model?: string } } } }
    const config = record.data?.header?.config
    return typeof config?.provider === 'string' && typeof config.model === 'string' ? [config] : []
  })[0]
  expect(typeof route?.provider).toBe('string')
  const replayRoot = join(cwd, '.replay-fixtures')
  await mkdir(replayRoot, { recursive: true })
  const fixtures = await Promise.all(sessionFixtureNames(await readdir(scenarioDir)).map(async (name) => {
    const destination = join(replayRoot, basename(name))
    await writeFile(destination, (await readFile(join(scenarioDir, name), 'utf8')).replaceAll('{{cwd}}', cwd))
    return destination
  }))
  const manifest = parseSnapshotManifest(await readFile(join(scenarioDir, 'snapshot.yml'), 'utf8'), 'snapshot.yml')
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    DSH_SNAPSHOT: 'replay',
    DSH_SNAPSHOT_PROVIDER: route.provider as string,
    DSH_SNAPSHOT_MODEL: route.model as string,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_AGENTS_HOME: join(cwd, '.agents'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    DSH_HOME: dshHome,
    DSH_SNAPSHOT_FILE: fixtures[0] as string,
    ...manifest.environment,
  }
  return { cwd, dshHome, patches, env }
}

async function probe(label: string, nodeArgs: string[]): Promise<string> {
  const { cwd, patches, env } = await prepare()
  const args = [...nodeArgs, '--profile', 'sdk', ...patches.flatMap(path => ['--patch', path])]
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { cwd, provider: env.DSH_SNAPSHOT_PROVIDER, model: env.DSH_SNAPSHOT_MODEL },
  })}\n`)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve() }, 30_000)
    const check = (): void => {
      if (!stdout.includes('\n')) return
      clearTimeout(timer)
      child.kill()
      setTimeout(resolve, 200)
    }
    child.stdout.on('data', check)
    child.once('exit', () => { clearTimeout(timer); setTimeout(resolve, 200) })
  })
  const report = `===== ${label} =====\nargs: ${args.join(' ')}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n`
  console.log(report)
  await writeFile(join(tmpdir(), `sdk-probe-${label}.log`), report)
  return report
}

it('probe', async () => {
  await probe('built', [builtBin])
  await probe('source', ['--import', tsxLoader, sourceBin])
}, 180_000)

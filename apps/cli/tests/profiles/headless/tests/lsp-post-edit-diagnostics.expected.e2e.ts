import { readFile, readdir } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.js'
import { fixtureContext, normalizeSessionSnapshot } from '@deepseek-ai/dsh-session-snapshot'

const patchPath = fileURLToPath(new URL('./fixtures/lsp-post-edit-diagnostics.patch.yml', import.meta.url))
const adapterPath = fileURLToPath(new URL('./fixtures/lsp-post-edit-diagnostics-llm.ts', import.meta.url))
const serverPath = fileURLToPath(new URL('../../../../../../packages/lsp/lsp-stdio/tests/fixture-server.ts', import.meta.url))
const binScript = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const libBinScript = fileURLToPath(new URL('../../../../lib/bin.js', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))

it('shows and persists LSP diagnostics after a headless write', async () => {
  const content = "const invalid: number = 'bad'\n"
  let sessionLog = ''
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'headless post-edit LSP diagnostics',
    tempDirPrefix: 'dsh-lsp-post-edit-diagnostics-',
    binScript,
    libBinScript,
    configPath: patchPath,
    binArgs: [
      '--profile', 'headless',
      '--patch', patchPath,
      'Write diagnostics.ts with the requested type error.',
    ],
    tsconfigPath,
    env: {
      DSH_LSP_DIAGNOSTICS_ADAPTER: adapterPath,
      DSH_LSP_DIAGNOSTICS_SERVER: serverPath,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    },
    inspect: async cwd => {
      await expect(readFile(join(cwd, 'diagnostics.ts'), 'utf8')).resolves.toBe(content)
      const sessionsDir = join(cwd, '.sessions')
      const files = await readdir(sessionsDir, { recursive: true })
      const sessionFile = files.find(file => file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd'))
      if (sessionFile === undefined) throw new Error('headless LSP test did not persist a session')
      const persisted = await readFile(join(sessionsDir, sessionFile))
      if (sessionFile.endsWith('.zstd')) {
        const { frames, tornStart } = scanZstdFrames(persisted)
        expect(tornStart).toBeUndefined()
        sessionLog = frames.map(({ start, end }) => zstdDecompressSync(persisted.subarray(start, end)).toString()).join('')
      } else {
        sessionLog = persisted.toString('utf8')
      }
      sessionLog = normalizeSessionSnapshot(sessionLog, fixtureContext(sessionLog))
    },
  })

  expect(stderr).toBe('')
  expect(stdout).toBe('LSP_POST_EDIT_DIAGNOSTICS_OK\n')
  expect(sessionLog.split('\n').some(line =>
    line.includes('"type":"tool/result"')
    && line.includes('Created file')
    && line.includes('Diagnostics for diagnostics.ts:')
    && line.includes('LSP_FIXTURE_DIAGNOSTIC'),
  )).toBe(true)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

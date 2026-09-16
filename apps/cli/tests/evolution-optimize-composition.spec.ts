/**
 * The corpus-scoring and offline-optimization rows over the REAL shipped Web
 * composition: both ship off because their values — the recorded corpus root
 * and the agent composition each scoring attempt boots — belong to a
 * deployment, and the example overlay is what turns them on. The spec composes
 * the app installation's bundle layers plus that overlay through the boot's own
 * patch algorithm and pins the effective rows and the values the `!!js`
 * expressions resolve to, so a removed row, a flipped default, or a drifted
 * overlay path fails here instead of at a user's first `/curator optimize`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, initProfile, loadOverlayPatches, loadProfile, PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'

/** Evaluate one `!!js` config value against a stubbed `process`, or return it as written. */
function resolved(value: unknown, cwd = '/repo'): unknown {
  if (value !== null && typeof value === 'object' && '__jsExpr' in value) {
    return evaluate({ process: { cwd: () => cwd } }, (value as { __jsExpr: string }).__jsExpr)
  }
  return value
}

describe('the corpus scoring and optimization rows', () => {
  let home: string | undefined
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  // The app installation anchor: the bundle layers resolve from the REAL
  // dsh-base/dsh-web-app packages through it, not from test fixtures.
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url))
  const overlay = fileURLToPath(new URL('../config/examples/evolution-optimize/cordis.yml', import.meta.url))

  function compose(extra: readonly PatchOptions[][]) {
    home = mkdtempSync(join(tmpdir(), 'dsh-evolution-optimize-'))
    initProfile(join(home, PROFILES_DIR, 'web'), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const profile = loadProfile('dsh', 'web', anchor, home)
    return new Map(composeEntries(
      [...profile.layers.map(layer => layer.patches), ...extra],
      (message) => { throw new Error(`unexpected composition warning: ${message}`) },
    ).map(row => [row.id, row]))
  }

  it('ships both rows off, needing values a shipped profile cannot invent', () => {
    const rows = compose([])
    expect(rows.get('evolution-scorer')).toMatchObject({ name: '@deepseek-ai/dsh-evolution-scorer', disabled: true })
    expect(rows.get('evolution-optimizer')).toMatchObject({ name: '@deepseek-ai/dsh-evolution-optimizer', disabled: true })
  })

  it('enables them from the example overlay with the repo corpus and attempt composition', () => {
    const rows = compose([loadOverlayPatches('dsh', overlay)])
    const scorer = rows.get('evolution-scorer')
    expect(scorer?.disabled).toBe(false)
    expect(resolved((scorer?.config as { corpusDir?: unknown } | undefined)?.corpusDir))
      .toBe('/repo/snapshots/acp')

    const optimizer = rows.get('evolution-optimizer')
    expect(optimizer?.disabled).toBe(false)
    const config = optimizer?.config as {
      provider?: unknown
      model?: unknown
      agent?: Record<string, unknown>
    }
    expect(config.provider).toBe('deepseek-official')
    expect(config.model).toBe('deepseek-flash')
    expect(resolved(config.agent?.binScript)).toBe('/repo/apps/cli/src/bin.ts')
    expect(resolved(config.agent?.configPath)).toBe('/repo/snapshots/acp/escalation-approved/cordis.yml')
    expect(resolved(config.agent?.tsconfigPath)).toBe('/repo/tsconfig.json')
    // The real dsh entry boots profiles, so every attempt names one.
    expect(config.agent?.profile).toBe('acp')
  })
})

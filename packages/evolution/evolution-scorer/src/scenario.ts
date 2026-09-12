/**
 * Corpus planning for scored runs: read one scenario's recorded inputs off disk
 * without running anything. A scenario that the corpus does not describe, or
 * whose recorded fixture is absent, is reported as a skip — the scorer never
 * records a fixture and never needs an API key.
 * @module @deepseek-ai/dsh-evolution-scorer/scenario
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionFixtureName, sessionFixtureFiles } from '@deepseek-ai/dsh-session-snapshot'
import type { InputScript } from '@deepseek-ai/dsh-session-snapshot'
import type { ScenarioPlanResult } from './types.ts'

/** The recorded ACP input script every scenario directory ships. */
const INPUT_SCRIPT = 'input.json'

/** The optional sidecar that replaces the script derived from the primary fixture. */
const REPLAY_OVERRIDE = 'replay.override.json'

/** The optional directory whose contents seed the run's workspace. */
const WORKSPACE_DIR = 'workspace'

/** The optional directory holding the expected final workspace. */
const WORKSPACE_EXPECTED_DIR = 'workspace.expected'

/**
 * Resolve one scenario's recorded inputs from the corpus.
 *
 * A missing corpus directory is a misconfiguration and throws. A missing
 * scenario directory, input script, or recorded session fixture is reported as
 * a skip, so a caller can score what the corpus has without failing on what the
 * waived recording phase never produced.
 * @param corpusDir - absolute corpus root holding one directory per scenario.
 * @param scenario - scenario directory name.
 * @returns the plan, or the honest reason the scenario cannot be scored.
 */
export async function loadScenarioPlan(corpusDir: string, scenario: string): Promise<ScenarioPlanResult> {
  if (!existsSync(corpusDir)) {
    throw new Error(`evolution-scorer: corpus directory '${corpusDir}' does not exist`)
  }
  const dir = join(corpusDir, scenario)
  if (!existsSync(dir)) return { status: 'skipped', reason: `scenario '${scenario}' is not in the corpus` }
  const names = await readdir(dir)
  if (!names.some(name => parseSessionFixtureName(name) !== undefined)) {
    return { status: 'skipped', reason: `scenario '${scenario}' ships no recorded session fixture` }
  }
  if (!names.includes(INPUT_SCRIPT)) {
    return { status: 'skipped', reason: `scenario '${scenario}' ships no ${INPUT_SCRIPT}` }
  }
  const fixtures = sessionFixtureFiles(names)
  const [primary, ...children] = fixtures
  /* v8 ignore start -- the guard above proves at least one name parsed as a fixture, so the inventory always has a parent. */
  if (primary === undefined) throw new Error(`evolution-scorer: scenario '${scenario}' lost its primary fixture`)
  /* v8 ignore stop */
  const script = JSON.parse(await readFile(join(dir, INPUT_SCRIPT), 'utf8')) as InputScript
  const overrideFile = join(dir, REPLAY_OVERRIDE)
  const workspaceDir = join(dir, WORKSPACE_DIR)
  const expectedWorkspaceDir = join(dir, WORKSPACE_EXPECTED_DIR)
  return {
    status: 'planned',
    plan: {
      scenario,
      dir,
      script,
      fixtureFile: join(dir, primary.name),
      childFiles: children.map(child => join(dir, child.name)),
      ...existsSync(overrideFile) ? { overrideFile } : {},
      ...existsSync(workspaceDir) ? { workspaceDir } : {},
      ...existsSync(expectedWorkspaceDir) ? { expectedWorkspaceDir } : {},
    },
  }
}

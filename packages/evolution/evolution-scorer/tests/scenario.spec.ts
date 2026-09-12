import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadScenarioPlan } from '../src/scenario.ts'

let root = ''
let corpus = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'evolution-scorer-plan-'))
  corpus = join(root, 'corpus')
  await mkdir(corpus, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Materialize one scenario directory from relative paths. */
async function writeScenario(name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const dir = join(corpus, name)
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return dir
}

describe('loadScenarioPlan', () => {
  it('fails loud when the configured corpus directory does not exist', async () => {
    await expect(loadScenarioPlan(join(root, 'absent'), 'text-turn'))
      .rejects.toThrow(/corpus directory .* does not exist/)
  })

  it('skips a scenario the corpus does not describe', async () => {
    await expect(loadScenarioPlan(corpus, 'absent')).resolves
      .toEqual({ status: 'skipped', reason: "scenario 'absent' is not in the corpus" })
  })

  it('skips a scenario directory that ships no recorded session fixture', async () => {
    await writeScenario('unrecorded', { 'input.json': '{ "steps": [] }' })
    await expect(loadScenarioPlan(corpus, 'unrecorded')).resolves
      .toEqual({ status: 'skipped', reason: "scenario 'unrecorded' ships no recorded session fixture" })
  })

  it('skips a scenario that ships a fixture but no input script', async () => {
    await writeScenario('scriptless', { 'session.jsonl': '' })
    await expect(loadScenarioPlan(corpus, 'scriptless')).resolves
      .toEqual({ status: 'skipped', reason: "scenario 'scriptless' ships no input.json" })
  })

  it('returns only the resolved inputs a scenario actually ships', async () => {
    const dir = await writeScenario('text-turn', {
      'input.json': '{ "steps": [ { "op": "initialize" } ] }',
      'session.jsonl': '',
    })
    await expect(loadScenarioPlan(corpus, 'text-turn')).resolves.toEqual({
      status: 'planned',
      plan: {
        scenario: 'text-turn',
        dir,
        script: { steps: [{ op: 'initialize' }] },
        fixtureFile: join(dir, 'session.jsonl'),
        childFiles: [],
      },
    })
  })

  it('resolves the highest fixture generation, its children, and the optional sidecars', async () => {
    const dir = await writeScenario('workspace-edit', {
      'input.json': '{ "steps": [] }',
      'session.jsonl': '',
      'session.v2.jsonl': '',
      'session.1.jsonl': '',
      'replay.override.json': '[]',
      'workspace/note.txt': 'seed\n',
      'workspace.expected/note.txt': 'expected\n',
    })
    await expect(loadScenarioPlan(corpus, 'workspace-edit')).resolves.toEqual({
      status: 'planned',
      plan: {
        scenario: 'workspace-edit',
        dir,
        script: { steps: [] },
        fixtureFile: join(dir, 'session.v2.jsonl'),
        childFiles: [join(dir, 'session.1.jsonl')],
        overrideFile: join(dir, 'replay.override.json'),
        workspaceDir: join(dir, 'workspace'),
        expectedWorkspaceDir: join(dir, 'workspace.expected'),
      },
    })
  })
})

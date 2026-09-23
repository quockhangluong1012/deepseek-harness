// Web e2e scenario: evolution journey page — clicking the Evolution sidebar
// row opens the center-track journey panel, which reads the Scope's recorded
// evolution activity from the Host Remote.
//
// The test seeds the evolution-memory store with fixture data (2 lessons across
// 2 UTC+7 days, 1 staged entry, 2 outputs), then opens the journey panel and
// captures the rendered aria snapshot.
//
// Snapshot flow: the page reads from three Host Remotes (evolution.read,
// evolution.timeline, evolutionCurator.status), so the record must be durable
// in the store before the page mounts. The session.jsonl fixture exercises the
// `/journey 7d` CLI command separately.
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/evolution-journey', import.meta.url))
const MODE = webSnapshotMode()
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const SESSION_FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const WORKSPACE_NAME = 'journey-fixture'
const SEED_ID = 'evolution-journey-fixture'

describe('web e2e: evolution journey page (timeline / pending / curator / capacity)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * Seed the evolution-memory store with fixture data for the given workspace.
   */
  async function seedEvolutionMemory(workspaceId: WorkspaceId): Promise<void> {
    const scopeId = EvolutionScopeId('default', String(workspaceId))
    const store = scaffold.ctx.evolutionMemory
    const at = (instant: string) => ({
      at: instant,
      origin: 'background_review' as const,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      sessionId: 's-1',
      inputBytes: 1_024,
      truncated: false,
    })

    // Day 1 (2026-09-10 UTC+7): first lesson write
    await store.replaceArtifacts(scopeId, [{
      statement:
        '* Use punycode for IDN domains when constructing request URLs\n'
        + '* Always cite sources when returning research results',
      source: 's-1',
      conditions: '',
      evidence: 'inference',
      confidence: 0.5,
      scope: 'project',
    }], at('2026-09-10T08:00:00.000Z'))

    // Day 2 (2026-09-11 UTC+7): lesson update + outputs + staged write
    await store.replaceArtifacts(scopeId, [{
      statement:
        '* Use punycode for IDN domains when constructing request URLs\n'
        + '* Always cite sources when returning research results\n'
        + '* Prefer markdown over HTML for all output formatting',
      source: 's-3',
      conditions: '',
      evidence: 'inference',
      confidence: 0.5,
      scope: 'project',
    }], { ...at('2026-09-11T02:00:00.000Z'), inputBytes: 2_048, sessionId: 's-3' })

    await store.recordOutputs(scopeId, [
      { tool: 'write', path: '/tmp/out1.md', at: '2026-09-11T02:00:01.000Z', sessionId: 's-3' },
      { tool: 'write', path: '/tmp/out2.md', at: '2026-09-11T02:00:02.000Z', sessionId: 's-3' },
    ])

    await store.stageWrite({
      scopeId,
      kind: 'memory',
      op: 'replaceArtifacts',
      payload: { candidates: [{ statement: 'add lesson about error handling' }] },
      originSessionId: 's-9',
      gist: 'add lesson about error handling',
    })
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await mkdir(join(scaffold.workspaceCwd, WORKSPACE_NAME), { recursive: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
    await scaffold.close()
  })

  it('renders the journey panel with seeded data', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-evolution-journey'))

    // Adopt the workspace directory
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.locator('input[aria-label="Edit path"]')
    await pathInput.fill(join(scaffold.workspaceCwd, WORKSPACE_NAME))
    await page.keyboard.press('Enter')
    await pathInput.waitFor({ state: 'detached', timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path', exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })

    const workspacePath = join(scaffold.workspaceCwd, WORKSPACE_NAME)
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(workspacePath),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(workspacePath)
    if (workspace === undefined) throw new Error(`evolution journey e2e: workspace "${workspacePath}" was not adopted`)

    // Seed the evolution-memory store before the page reads it
    await seedEvolutionMemory(workspace.id)

    // Seed a session that shares this workspace, then make it current by
    // clicking the workspace name in the tree (which opens workspace-memory
    // and anchors the workspace context for other panels).
    const fixtureText = await readFile(SESSION_FIXTURE, 'utf8')
    await seedSession(scaffold, fixtureText, SEED_ID)
    const wsRow = page.locator('[role="treeitem"]').filter({ hasText: WORKSPACE_NAME }).first()
    await wsRow.getByText(WORKSPACE_NAME, { exact: true }).click()
    await page.getByRole('heading', { name: WORKSPACE_NAME, level: 1 }).waitFor({ state: 'attached', timeout: 15_000 })

    // Open the Evolution sidebar row
    const evolutionRow = page.locator('[role="treeitem"]').filter({ hasText: 'Evolution' }).first()
    await evolutionRow.click()

    // The journey panel replaces the workspace-memory page; the workspace
    // name is the scope title, rendered as the page heading.
    await page.getByRole('heading', { name: WORKSPACE_NAME, level: 1 }).waitFor({ state: 'attached', timeout: 10_000 })

    const snapshot = await captureStableAria(
      page,
      '[data-testid="evolution-page"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'session.v3.jsonl', 'snapshot.yml'])
  })
})

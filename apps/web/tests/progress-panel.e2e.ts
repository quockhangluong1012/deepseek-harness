// Web acceptance for the right Sidebar's progress panel. A real Chromium drives
// the recorded workspace-write conversation: the model calls the write tool, and
// the panel must open itself with the produced file, then hand that file to the
// Sidebar's text preview when its row is clicked.
//
// The recorded conversation is the sandbox-policy scenario's own fixture, the
// one shipped sequence whose model answer mutates a file; this spec references
// that role rather than recording a second one, and asserts nothing about the
// policy context the other spec owns.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/permission-policy-context/session.v3.jsonl', import.meta.url))

/** The recorded prompts, in fixture order: the model answers them one by one. */
const PROMPTS = [
  'Can you create or edit a normal file right now under the current policy? Answer directly in one sentence. Do not call a tool just to discover the policy.',
  'Does the DSH file sandbox currently restrict file operations? Answer directly in one sentence. Do not call tools.',
  'Reply with exactly WORKSPACE_POLICY_SEEN. Do not call tools.',
  'Create the relative path policy-neutral.txt in the current workspace containing exactly POLICY_NEUTRAL_OK, verify its contents, then report completion.',
] as const

const PRESET_LABELS = ['Read Only', 'Full access', 'Workspace Write'] as const

describe('web e2e: the progress panel reveals itself for produced files', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let disposeApproval: (() => void) | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      // The sandbox-policy spec owns this fixture's recorded expectations; this
      // spec drives the same conversation for the panel's behavior only.
      compareReplaySession: false,
    })
    // The write lands under an approval escalation; the scenario's own answer
    // keeps the recorded turn reproducible.
    disposeApproval = scaffold.ctx.on('approval/request', () => Promise.resolve('allowed-once'), { prepend: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    disposeApproval?.()
    await scaffold?.close()
  })

  it('opens the column on the produced file and previews it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-progress-panel'))
    const column = page.locator('[data-rightbar-col]')
    const panel = column.locator('[data-sidebar-right-open]')
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()

    for (const [index, preset] of ['read-only', 'danger-full-access', 'workspace-write'].entries()) {
      await writeComposerDraft(page, input, `/permission ${preset}`)
      await input.press('Enter')
      await page.getByRole('button', { name: `Access mode, current: ${PRESET_LABELS[index]}` })
        .waitFor({ timeout: 10_000 })

      const settled = scaffold.whenTurnSettled()
      await writeComposerDraft(page, input, PROMPTS[index] as string)
      await input.press('Enter')
      await settled
      await input.waitFor({ timeout: 10_000 })
    }

    await writeComposerDraft(page, input, '/permission read-only')
    await input.press('Enter')
    await page.getByRole('button', { name: 'Access mode, current: Read Only' }).waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await writeComposerDraft(page, input, PROMPTS[3])
    await input.press('Enter')
    await settled

    // The write in turn 4 is this Session's first progress: nothing opened the
    // column before it, and the produced file opens it now, on its own tab.
    await panel.waitFor({ timeout: 20_000 })
    await expect.poll(async () => await column.locator('[data-dockkit-tab-title]').allInnerTexts())
      .toContain('Progress')

    const file = column.locator('button', { hasText: 'policy-neutral.txt' })
    await file.waitFor({ timeout: 10_000 })
    await expect.poll(async () => await file.getAttribute('title')).toBe('policy-neutral.txt')
    await file.click()

    // The row opens the file it names through the Sidebar's own viewer, so the
    // panel and the produced-file row lead to the same content.
    await expect.poll(async () => await page.locator('[data-textpreview-state="text"]').innerText(), { timeout: 20_000 })
      .toContain('POLICY_NEUTRAL_OK')
    expect(tripwire.pageErrors).toEqual([])
  }, 240_000)
})

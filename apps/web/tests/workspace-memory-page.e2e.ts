// Web e2e scenario: workspace memory page — clicking a Workspace name opens
// its page in the frame's center track over the real wire (workspaceMemory.read
// + follow baseline), the three cards render, the description edits through
// setDescription, and one of the chats the page lists is what leaves it. Zero
// model calls: every verb here is a host RPC with no model involvement, and no
// seed session is needed — adopting a folder mints the blank Session the Chats
// tab lists.
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/workspace-memory', import.meta.url))
const MODE = webSnapshotMode()
const PAGE_EXPECTED = join(SNAPSHOT_DIR, 'page.expected.md')
const TITLE = 'memory-ws'
const DESCRIPTION = 'Staging rules for the memory page probe'

describe('web e2e: workspace memory page (open / cards / describe / dismiss)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * Adopt an existing directory through the real dialog. The fixed folder name
   * keeps the workspace title (and the aria golden below) deterministic.
   */
  async function adoptDirectory(path: string): Promise<void> {
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.locator('input[aria-label="Edit path"]')
    await pathInput.fill(path)
    // Enter's keydown can retire the editor before keyup; target the focused keyboard, not that retiring node.
    await page.keyboard.press('Enter')
    await pathInput.waitFor({ state: 'detached', timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path', exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(path),
      { timeout: 10_000 },
    ).not.toBeUndefined()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await mkdir(join(scaffold.workspaceCwd, TITLE), { recursive: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the page from the workspace name and renders three cards', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-memory-open'))
    await adoptDirectory(join(scaffold.workspaceCwd, TITLE))
    // The name fires the opener, not the group toggle: the memory page lands.
    const row = page.locator('[role="treeitem"]').filter({ hasText: TITLE }).first()
    await row.waitFor({ timeout: 10_000 })
    await row.getByText(TITLE, { exact: true }).click()
    const surface = page.getByRole('region', { name: 'Workspace memory' })
    await surface.waitFor({ timeout: 10_000 })
    await expect.poll(() => surface.getByRole('region', { name: 'Instructions' }).count(), { timeout: 10_000 }).toBe(1)
    expect(await surface.getByRole('region', { name: 'Memory' }).count()).toBe(1)
    expect(await surface.getByRole('region', { name: 'Context' }).count()).toBe(1)
    expect(await surface.getByText('No produced files yet.').count()).toBe(1)
    const snapshot = await captureStableAria(page, '[data-testid="workspace-memory-page"]', scaffold.workspaceCwd, { normalizeAge: true })
    await compareOrRefreshGolden(PAGE_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('edits the description over the wire and leaves through the chats it lists', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-memory-describe'))
    const surface = page.getByRole('region', { name: 'Workspace memory' })
    await surface.waitFor({ timeout: 10_000 })
    await surface.getByRole('button', { name: 'Add a description…' }).click()
    await surface.getByRole('textbox', { name: 'Description' }).fill(DESCRIPTION)
    await surface.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => surface.getByText(DESCRIPTION, { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    // Durable on the host: the store carries the new blurb.
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(join(scaffold.workspaceCwd, TITLE))
    expect(workspace).toBeDefined()
    expect(scaffold.ctx.workspaceMemory.read(workspace!.id)?.description).toBe(DESCRIPTION)
    // The page carries no dismissal of its own: it is a surface, and the two
    // controls that leave it are the sidebar's chats and Workspaces.
    expect(await surface.getByRole('button', { name: 'Back' }).count()).toBe(0)
    // Opening one of the chats it lists is what leaves it; the conversation
    // underneath was never unmounted, so it is simply visible again.
    await surface.getByRole('button', { name: new RegExp(TITLE) }).click()
    await surface.waitFor({ state: 'hidden', timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('docks the resident composer into the band the page holds below its name and description', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-memory-composer'))
    const row = page.locator('[role="treeitem"]').filter({ hasText: TITLE }).first()
    await row.getByText(TITLE, { exact: true }).click()
    const surface = page.getByRole('region', { name: 'Workspace memory' })
    await surface.waitFor({ timeout: 10_000 })
    // The page draws no input of its own; the one editor belongs to the
    // conversation, which stays mounted beneath it — and it is the compact
    // composer, never the blank-session hero chrome.
    expect(await surface.getByRole('textbox').count()).toBe(0)
    expect(await page.getByText('Into the Unknown').count()).toBe(0)
    const composer = page.locator('[data-composer-seat]').getByRole('textbox')
    await composer.waitFor({ timeout: 10_000 })
    await expect.poll(() => composer.isVisible(), { timeout: 10_000 }).toBe(true)
    // The preset chip that stages the next session travels with the band; the
    // Workspace picker does not, because the page names its Workspace already.
    expect(await page.locator('[data-composer-seat]').getByText('Standard mode').count()).toBe(1)
    expect(await page.locator('[data-composer-seat]').getByRole('button', { name: 'Choose workspace' }).count()).toBe(0)
    // The seat lands in the page's own composer band: level with the band's
    // top, below the identity row, and above the Outputs section it precedes.
    const bandBox = await page.locator('[data-page-band]').boundingBox()
    const seatBox = await page.locator('[data-composer-seat]').boundingBox()
    const identityBox = await surface.getByRole('heading', { name: TITLE }).boundingBox()
    const outputsBox = await surface.getByRole('region', { name: 'Outputs' }).boundingBox()
    const composerBox = await composer.boundingBox()
    const cardBox = await page.locator('[data-composer-card]').first().boundingBox()
    expect(bandBox).not.toBeNull()
    expect(seatBox).not.toBeNull()
    expect(identityBox).not.toBeNull()
    expect(outputsBox).not.toBeNull()
    expect(composerBox).not.toBeNull()
    expect(cardBox).not.toBeNull()
    expect(Math.abs(seatBox!.y - bandBox!.y)).toBeLessThanOrEqual(1.5)
    expect(composerBox!.y).toBeGreaterThan(identityBox!.y)
    expect(composerBox!.y).toBeLessThan(outputsBox!.y)
    // The band clears the identity row by its own top pad, and the hero card is
    // the page's own column: the same left and right edges as the Outputs card
    // it sits above, so the page reads one column, not an inset control.
    expect(composerBox!.y - bandBox!.y).toBeGreaterThanOrEqual(20)
    expect(Math.abs(cardBox!.x - outputsBox!.x)).toBeLessThanOrEqual(1.5)
    expect(Math.abs((cardBox!.x + cardBox!.width) - (outputsBox!.x + outputsBox!.width))).toBeLessThanOrEqual(1.5)
    // One line down the page: the seat's box is the left column's own edges,
    // and the rail opens on the hero's line beside it rather than under it.
    expect(Math.abs(seatBox!.x - outputsBox!.x)).toBeLessThanOrEqual(1.5)
    const instructionsBox = await surface.getByRole('region', { name: 'Instructions' }).boundingBox()
    expect(instructionsBox).not.toBeNull()
    expect(Math.abs(instructionsBox!.y - bandBox!.y)).toBeLessThanOrEqual(2)
    // The name and the description open the page above both the composer and
    // the rail's first card, so neither the hero nor the instruction section
    // is reached before the page has said which Workspace it is. The identity
    // row is content-sized: the band opens one page gap under it (the row's
    // bottom pad plus the 24px gap, with tolerance) instead of after the free
    // height a stretched row would have absorbed.
    const descriptionBox = await surface.getByRole('region', { name: 'Description' }).boundingBox()
    expect(descriptionBox).not.toBeNull()
    expect(identityBox!.y + identityBox!.height).toBeLessThanOrEqual(bandBox!.y)
    expect(descriptionBox!.y + descriptionBox!.height).toBeLessThanOrEqual(instructionsBox!.y)
    expect(bandBox!.y - (descriptionBox!.y + descriptionBox!.height)).toBeLessThanOrEqual(48)
    expect(instructionsBox!.x).toBeGreaterThan(outputsBox!.x + outputsBox!.width)
    // The command popup: the composer card sits directly under the page
    // identity row, so the popup flips below it, and it is portaled to the body —
    // out of the isolated column — so the page layer cannot cover it.
    await page.getByRole('button', { name: 'Commands' }).click()
    const menu = page.locator('[data-trigger-menu]')
    await menu.waitFor({ timeout: 10_000 })
    // The header leaves no room above the composer card, so the menu hangs
    // below it and stays inside the viewport.
    expect(await menu.getAttribute('data-side')).toBe('below')
    const menuBox = await menu.boundingBox()
    expect(menuBox).not.toBeNull()
    expect(cardBox).not.toBeNull()
    expect(menuBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height)
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    // Portaled out of the conversation column: the page layer cannot cover it.
    expect(await menu.evaluate(el => el.closest('[data-testid="workspace-memory-page"]') === null)).toBe(true)
    await page.keyboard.press('Escape')
    // The page leaves the band click-through: a point inside the composer hits
    // the composer's own subtree, not the page painted over the same column.
    expect(await composer.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return hit !== null && el.contains(hit)
    })).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    expect(tripwire.warnings).toEqual([])
    // The page aria golden is this spec's one owned artifact; the seed it
    // names is owned (and inventory-guarded) by seeded-history.
    await assertFixtureInventory(SNAPSHOT_DIR, ['.gitkeep', 'page.expected.md'])
  })
})

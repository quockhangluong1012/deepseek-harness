import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const RELEASE_ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.example.desktop',
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_API_KEY: '/private/credentials/AuthKey_TEST123456.p8',
  APPLE_API_KEY_ID: 'TEST123456',
  APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555',
  DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
}

describe('desktop application icons', () => {
  beforeAll(() => {
    for (const [name, value] of Object.entries(RELEASE_ENVIRONMENT)) vi.stubEnv(name, value)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('vendors the whale mark in every packaging format', async () => {
    const png = await readFile(join(PACKAGE_ROOT, 'assets', 'icon.png'))
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(png.length).toBeGreaterThan(1024)

    const ico = await readFile(join(PACKAGE_ROOT, 'assets', 'icon.ico'))
    expect(Array.from(ico.subarray(0, 4))).toEqual([0x00, 0x00, 0x01, 0x00])

    const icns = await readFile(join(PACKAGE_ROOT, 'assets', 'icon.icns'))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
  })

  it('points every platform installer and the packaged window at the whale mark', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'darwin', 'arm64')
    expect(config.mac.icon).toBe('assets/icon.icns')
    expect(config.win.icon).toBe('assets/icon.ico')
    expect(config.linux.icon).toBe('assets/icon.png')
    expect(config.files).toContain('assets/icon.png')
  }, 30_000)
})

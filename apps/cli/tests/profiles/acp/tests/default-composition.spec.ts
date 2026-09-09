/**
 * The default ACP composition stays byte-identical to the snapshot-record
 * patch it references: the file was a symlink to
 * `snapshots/acp/escalation-approved/cordis.yml`, flattened to a one-line
 * path stub on checkouts without symlink support (which fails
 * `verify-cordis-config` with "root must be a Loader entry array"). An
 * inlined copy plus this equality test keeps the composition working
 * everywhere without silent drift.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const profile = resolve(import.meta.dirname, '..', 'cordis.yml')
const referenced = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'snapshots',
  'acp',
  'escalation-approved',
  'cordis.yml',
)

describe('default ACP composition', () => {
  it('stays byte-identical to the referenced snapshot-record patch', () => {
    expect(readFileSync(profile, 'utf8')).toBe(readFileSync(referenced, 'utf8'))
  })
})

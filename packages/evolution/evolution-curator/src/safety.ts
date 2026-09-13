/**
 * Pass safety for the evolution curator: per-pass tarball snapshots, an
 * append-only JSONL ledger with content-addressed blobs, keep-N pruning, and
 * the read paths behind fail-closed rollback. Filesystem mechanics only;
 * pass orchestration lives in the service.
 *
 * Snapshots capture transitioned skills' telemetry records plus their skill
 * directories for audit and future restore; record rollback leaves files
 * alone, while a consolidation run's recorded package moves are reversed by
 * {@link reverseMoves}. Every path roots at the resolved harness home, which tests
 * redirect through `$DSH_HOME`.
 * @module @deepseek-ai/dsh-evolution-curator/src/safety
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { appendFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { create, list } from 'tar'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isExcludedSkillSource } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'

/** Ledger actor for curator passes and transitions. */
export type LedgerActor = 'curator' | 'operator'

/** Ledger entry kinds: passes, transitions, rollbacks, adoptions, purges, consolidation cost rows, body patches, and package moves. */
export type LedgerAction = 'pass' | 'transition' | 'rollback' | 'adopt' | 'purge' | 'cost' | 'patch' | 'move'

/**
 * One append-only ledger entry. Before/after hold content-addressed blob
 * shas of the skill record JSON, or null when the side has no record.
 */
export interface LedgerEntry {
  /** Stable entry identity for single-entry rollback. */
  id: string
  /** ISO-8601 instant the entry was appended. */
  at: string
  /** Who wrote the entry. */
  actor: LedgerActor
  /** Entry kind. */
  action: LedgerAction
  /** String-only linkage: pass ids, skill names, reasons, snapshot names. */
  evidence: Record<string, string>
  /** Blob sha of the record JSON before the movement, or null. */
  before: string | null
  /** Blob sha of the record JSON after the movement, or null. */
  after: string | null
}

/** Snapshot file prefix inside the snapshots directory. */
const SNAPSHOT_PREFIX = 'pass-'

/** Suffix marking pre-rollback record snapshots. */
const PRE_ROLLBACK_PREFIX = 'pre-rollback-'

/**
 * Resolve the curator home holding snapshots, blobs, and the ledger.
 * @returns the absolute curator home directory.
 */
export function curatorHome(): string {
  return dshHomePath('evolution-curator')
}

/**
 * Hash one record JSON into its content address.
 * @param record - skill record to address.
 * @returns lowercase hex sha256.
 */
export function recordSha(record: SkillUsageRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

/**
 * Resolve one skill name to its backup directory from catalog summaries.
 * Missing entries, file-less entries, and excluded sources resolve to
 * undefined so the pass records them as unresolved instead of failing.
 * @param summaries - catalog skill summaries.
 * @param name - skill name.
 * @returns the skill directory, or undefined when not backup-eligible.
 */
export function resolveBackupDir(
  summaries: readonly { name: string; source: string; path?: string }[],
  name: string,
): string | undefined {
  const found = summaries.find(skill => skill.name === name)
  if (found === undefined || found.path === undefined) return undefined
  if (isExcludedSkillSource(found.source)) return undefined
  return dirname(found.path)
}

/**
 * Whether one path exists, treating every filesystem failure as absence.
 * Snapshots skip missing skill directories; only the ledger stays strict.
 * @param path - candidate path.
 * @returns whether a stat succeeds.
 */
export async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/**
 * Store one blob under its content address.
 * @param home - curator home directory.
 * @param sha - content address from {@link recordSha}.
 * @param text - blob text.
 */
export async function writeBlob(home: string, sha: string, text: string): Promise<void> {
  await mkdir(join(home, 'blobs'), { recursive: true })
  await writeFile(join(home, 'blobs', `${sha}.json`), text)
}

/**
 * Snapshot one pass: stage transitioned records plus resolvable skill
 * directories, archive the stage as a tarball, and prune older snapshots.
 * @param home - curator home directory.
 * @param passId - pass identity naming the tarball.
 * @param at - ISO-8601 pass instant.
 * @param records - skill name to before/after record pairs.
 * @param dirs - skill name to directory; missing directories skip.
 * @param keep - tarballs retained after pruning.
 * @returns the tarball filename and the names skipped as unresolved.
 */
export async function snapshotPass(
  home: string,
  passId: string,
  at: string,
  records: ReadonlyMap<string, { before: SkillUsageRecord; after: SkillUsageRecord }>,
  dirs: ReadonlyMap<string, string>,
  keep: number,
): Promise<{ archive: string; unresolved: string[] }> {
  const stage = join(tmpdir(), `evolution-curator-${passId}`)
  await mkdir(join(stage, 'records'), { recursive: true })
  const unresolved: string[] = []
  const names = [...records.keys()].sort()
  for (const name of names) {
    const pair = records.get(name) as { before: SkillUsageRecord; after: SkillUsageRecord }
    await writeBlob(home, recordSha(pair.before), JSON.stringify(pair.before))
    await writeBlob(home, recordSha(pair.after), JSON.stringify(pair.after))
    await writeFile(join(stage, 'records', `${name}.json`), JSON.stringify({ before: pair.before, after: pair.after }))
    const dir = dirs.get(name)
    if (dir === undefined || !(await pathExists(dir))) {
      unresolved.push(name)
      continue
    }
    await cp(dir, join(stage, 'dirs', name), { recursive: true })
  }
  await writeFile(join(stage, 'manifest.json'), JSON.stringify({ passId, at, names }))
  const archive = `${SNAPSHOT_PREFIX}${at.replaceAll(/[^0-9]/g, '')}-${passId.slice(0, 8)}.tar.gz`
  await mkdir(join(home, 'snapshots'), { recursive: true })
  await create({ gzip: true, file: join(home, 'snapshots', archive), cwd: stage }, ['.'])
  await rm(stage, { recursive: true, force: true })
  await pruneSnapshots(home, keep)
  return { archive, unresolved }
}

/**
 * Snapshot current records ahead of a rollback so the rollback stays
 * reversible. Records only: rollback never touches skill directories.
 * @param home - curator home directory.
 * @param records - skill name to current record.
 * @returns the pre-rollback snapshot identity.
 */
export async function snapshotPreRollback(
  home: string,
  records: ReadonlyMap<string, SkillUsageRecord>,
): Promise<string> {
  const id = `${PRE_ROLLBACK_PREFIX}${randomUUID().slice(0, 8)}`
  for (const record of records.values()) {
    await writeBlob(home, recordSha(record), JSON.stringify(record))
  }
  return id
}

/**
 * Prune snapshot tarballs to the newest `keep` by filename order.
 * @param home - curator home directory.
 * @param keep - tarballs retained.
 */
export async function pruneSnapshots(home: string, keep: number): Promise<void> {
  const dir = join(home, 'snapshots')
  if (!(await pathExists(dir))) return
  const archives = (await readdir(dir))
    .filter(entry => entry.startsWith(SNAPSHOT_PREFIX) && entry.endsWith('.tar.gz'))
    .sort()
    .reverse()
  for (const stale of archives.slice(keep)) {
    await rm(join(dir, stale))
  }
}

/**
 * List one tarball's entry names, newest-first path strings as stored.
 * @param file - tarball path.
 * @returns the archived entry names.
 */
export async function listArchive(file: string): Promise<string[]> {
  const names: string[] = []
  await list({
    file,
    onReadEntry: (entry) => {
      names.push(entry.path)
    },
  })
  return names
}

/**
 * Append one ledger entry as a JSON line, creating the home as needed.
 * @param home - curator home directory.
 * @param entry - entry to append.
 */
export async function appendLedger(home: string, entry: LedgerEntry): Promise<void> {
  await mkdir(home, { recursive: true })
  await appendFile(join(home, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`)
}

/**
 * Read every ledger entry in append order; a missing ledger reads as empty.
 * A malformed line fails loudly, naming the ledger path and that line's 1-based
 * number: the ledger is append-only audit evidence, and an operator repairing it
 * has no other way to locate the damage.
 * @param home - curator home directory.
 * @returns the ledger entries.
 * @throws Error naming the ledger file and line when a line is not valid JSON.
 */
export async function readLedger(home: string): Promise<LedgerEntry[]> {
  const file = join(home, 'ledger.jsonl')
  if (!(await pathExists(file))) return []
  const entries: LedgerEntry[] = []
  for (const [index, line] of (await readFile(file, 'utf8')).split('\n').entries()) {
    if (line.length === 0) continue
    try {
      entries.push(JSON.parse(line) as LedgerEntry)
    } catch (error) {
      throw new Error(`evolution-curator: ledger "${file}" line ${index + 1} is not valid JSON`, { cause: error })
    }
  }
  return entries
}

/**
 * Read one blob by content address.
 * @param home - curator home directory.
 * @param sha - blob content address.
 * @returns the blob text.
 */
export async function readBlob(home: string, sha: string): Promise<string> {
  return readFile(join(home, 'blobs', `${sha}.json`), 'utf8')
}

/**
 * Move one directory tree to a destination path that does not exist yet. A
 * copy works across volumes, where a rename would fail.
 * @param from - existing source directory.
 * @param to - free destination path.
 */
export async function moveTree(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
  await rm(from, { recursive: true, force: true })
}

/**
 * Move recorded package directories back to their pre-consolidation paths.
 * Every move is verified before the first write, so a rollback either restores
 * them all or leaves every package where it is.
 * @param moves - recorded relocations in ledger order.
 */
export async function reverseMoves(moves: readonly { from: string; to: string }[]): Promise<void> {
  for (const move of moves) {
    if (!(await pathExists(move.to))) {
      throw new Error(`evolution-curator: cannot reverse a move whose recorded source '${move.to}' is gone`)
    }
    if (await pathExists(move.from)) {
      throw new Error(`evolution-curator: cannot reverse a move whose original path '${move.from}' is occupied`)
    }
  }
  for (const move of moves) await moveTree(move.to, move.from)
}

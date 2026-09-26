/**
 * Instruction-file discovery and bounded, abort-aware provider reads.
 *
 * @module @deepseek-ai/dsh-agent-instructions/files
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FileSystem, FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { dshHomeDisplay } from '@deepseek-ai/dsh-home-paths'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { resolveConfig, resolveDiscoveryConfig, type ResolvedConfig } from './config.ts'
import { trimmedInstructionDigest } from './digest.ts'
import { rulePathGlobs, splitRuleFrontmatter } from './rules.ts'
import {
  candidateScopeKey,
  decodeScopeKey,
  renderAgentInstructionSet,
  type RenderedAgentInstructions,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_FILE,
} from './render.ts'

/** An instruction candidate identified by absolute and model-facing paths. */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

/** One `@path` import retained so a cached scope can detect changes in imported content. */
export interface ImportedInstructionState {
  /** Absolute path of the imported file. */
  absolutePath: string
  /** Provider freshness token; absent when the import was read from the host filesystem. */
  version?: FsVersion
}

/** An instruction file whose UTF-8 content was read successfully. */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** Provider freshness token when the file was loaded through `ctx.fs`. */
  version?: FsVersion
  /** Files inlined into `content` by `@path` expansion, in expansion order. */
  imports?: readonly ImportedInstructionState[]
}

interface DiscoveredInstructionFile extends InstructionFile {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

/** Provider metadata for a probed scope candidate before its content is read. */
export interface ProbedInstructionFile extends InstructionFile {
  target: FsTarget
  version: FsVersion
  size?: number
}

interface DiscoverOptions {
  cwd: string
  dshHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
  projectRoot?: string
  signal?: AbortSignal
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  maxSourceBytes?: number
  maxTotalSourceBytes?: number
  maxImportDepth?: number
  replacePreviousBaseline?: boolean
}

/** An instruction source skipped before rendering, reported so callers can log it. */
export interface DroppedInstructionSource {
  /** Display path of the skipped file. */
  displayPath: string
  /**
   * `over-source-cap` when the file alone exceeds the per-file cap,
   * `over-total-budget` when earlier files exhausted the batch budget,
   * `unresolved-import` when an `@path` reference stayed literal because it
   * resolved outside the importing file's trust root, repeated a file already
   * on its own chain, exceeded the import-depth limit, or could not be read.
   */
  reason: 'over-source-cap' | 'over-total-budget' | 'unresolved-import'
}

/** Mutable per-load read budget shared by every source read in one batch. */
export interface SourceReadBudget {
  /** Bytes still available to later files in this batch. */
  remaining: number
  /** Sources skipped so far in this batch, in discovery order. */
  dropped: DroppedInstructionSource[]
}

/** Rendered baseline plus the successfully read and byte-budget-retained files. */
export interface RenderedInstructionSet {
  rendered: RenderedAgentInstructions
  /** Successfully read candidates before content deduplication and byte budgeting. */
  observed: LoadedInstructionFile[]
  /** Candidates retained by content deduplication and byte budgeting. */
  included: LoadedInstructionFile[]
  /** Candidates skipped by the per-file cap or the batch read budget, in discovery order. */
  dropped: DroppedInstructionSource[]
}
/** Tri-state scope probe that distinguishes confirmed absence from provider failure. */
export type ScopeInstructionProbe =
  | { kind: 'present'; file: ProbedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

interface StatFileInfo {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

type StatFileProbe =
  | { kind: 'present'; info: StatFileInfo }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function signalOptions(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isMissingProviderPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND'
}

async function nodeStatFile(path: string, signal?: AbortSignal): Promise<StatFileProbe> {
  try {
    signal?.throwIfAborted()
    // stat (not lstat) follows a final-component symlink so a link to a regular
    // file loads; a broken link surfaces as ENOENT and is treated as absent below.
    const info = await stat(path)
    signal?.throwIfAborted()
    if (!info.isFile()) return { kind: 'absent' }
    return { kind: 'present', info: { size: info.size } }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unavailable' }
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  // resolve() follows a final-component symlink to its target's stable identity;
  // stat then classifies that target. A link to a regular file loads, while a
  // missing path or non-file target (including a link to a directory) is absent.
  try {
    const target = await fileSystem.resolve(path, signalOptions(signal))
    signal?.throwIfAborted()
    const info = await fileSystem.stat(target, signal)
    signal?.throwIfAborted()
    if (info?.type !== 'file') return { kind: 'absent' }
    return {
      kind: 'present',
      info: { target, version: info.version, ...info.size === undefined ? {} : { size: info.size } },
    }
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  return fileSystem === undefined ? nodeStatFile(path, signal) : fsStatFile(path, fileSystem, signal)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signalOptions(signal))
      return await fileSystem.stat(target, signal) !== undefined
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isMissingProviderPathError(error)) return false
      throw error
    }
  }
  try {
    signal?.throwIfAborted()
    await stat(path)
    signal?.throwIfAborted()
    return true
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * Walk upward to the first directory containing a configured root marker.
 * @param cwd - absolute session working directory where the walk begins.
 * @param markers - child names that identify a project root.
 * @param fileSystem - optional provider used instead of host filesystem probes.
 * @param signal - cancellation for provider and host probes.
 * @returns the discovered project root, or `cwd` when no marker exists.
 * @throws the original marker metadata error or cancellation reason when a probe is unavailable.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Build the inclusive root-to-cwd directory chain.
 * @param root - root directory expected to contain or equal `cwd`.
 * @param cwd - most-specific directory in the chain.
 * @returns directories ordered from broadest to most specific.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- discovery always supplies cwd or an ancestor root. */
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * Find descendant directories crossed between a cwd and a touched file.
 * @param root - session cwd that bounds nested discovery.
 * @param touchedPath - absolute path or path relative to `root`.
 * @returns descendant directories from shallowest through the touched file's parent.
 */
export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const targetPath = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(targetPath)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

/**
 * Convert an absolute instruction path to its project-root-relative display form.
 * @param root - project root used as the display base.
 * @param path - absolute path to display.
 * @returns the root-relative path.
 */
export function relativeDisplay(root: string, path: string): string {
  return relative(root, path)
}

async function allExistingInstructionFiles(
  dir: string,
  root: string,
  instructionFileCandidates: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<DiscoveredInstructionFile[]> {
  const found: DiscoveredInstructionFile[] = []
  for (const candidate of instructionFileCandidates) {
    const path = join(dir, candidate)
    const probe = await statFile(path, fileSystem, signal)
    switch (probe.kind) {
      case 'present':
        found.push({ absolutePath: path, displayPath: relativeDisplay(root, path), ...probe.info })
        continue
      // A missing candidate is skipped; a transient provider failure skips only
      // that candidate so the remaining independent candidates still load.
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }
  // `CLAUDE.md` is a fallback candidate only: when a sibling `AGENTS.md` (or the
  // same `AGENTS`+suffix form for local overlays) exists in the same directory,
  // the fallback is skipped so the model receives exactly one instruction source
  // per directory. This removes the whole stub-symlink class without relying on
  // filesystem symlink semantics.
  const present = new Set(found.map(file => file.absolutePath))
  return found.filter((file) => {
    const base = file.absolutePath.slice(dir.length + 1)
    if (!base.startsWith('CLAUDE')) return true
    const sibling = join(dir, `AGENTS${base.slice('CLAUDE'.length)}`)
    return !present.has(sibling)
  })
}

async function discoverInstructionFiles(
  options: DiscoverOptions,
  fileSystem?: FileSystem,
): Promise<{ files: DiscoveredInstructionFile[]; projectRoot: string }> {
  const config = resolveDiscoveryConfig(options)
  const files: DiscoveredInstructionFile[] = []
  const seen = new Set<string>()
  const addFile = (file: DiscoveredInstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  const userGlobal = join(config.dshHome, USER_GLOBAL_FILE)
  const userGlobalProbe = await statFile(userGlobal, fileSystem, options.signal)
  switch (userGlobalProbe.kind) {
    case 'present':
      addFile({
        absolutePath: userGlobal,
        displayPath: userGlobalDisplayPath(config.dshHome),
        ...userGlobalProbe.info,
      })
      break
    case 'absent':
    case 'unavailable':
      break
    /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
    default:
      assertNever(userGlobalProbe, 'StatFileProbe')
  }

  const cwd = resolve(options.cwd)
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, options.signal)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidates of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const file of await allExistingInstructionFiles(dir, projectRoot, candidates, fileSystem, options.signal)) {
        addFile(file)
      }
    }
  }
  return { files, projectRoot }
}

/**
 * Discover host-visible user-global and root-to-cwd instruction candidates.
 * All present candidates in each directory are returned; trimmed-content
 * duplicates are collapsed later, once content is read.
 * @param options - cwd, home, root marker, and candidate configuration.
 * @returns path-deduplicated instruction candidates in model precedence order.
 * @throws the original root-marker metadata error or cancellation reason when
 * discovery cannot identify the project root.
 */
export async function discoverBaselineInstructionFiles(options: DiscoverOptions): Promise<InstructionFile[]> {
  const discovered = await discoverInstructionFiles(options)
  return discovered.files.map(({ absolutePath, displayPath }) => ({ absolutePath, displayPath }))
}

async function* nodeTextChunks(path: string, signal?: AbortSignal): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  for await (const chunk of stream) yield String(chunk)
}

async function readBounded(
  file: { absolutePath: string; displayPath: string; target?: FsTarget; size?: number },
  maxSourceBytes: number,
  budget: SourceReadBudget,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  if (file.size !== undefined && file.size > maxSourceBytes) {
    budget.dropped.push({ displayPath: file.displayPath, reason: 'over-source-cap' })
    return undefined
  }
  try {
    const chunks = fileSystem === undefined || file.target === undefined
      ? nodeTextChunks(file.absolutePath, signal)
      : await fileSystem.streamText(file.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxSourceBytes) {
        budget.dropped.push({ displayPath: file.displayPath, reason: 'over-source-cap' })
        return undefined
      }
      if (bytes > budget.remaining) {
        budget.dropped.push({ displayPath: file.displayPath, reason: 'over-total-budget' })
        return undefined
      }
      parts.push(chunk)
    }
    signal?.throwIfAborted()
    budget.remaining -= bytes
    return parts.join('')
  } catch {
    signal?.throwIfAborted()
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

/** Fence opening whose enclosed lines suspend `@path` expansion. */
const IMPORT_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
/** Bare fence line that closes an open fence of the same marker. */
const IMPORT_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
/** `@path` reference in ordinary instruction prose, anchored on a word boundary. */
const IMPORT_REFERENCE = /(^|[\s"'`(])@([^\s@`]+)/gu
/** Punctuation that ends a sentence rather than the referenced path. */
const IMPORT_TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/u

/** Trust roots, caps, and budget for one `@path` expansion pass. */
interface ImportExpansionOptions {
  projectRoot: string
  dshHome: string
  maxImportDepth: number
  maxSourceBytes: number
  budget: SourceReadBudget
  fileSystem?: FileSystem
  signal?: AbortSignal
}

/** Expanded instruction content plus the imports retained for cache validation. */
interface ExpandedInstructionContent {
  content: string
  imports: ImportedInstructionState[]
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel.length > 0 && !isAbsolute(rel) && !rel.startsWith('..')
}

/**
 * Model-facing display path for an imported file, under the project root that
 * contains it or the harness home for a user-global import.
 */
function importDisplayPath(absolutePath: string, projectRoot: string, dshHome: string): string {
  if (isWithin(projectRoot, absolutePath)) return relativeDisplay(projectRoot, absolutePath)
  if (isWithin(dshHome, absolutePath)) return `${dshHomeDisplay(dshHome)}/${relative(dshHome, absolutePath)}`
  /* v8 ignore next -- trust-root checks reject paths outside both roots. */
  return absolutePath
}

/**
 * Inline code spans in one line, whose text is documentation rather than an
 * import site. A run of backticks opens a span that the next run of the same
 * length closes; an unclosed run leaves the rest of the line unprotected.
 */
function inlineCodeRanges(line: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let index = 0
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1
      continue
    }
    let length = 0
    while (line[index + length] === '`') length += 1
    let cursor = index + length
    let end = -1
    while (cursor < line.length) {
      if (line[cursor] !== '`') {
        cursor += 1
        continue
      }
      let run = 0
      while (line[cursor + run] === '`') run += 1
      if (run === length) {
        end = cursor + run
        break
      }
      cursor += run
    }
    if (end === -1) break
    ranges.push({ start: index, end })
    index = end
  }
  return ranges
}

/**
 * Resolve one `@path` reference and inline its expanded content.
 *
 * The reference is expanded only when it names an existing file inside the
 * importing file's trust root, so ordinary prose such as a scoped package name
 * (`@scope/name`) stays byte-identical and is not reported. A reference that
 * repeats a file already on its own chain, names a file outside the trust root,
 * or exceeds `maxImportDepth` also stays literal and is reported as unresolved.
 *
 * @param target - referenced path as written, resolved against the importing file's directory.
 * @param importingAbsolutePath - absolute path of the file containing the reference.
 * @param depth - import depth of the importing file; the top-level file is `0`.
 * @param chain - absolute paths already expanded on this chain, including the importing file.
 * @param trustRoot - directory the reference must resolve inside.
 * @param options - caps, harness home, provider, and the shared batch budget.
 * @returns expanded content with its imports, or undefined when the reference stays literal.
 */
async function readImport(
  target: string,
  importingAbsolutePath: string,
  depth: number,
  chain: readonly string[],
  trustRoot: string,
  options: ImportExpansionOptions,
): Promise<ExpandedInstructionContent | undefined> {
  const absolutePath = isAbsolute(target) ? resolve(target) : resolve(dirname(importingAbsolutePath), target)
  const displayPath = importDisplayPath(absolutePath, options.projectRoot, options.dshHome)
  const drop = (): void => {
    options.budget.dropped.push({ displayPath, reason: 'unresolved-import' })
  }
  if (chain.includes(absolutePath)) {
    drop()
    return undefined
  }
  const probe = await statFile(absolutePath, options.fileSystem, options.signal)
  options.signal?.throwIfAborted()
  // A mention that names no existing file is not an import attempt: scoped
  // package names and other prose `@tokens` stay literal without a report.
  if (probe.kind !== 'present') return undefined
  if (depth >= options.maxImportDepth || !isWithin(trustRoot, absolutePath)) {
    drop()
    return undefined
  }
  const info = probe.info
  const content = await readBounded(
    {
      absolutePath,
      displayPath,
      ...info.target === undefined ? {} : { target: info.target },
      ...info.size === undefined ? {} : { size: info.size },
    },
    options.maxSourceBytes,
    options.budget,
    options.fileSystem,
    options.signal,
  )
  // A read cap already recorded this import in the batch drop list.
  if (content === undefined) return undefined
  const nested = await expandImports(content, absolutePath, depth + 1, [...chain, absolutePath], trustRoot, options)
  return {
    content: nested.content,
    imports: [
      { absolutePath, ...info.version === undefined ? {} : { version: info.version } },
      ...nested.imports,
    ],
  }
}

/**
 * Replace every `@path` reference in one line with the referenced content,
 * leaving prose, code spans, and unresolved references byte-identical.
 */
async function expandImportLine(
  line: string,
  importingAbsolutePath: string,
  depth: number,
  chain: readonly string[],
  trustRoot: string,
  options: ImportExpansionOptions,
): Promise<{ line: string; imports: ImportedInstructionState[] }> {
  if (!line.includes('@')) return { line, imports: [] }
  const references = [...line.matchAll(IMPORT_REFERENCE)]
  if (references.length === 0) return { line, imports: [] }
  const codeRanges = inlineCodeRanges(line)
  const inCode = (offset: number): boolean => codeRanges.some(range => offset >= range.start && offset < range.end)
  const imports: ImportedInstructionState[] = []
  let result = ''
  let cursor = 0
  for (const match of references) {
    const boundary = match[1] as string
    const rawTarget = match[2] as string
    const target = rawTarget.replace(IMPORT_TRAILING_PUNCTUATION, '')
    const referenceStart = match.index + boundary.length
    const referenceEnd = referenceStart + 1 + rawTarget.length
    result += line.slice(cursor, referenceStart)
    const imported = target.length === 0 || inCode(referenceStart)
      ? undefined
      : await readImport(target, importingAbsolutePath, depth, chain, trustRoot, options)
    if (imported === undefined) result += line.slice(referenceStart, referenceEnd)
    else {
      imports.push(...imported.imports)
      result += imported.content + rawTarget.slice(target.length)
    }
    cursor = referenceEnd
  }
  return { line: result + line.slice(cursor), imports }
}

/**
 * Expand `@path` references in one file's content, skipping fenced code blocks.
 * Nested expansion continues until `maxImportDepth`; imports are inlined in
 * place, so a change to an imported file changes the importer's rendered content.
 */
async function expandImports(
  content: string,
  importingAbsolutePath: string,
  depth: number,
  chain: readonly string[],
  trustRoot: string,
  options: ImportExpansionOptions,
): Promise<ExpandedInstructionContent> {
  const imports: ImportedInstructionState[] = []
  const lines: string[] = []
  let fence: string | undefined
  for (const line of content.split('\n')) {
    if (fence === undefined) {
      const open = IMPORT_FENCE_OPEN.exec(line)
      if (open !== null) {
        fence = open[1]
        lines.push(line)
        continue
      }
    } else {
      const close = IMPORT_FENCE_CLOSE.exec(line)
      if (close !== null) {
        const marker = close[1] as string
        if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      }
      lines.push(line)
      continue
    }
    const expanded = await expandImportLine(line, importingAbsolutePath, depth, chain, trustRoot, options)
    lines.push(expanded.line)
    imports.push(...expanded.imports)
  }
  return { content: lines.join('\n'), imports }
}

/**
 * Inline the `@path` imports of one loaded instruction file.
 * @param file - loaded instruction file whose content may reference other files.
 * @param options - trust roots, depth, caps, provider, and the shared batch budget.
 * @returns expanded content plus every imported file retained for cache validation.
 */
async function expandInstructionImports(
  file: LoadedInstructionFile,
  options: ImportExpansionOptions,
): Promise<ExpandedInstructionContent> {
  const trustRoot = isWithin(options.projectRoot, file.absolutePath)
    ? options.projectRoot
    : isWithin(options.dshHome, file.absolutePath) ? options.dshHome : undefined
  if (trustRoot === undefined || options.maxImportDepth <= 0) return { content: file.content, imports: [] }
  return expandImports(file.content, file.absolutePath, 0, [file.absolutePath], trustRoot, options)
}

/**
 * Read one instruction file and expand its `@path` imports under the batch caps.
 * @param file - discovered or probed candidate with its provider metadata.
 * @param config - normalized caps, import depth, and harness home.
 * @param projectRoot - project root bounding project-file imports and display paths.
 * @param budget - batch read budget shared with the other source reads.
 * @param fileSystem - provider used for the source reads.
 * @param signal - cancellation for provider streaming.
 * @returns loaded and expanded content, or undefined when the candidate was skipped.
 */
async function readExpandedInstruction(
  file: { absolutePath: string; displayPath: string; target?: FsTarget; size?: number; version?: FsVersion },
  config: Pick<ResolvedConfig, 'maxSourceBytes' | 'maxImportDepth' | 'dshHome'>,
  projectRoot: string,
  budget: SourceReadBudget,
  fileSystem: FileSystem | undefined,
  signal?: AbortSignal,
  stripFrontmatter = false,
): Promise<LoadedInstructionFile | undefined> {
  const raw = await readBounded(file, config.maxSourceBytes, budget, fileSystem, signal)
  if (raw === undefined) return undefined
  // A rule file's frontmatter is discovery metadata, not guidance, so only its
  // body reaches the model.
  const content = stripFrontmatter ? splitRuleFrontmatter(raw)?.body ?? raw : raw
  const loaded: LoadedInstructionFile = {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    content,
    ...file.version === undefined ? {} : { version: file.version },
  }
  const expanded = await expandInstructionImports(loaded, {
    projectRoot,
    dshHome: config.dshHome,
    maxImportDepth: config.maxImportDepth,
    maxSourceBytes: config.maxSourceBytes,
    budget,
    ...fileSystem === undefined ? {} : { fileSystem },
    ...signal === undefined ? {} : { signal },
  })
  return {
    ...loaded,
    content: expanded.content,
    ...expanded.imports.length === 0 ? {} : { imports: expanded.imports },
  }
}

/** One rule file discovered under the configured rule directory. */
export interface RuleFile {
  absolutePath: string
  /** Model-facing path: the rule directory plus the file's path inside it. */
  displayPath: string
  /** Reconciliation scope key pairing the rule's directory with its file name. */
  scope: string
}

/** Child entries of one directory, from the provider or the host filesystem. */
interface DirectoryEntry {
  name: string
  type: 'file' | 'directory' | 'other'
}

async function readDirectoryEntries(
  dir: string,
  fileSystem: FileSystem | undefined,
  signal?: AbortSignal,
): Promise<DirectoryEntry[]> {
  signal?.throwIfAborted()
  try {
    if (fileSystem === undefined) {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
    }
    const target = await fileSystem.resolve(dir, signalOptions(signal))
    const info = await fileSystem.stat(target, signal)
    if (info?.type !== 'directory') return []
    const entries = await fileSystem.listDir(target, signal)
    return entries.map(entry => ({ name: entry.name, type: entry.type }))
  } catch {
    signal?.throwIfAborted()
    // A missing or unreadable directory simply has no rules.
    return []
  }
}

/**
 * List the Markdown rule files under one project's rule directory, recursively.
 * @param projectRoot - project root the rule directory is relative to.
 * @param ruleDirectory - normalized project-relative rule directory; empty disables discovery.
 * @param fileSystem - optional provider used instead of host directory reads.
 * @param signal - cancellation for provider and host directory reads.
 * @returns rule files in deterministic display-path order.
 */
export async function discoverRuleFiles(
  projectRoot: string,
  ruleDirectory: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<RuleFile[]> {
  if (ruleDirectory.length === 0) return []
  const found: RuleFile[] = []
  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    for (const entry of await readDirectoryEntries(dir, fileSystem, signal)) {
      signal?.throwIfAborted()
      const entryRelative = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.type === 'directory') {
        await walk(join(dir, entry.name), entryRelative)
        continue
      }
      if (entry.type !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue
      const directory = relativeDir.length === 0 ? ruleDirectory : `${ruleDirectory}/${relativeDir}`
      found.push({
        absolutePath: join(dir, entry.name),
        displayPath: `${ruleDirectory}/${entryRelative}`,
        scope: candidateScopeKey(directory, entry.name),
      })
    }
  }
  await walk(join(projectRoot, ruleDirectory), '')
  return found.sort((left, right) => left.displayPath < right.displayPath ? -1 : 1)
}

/** Rule frontmatter fields paired with the version they were read at. */
export interface RuleGlobState {
  globs: readonly string[] | undefined
  version?: FsVersion
}

/**
 * Read one rule file and parse the `paths` globs its frontmatter declares.
 * @param rule - discovered rule file.
 * @param config - normalized source cap and harness home.
 * @param budget - batch read budget shared with the other source reads.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @param signal - cancellation for provider and host reads.
 * @returns the declared globs (undefined when the rule is unconditional), or
 * undefined for the whole result when the file could not be read.
 */
export async function readRuleGlobs(
  rule: RuleFile,
  config: Pick<ResolvedConfig, 'maxSourceBytes' | 'maxImportDepth' | 'dshHome'>,
  budget: SourceReadBudget,
  fileSystem: FileSystem | undefined,
  signal?: AbortSignal,
): Promise<RuleGlobState | undefined> {
  const probe = await statFile(rule.absolutePath, fileSystem, signal)
  signal?.throwIfAborted()
  if (probe.kind !== 'present') {
    // Reads a rule whose metadata could not be observed at all: the caller's
    // failure path owns it, so report the absence as an unreadable rule.
    return probe.kind === 'unavailable' ? undefined : { globs: undefined }
  }
  const info = probe.info
  const content = await readBounded(
    {
      absolutePath: rule.absolutePath,
      displayPath: rule.displayPath,
      ...info.target === undefined ? {} : { target: info.target },
      ...info.size === undefined ? {} : { size: info.size },
    },
    config.maxSourceBytes,
    budget,
    fileSystem,
    signal,
  )
  if (content === undefined) return undefined
  return {
    globs: rulePathGlobs(content),
    ...info.version === undefined ? {} : { version: info.version },
  }
}

/**
 * Read one rule file's instruction body, without its frontmatter, with `@path`
 * imports expanded. Returns undefined for a scoped rule, whose content only
 * loads once a touched path matches.
 */
async function readRuleInstruction(
  rule: RuleFile,
  state: RuleGlobState,
  config: Pick<ResolvedConfig, 'maxSourceBytes' | 'maxImportDepth' | 'dshHome'>,
  projectRoot: string,
  budget: SourceReadBudget,
  fileSystem: FileSystem | undefined,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile | undefined> {
  if (state.globs !== undefined) return undefined
  const probe = await statFile(rule.absolutePath, fileSystem, signal)
  signal?.throwIfAborted()
  if (probe.kind !== 'present') return undefined
  const info = probe.info
  const raw = await readBounded(
    {
      absolutePath: rule.absolutePath,
      displayPath: rule.displayPath,
      ...info.target === undefined ? {} : { target: info.target },
      ...info.size === undefined ? {} : { size: info.size },
    },
    config.maxSourceBytes,
    budget,
    fileSystem,
    signal,
  )
  if (raw === undefined) return undefined
  const body = splitRuleFrontmatter(raw)?.body ?? raw
  const loaded: LoadedInstructionFile = {
    absolutePath: rule.absolutePath,
    displayPath: rule.displayPath,
    content: body,
    ...info.version === undefined ? {} : { version: info.version },
  }
  const expanded = await expandInstructionImports(loaded, {
    projectRoot,
    dshHome: config.dshHome,
    maxImportDepth: config.maxImportDepth,
    maxSourceBytes: config.maxSourceBytes,
    budget,
    ...fileSystem === undefined ? {} : { fileSystem },
    ...signal === undefined ? {} : { signal },
  })
  return {
    ...loaded,
    content: expanded.content,
    ...expanded.imports.length === 0 ? {} : { imports: expanded.imports },
  }
}

/**
 * Discover, classify, and read the rule files that join one baseline chain.
 * Unconditional rules are returned; scoped rules are represented by the caller's
 * touch-driven reconciliation instead.
 * @param projectRoot - project root owning the rule directory.
 * @param config - normalized caps, import depth, rule directory, and harness home.
 * @param budget - batch read budget shared with the other source reads.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @param signal - cancellation for provider and host reads.
 * @returns the unconditional rule files in display-path order.
 */
async function loadBaselineRuleInstructions(
  projectRoot: string,
  config: Pick<ResolvedConfig, 'maxSourceBytes' | 'maxImportDepth' | 'dshHome' | 'ruleDirectory'>,
  budget: SourceReadBudget,
  fileSystem: FileSystem | undefined,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile[]> {
  const rules = await discoverRuleFiles(projectRoot, config.ruleDirectory, fileSystem, signal)
  const loaded: LoadedInstructionFile[] = []
  for (const rule of rules) {
    signal?.throwIfAborted()
    const state = await readRuleGlobs(rule, config, budget, fileSystem, signal)
    if (state === undefined) continue
    const file = await readRuleInstruction(rule, state, config, projectRoot, budget, fileSystem, signal)
    if (file !== undefined) loaded.push(file)
  }
  return loaded
}

/**
 * Drop later candidates whose trimmed content duplicates an earlier sibling in
 * the same directory. Different directories never collapse even when identical;
 * within one directory the earliest candidate in discovery order is kept and its
 * original bytes are rendered. `CLAUDE*` fallbacks are already skipped at
 * discovery when their `AGENTS*` sibling exists, so this stage only collapses
 * genuinely byte-identical files.
 * @param files - loaded files in discovery order.
 * @returns the retained files in the same order.
 */
export function dedupInstructionFilesByDirectory(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const keptDigestsByDir = new Map<string, Set<string>>()
  const kept: LoadedInstructionFile[] = []
  for (const file of files) {
    const dir = dirname(file.displayPath)
    let digests = keptDigestsByDir.get(dir)
    if (digests === undefined) {
      digests = new Set()
      keptDigestsByDir.set(dir, digests)
    }
    const digest = trimmedInstructionDigest(file.content)
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(file)
  }
  return kept
}

/**
 * Discover, read, and render the baseline instruction chain.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered baseline context, or undefined when nothing can be loaded.
 * @throws the original root-marker metadata error or cancellation reason when
 * discovery cannot identify the project root.
 */
export async function loadBaselineInstructions(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedAgentInstructions | undefined> {
  return (await loadBaselineInstructionSet(options, fileSystem))?.rendered
}

/**
 * Load a baseline together with the files retained after rendering.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered context and retained files, an explicit empty replacement set, or undefined when empty or disabled.
 */
export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  if (config.maxSourceBytes <= 0 || !Number.isFinite(config.maxSourceBytes)) return undefined
  if (config.maxTotalSourceBytes <= 0 || !Number.isFinite(config.maxTotalSourceBytes)) return undefined
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const budget: SourceReadBudget = { remaining: config.maxTotalSourceBytes, dropped: [] }
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered.files) {
    const content = await readExpandedInstruction(
      file,
      config,
      discovered.projectRoot,
      budget,
      fileSystem,
      options.signal,
    )
    if (content !== undefined) loaded.push(content)
  }
  // Unconditional rules follow the project chain: they carry no path scope, so
  // they apply everywhere the baseline applies.
  loaded.push(...await loadBaselineRuleInstructions(
    discovered.projectRoot,
    config,
    budget,
    fileSystem,
    options.signal,
  ))
  const deduped = dedupInstructionFilesByDirectory(loaded)
  if (deduped.length === 0) {
    if (options.replacePreviousBaseline !== true && budget.dropped.length === 0) return undefined
    if (options.replacePreviousBaseline === true) {
      const { rendered, included } = renderAgentInstructionSet([], {
        maxBytes: config.maxBytes,
        replacePreviousBaseline: true,
      })
      return {
        rendered,
        observed: [],
        included,
        dropped: budget.dropped,
      }
    }
    // Every source was skipped by a read cap: report the drops with empty
    // rendering (instead of resolving undefined) so callers can log the skip.
    // Text stays empty so no intro-only baseline message enters the context.
    return {
      rendered: { text: '', omitted: [], truncated: [] },
      observed: [],
      included: [],
      dropped: budget.dropped,
    }
  }
  const { rendered, included } = renderAgentInstructionSet(deduped, {
    maxBytes: config.maxBytes,
    ...options.replacePreviousBaseline === undefined
      ? {}
      : { replacePreviousBaseline: options.replacePreviousBaseline },
  })
  return {
    rendered,
    observed: loaded,
    included,
    dropped: budget.dropped,
  }
}

/**
 * Probe the current provider metadata for one per-candidate instruction scope.
 * @param scope - a {@link candidateScopeKey} identifying a directory and candidate file.
 * @param projectRoot - project root used to resolve and display project scopes.
 * @param resolved - normalized plugin configuration.
 * @param fileSystem - provider used to resolve and stat scope candidates.
 * @param signal - cancellation for provider probes.
 * @returns present metadata, confirmed absence, or temporary unavailability.
 */
export async function probeScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<ScopeInstructionProbe> {
  const { directory, candidateName } = decodeScopeKey(scope)
  const dir = directory === USER_GLOBAL_DIRECTORY
    ? resolved.dshHome
    : directory === '.' ? projectRoot : join(projectRoot, directory)
  const absolutePath = join(dir, candidateName)
  // resolve() follows a final-component symlink; stat then classifies the target.
  // A non-file target (missing, or a link to a directory) is a confirmed absence;
  // only a provider exception is reported as unavailable.
  let target: FsTarget
  let info: FsInfo | undefined
  try {
    target = await fileSystem.resolve(absolutePath, signalOptions(signal))
    info = await fileSystem.stat(target, signal)
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
  if (info?.type !== 'file') return { kind: 'absent' }
  const file: ProbedInstructionFile = {
    absolutePath,
    displayPath: directory === USER_GLOBAL_DIRECTORY ? userGlobalDisplayPath(resolved.dshHome) : relativeDisplay(projectRoot, absolutePath),
    target,
    version: info.version,
    ...info.size === undefined ? {} : { size: info.size },
  }
  return { kind: 'present', file }
}

/**
 * Read the current provider freshness token of one instruction source.
 * @param path - absolute path of the already-loaded source.
 * @param fileSystem - provider used for the probe.
 * @param signal - cancellation for provider probes.
 * @returns the current version, or undefined when the file is gone or unreadable.
 */
export async function probeInstructionFileVersion(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<FsVersion | undefined> {
  const probe = await statFile(path, fileSystem, signal)
  return probe.kind === 'present' ? probe.info.version : undefined
}

/**
 * Read one already-probed scope candidate under the configured source caps,
 * expanding its `@path` imports.
 * @param file - winning provider candidate and its metadata snapshot.
 * @param options - source cap, import depth, harness home, display root, and the batch read budget.
 * @param fileSystem - provider used for the streaming read.
 * @param signal - cancellation for provider streaming.
 * @returns loaded content with the probed version, or undefined when unavailable.
 */
export async function readScopeInstruction(
  file: ProbedInstructionFile,
  options: {
    maxSourceBytes: number
    maxImportDepth: number
    dshHome: string
    projectRoot: string
    budget: SourceReadBudget
    /** True when the scope is a rule file, whose frontmatter must not reach the model. */
    stripFrontmatter?: boolean
  },
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile | undefined> {
  return readExpandedInstruction(
    file,
    {
      maxSourceBytes: options.maxSourceBytes,
      maxImportDepth: options.maxImportDepth,
      dshHome: options.dshHome,
    },
    options.projectRoot,
    options.budget,
    fileSystem,
    signal,
    options.stripFrontmatter === true,
  )
}

function userGlobalDisplayPath(dshHome: string): string {
  return `${dshHomeDisplay(dshHome)}/AGENTS.md`
}

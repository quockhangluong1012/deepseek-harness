/**
 * Line-oriented extraction for the repository index: the declarations a source
 * file exposes, the module specifiers it imports, requires, or re-exports, the
 * identifiers one declaration's header block names and calls, and the
 * configuration declarations one file makes.
 *
 * The index has no parser dependency, so these are line facts: a declaration
 * split across lines, a computed import specifier, a specifier whose target the
 * index does not read, a call reached through an alias or a computed property,
 * and an identifier that occurs inside a string or a comment are not
 * recognized, and the reference pass reports a name match rather than a
 * resolved call.
 * @module @deepseek-ai/dsh-repo-index/extract
 */

import type { RepoConfigField, RepoConfigFieldSource, RepoSymbolKind } from './types.ts'

/** One declaration as its line reports it, before the caller adds identity. */
export interface RepoDeclaration {
  /** The declared identifier. */
  readonly name: string
  /** Which declaration form the line matched. */
  readonly kind: RepoSymbolKind
  /** 1-based line number. */
  readonly line: number
}

/** What one file's text yields. */
export interface RepoFileExtraction {
  /** Declarations in line order. */
  readonly declarations: readonly RepoDeclaration[]
  /** Distinct module specifiers in first-occurrence order. */
  readonly specifiers: readonly string[]
}

/**
 * One declaration form and the identifier group it captures, tried in order.
 * `requiresExport` marks the variable form: an exported binding is a module
 * symbol, while a local `const` inside a function body is not.
 */
const DECLARATION_PATTERNS: readonly {
  readonly kind: RepoSymbolKind
  readonly pattern: RegExp
  readonly requiresExport?: boolean
}[] = [
  { kind: 'class', pattern: /^(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', pattern: /^(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'enum', pattern: /^(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /^(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'const', pattern: /^(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, requiresExport: true },
]

/** Prefixes a declaration and an export or re-export line share. */
const EXPORT_PREFIX = 'export '

/** `export ... from 'specifier'` (re-export). */
const REEXPORT_FROM = /^export\s+[^'"]*?from\s*['"]([^'"]+)['"]/

/** `import ... from 'specifier'` (named, default, or namespace binding). */
const IMPORT_FROM = /^import\s+[^'"]*?from\s*['"]([^'"]+)['"]/

/** `import 'specifier'` (side-effect import). */
const IMPORT_BARE = /^import\s*['"]([^'"]+)['"]/

/** `require('specifier')` and `import('specifier')`. */
const DYNAMIC_SPECIFIER = /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/

/** One identifier occurrence. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g

/** One identifier written as a call or construction: `name(`, or a member call's own name. */
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g

/** What one declaration's header block names. */
export interface RepoHeaderReferences {
  /** Identifiers the block names, in first-occurrence order. */
  readonly identifiers: readonly string[]
  /** The subset of those identifiers the block writes as a call or construction, in first-occurrence order. */
  readonly calls: readonly string[]
}

/**
 * Extract one file's declarations and module specifiers.
 * @param text - the file's complete text.
 * @returns the declarations in line order and the distinct specifiers in first-occurrence order.
 */
export function extractFile(text: string): RepoFileExtraction {
  const declarations: RepoDeclaration[] = []
  const specifiers: string[] = []
  const seenSpecifiers = new Set<string>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue
    }
    // An export may be written after `declare`, `default`, or `abstract`; only
    // its first word matters for the indentation rule below.
    const exported = trimmed.startsWith(EXPORT_PREFIX)
    const subject = exported ? trimmed.slice(EXPORT_PREFIX.length).trim() : trimmed
    for (const { kind, pattern, requiresExport } of DECLARATION_PATTERNS) {
      if (requiresExport === true && !exported) continue
      const match = pattern.exec(subject)
      if (match === null) continue
      // An indented declaration is indexed only when it is exported: a nested
      // class or binding inside a function body is not a repository symbol.
      if (exported || raw === trimmed) declarations.push({ name: match[1] as string, kind, line: index + 1 })
      break
    }
    let specifier: string | undefined
    if (trimmed.startsWith(EXPORT_PREFIX)) {
      specifier = REEXPORT_FROM.exec(trimmed)?.[1]
    } else {
      specifier = IMPORT_FROM.exec(trimmed)?.[1] ?? IMPORT_BARE.exec(trimmed)?.[1] ?? DYNAMIC_SPECIFIER.exec(trimmed)?.[1]
    }
    if (specifier !== undefined && !seenSpecifiers.has(specifier)) {
      seenSpecifiers.add(specifier)
      specifiers.push(specifier)
    }
  }
  return { declarations, specifiers }
}

/**
 * The identifiers each declaration's header block names, and the ones it calls.
 * A declaration's block runs from its own line to the line before the next
 * declaration in the same file, so a class contributes its member signatures and
 * bodies. `calls` is a subset of `identifiers`: the names the block writes as a
 * call or construction. Both are name facts, not resolved references — a
 * keyword written before a parenthesis is reported like any other name, and
 * scope decides nothing.
 * @param text - the file's complete text.
 * @param declarations - the file's declarations in line order.
 * @returns one reference list per declaration, in input order.
 */
export function headerReferences(
  text: string,
  declarations: readonly RepoDeclaration[],
): RepoHeaderReferences[] {
  const lines = text.split('\n')
  return declarations.map((declaration, index) => {
    const end = declarations[index + 1]?.line ?? lines.length + 1
    const identifiers = new Set<string>()
    const calls = new Set<string>()
    for (let line = declaration.line; line < end; line += 1) {
      const source = lines[line - 1] as string
      for (const match of source.matchAll(IDENTIFIER)) identifiers.add(match[0])
      for (const match of source.matchAll(CALL)) calls.add(match[1] as string)
    }
    return { identifiers: [...identifiers], calls: [...calls] }
  })
}

/**
 * Join one POSIX-style path with a relative specifier and collapse `.`/`..`.
 * @param fromPath - repository-relative path of the importing file.
 * @param specifier - the specifier as written in the source.
 * @returns the repository-relative candidate path, or undefined when the specifier is not relative.
 */
export function resolveRelative(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  const segments = fromPath.split('/')
  segments.pop()
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

/** Extensions a relative specifier may omit, plus the `index.*` file a directory specifier means. */
const RESOLUTION_SUFFIXES: readonly string[] = [
  '',
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.mts', '/index.cts', '/index.js', '/index.jsx',
]

/** A specifier whose `js` family extension names a TypeScript source it was compiled from. */
const EMITTED_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/

/**
 * Resolve one module specifier against the indexed paths.
 * @param fromPath - repository-relative path of the importing file.
 * @param specifier - the specifier as written in the source.
 * @param indexed - every indexed path.
 * @returns the indexed path the specifier names, or undefined when it names no indexed file.
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  indexed: ReadonlySet<string>,
): string | undefined {
  const base = resolveRelative(fromPath, specifier)
  if (base === undefined) return undefined
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`
    if (indexed.has(candidate)) return candidate
  }
  const emitted = EMITTED_EXTENSION.exec(base)
  if (emitted === null) return undefined
  for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
    const candidate = `${base.slice(0, -emitted[0].length)}${extension}`
    if (indexed.has(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve one bare specifier to the workspace package it names.
 * @param specifier - the specifier as written in the source.
 * @param names - every package name the indexed manifests declare.
 * @returns the shortest leading package name that matches, so a subpath specifier resolves to its package, or undefined.
 */
export function workspacePackageOf(specifier: string, names: ReadonlySet<string>): string | undefined {
  if (names.has(specifier)) return specifier
  for (let at = specifier.lastIndexOf('/'); at > 0; at = specifier.lastIndexOf('/', at - 1)) {
    const candidate = specifier.slice(0, at)
    if (names.has(candidate)) return candidate
  }
  return undefined
}

/** One configuration declaration a file makes. */
export interface RepoConfigDeclaration {
  /** The declared binding name. */
  readonly binding: string
  /** 1-based line of the declaration. */
  readonly line: number
  /** The fields the declaration lists, in first-occurrence order. */
  readonly fields: readonly RepoConfigField[]
}

/** A top-level `const` or `interface` declaration, whose binding must name configuration to count. */
const CONFIG_DECLARATION = /^(?:export\s+)?(?:const|interface)\s+([A-Za-z_$][\w$]*)\b/

/** One field key or interface member at a declaration's first level. */
const CONFIG_FIELD = /([A-Za-z_$][\w$]*)\??\s*[:(]/y

/** The character that may precede a field key: whitespace, a list comma, or the opening brace. */
const FIELD_BOUNDARY = /[\s,{]/

/** One read of a configuration field, through `.` or a bracketed literal key. */
const CONFIG_READ = /\bconfig\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\])/g

/**
 * The configuration declarations one file makes, and the fields each lists. A
 * declaration is a top-level `const` or `interface` whose binding name ends in
 * `Config`; its fields are the keys or members at the first level of the block
 * that declaration opens, so a field whose own value opens a nested block
 * contributes its own name and not the inner names. A brace inside a string or a
 * comment and a computed key are not recognized.
 * @param text - the file's complete text.
 * @returns the declarations in line order.
 */
export function extractConfig(text: string): readonly RepoConfigDeclaration[] {
  const lines = text.split('\n')
  const declarations: RepoConfigDeclaration[] = []
  for (let line = 0; line < lines.length; line += 1) {
    const trimmed = (lines[line] as string).trim()
    const match = CONFIG_DECLARATION.exec(trimmed)
    if (match === null || !(match[1] as string).endsWith('Config')) continue
    // An indented declaration counts only when it is exported, the same rule
    // the symbol extraction applies: a binding inside a function body is not a
    // module's configuration.
    if ((lines[line] as string) !== trimmed && !trimmed.startsWith('export ')) continue
    const derivedFrom: RepoConfigFieldSource = /^(?:export\s+)?interface\b/.test(trimmed) ? 'interface' : 'schema'
    const fields: RepoConfigField[] = []
    const seen = new Set<string>()
    const block = lines.slice(line).join('\n')
    let depth = 0
    let opened = false
    for (let at = 0; at < block.length; at += 1) {
      const character = block[at] as string
      if (character === '{') {
        depth += 1
        opened = true
        continue
      }
      if (character === '}') {
        depth -= 1
        if (opened && depth <= 0) break
        continue
      }
      if (!opened || depth !== 1) continue
      if (at > 0 && !FIELD_BOUNDARY.test(block[at - 1] as string)) continue
      CONFIG_FIELD.lastIndex = at
      const field = CONFIG_FIELD.exec(block)
      if (field === null) continue
      const name = field[1] as string
      at = CONFIG_FIELD.lastIndex - 1
      if (seen.has(name)) continue
      seen.add(name)
      fields.push({ name, derivedFrom })
    }
    declarations.push({ binding: match[1] as string, line: line + 1, fields })
  }
  return declarations
}

/**
 * The configuration fields one file reads through `config.<name>` or
 * `config['<name>']`. The read is lexical: a property of any object named
 * `config` counts, and the declaring declaration is not checked.
 * @param text - the file's complete text.
 * @returns the distinct field names in first-occurrence order.
 */
export function configReadFields(text: string): readonly string[] {
  const fields: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(CONFIG_READ)) {
    const field = (match[1] ?? match[2]) as string
    if (seen.has(field)) continue
    seen.add(field)
    fields.push(field)
  }
  return fields
}

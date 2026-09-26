/** Declaration-line extraction and module-specifier resolution over literal source text. */
import { describe, expect, it } from 'vitest'
import {
  configReadFields,
  extractConfig,
  extractFile,
  headerReferences,
  resolveRelative,
  resolveSpecifier,
  workspacePackageOf,
} from '../src/extract.ts'

const SOURCE = [
  "import { AuthService } from './auth-service'",
  "import type { Session } from '@deepseek-ai/dsh-session'",
  "import './side-effect'",
  "export { authMapper } from './auth-mapper.js'",
  "export type { AuthPort as Port } from './auth-port'",
  "const legacy = require('./legacy.cjs')",
  '// export class Commented {}',
  '/**',
  ' * export class Documented {}',
  ' */',
  'export class AuthController {',
  '  constructor(private readonly service: AuthService) {}',
  '}',
  'interface Listener {}',
  'export interface AuthPort {}',
  'type Maybe = string',
  'export type Alias = Maybe',
  'enum Mode { A }',
  'export const enum Flags { B }',
  'function localHelper() {}',
  'export async function load() {}',
  'export function* walk() {}',
  'export default function create() {}',
  'export declare class Ambient {}',
  'export const VALUE = 1',
  'export let counter = 0',
  'export default class DefaultService {}',
  '  const nested = 1',
  '  export class Nested {}',
  '  class Private {}',
].join('\n')

describe('extractFile', () => {
  it('reports exported and top-level declarations in line order', () => {
    expect(extractFile(SOURCE).declarations).toEqual([
      { name: 'AuthController', kind: 'class', line: 11 },
      { name: 'Listener', kind: 'interface', line: 14 },
      { name: 'AuthPort', kind: 'interface', line: 15 },
      { name: 'Maybe', kind: 'type', line: 16 },
      { name: 'Alias', kind: 'type', line: 17 },
      { name: 'Mode', kind: 'enum', line: 18 },
      { name: 'Flags', kind: 'enum', line: 19 },
      { name: 'localHelper', kind: 'function', line: 20 },
      { name: 'load', kind: 'function', line: 21 },
      { name: 'walk', kind: 'function', line: 22 },
      { name: 'create', kind: 'function', line: 23 },
      { name: 'Ambient', kind: 'class', line: 24 },
      { name: 'VALUE', kind: 'const', line: 25 },
      { name: 'counter', kind: 'const', line: 26 },
      { name: 'DefaultService', kind: 'class', line: 27 },
      { name: 'Nested', kind: 'class', line: 29 },
    ])
  })

  it('reports distinct module specifiers in first-occurrence order', () => {
    expect(extractFile(SOURCE).specifiers).toEqual([
      './auth-service',
      '@deepseek-ai/dsh-session',
      './side-effect',
      './auth-mapper.js',
      './auth-port',
      './legacy.cjs',
    ])
  })

  it('ignores blank lines, comments, and dynamic specifiers it already saw', () => {
    const extraction = extractFile([
      '',
      '   ',
      '/* import a from "./a" */',
      'import a from "./a"',
      'const b = await import("./b")',
      'import c from "./a"',
    ].join('\n'))
    expect(extraction.declarations).toEqual([])
    expect(extraction.specifiers).toEqual(['./a', './b'])
  })
})

describe('headerReferences', () => {
  it('collects the identifiers of each declaration block up to the next declaration', () => {
    const text = ['export class A {', '  field: B', '}', 'export function b(C) {}'].join('\n')
    const declarations = extractFile(text).declarations
    expect(headerReferences(text, declarations)).toEqual([
      { identifiers: ['export', 'class', 'A', 'field', 'B'], calls: [] },
      { identifiers: ['export', 'function', 'b', 'C'], calls: ['b'] },
    ])
  })

  it('separates a called name from a named type', () => {
    const text = [
      'export class Wallet {',
      '  constructor(readonly ledger: Ledger) {}',
      '  settle(): Report {',
      '    return this.ledger.close(Draft.of(1))',
      '  }',
      '}',
    ].join('\n')
    const [references] = headerReferences(text, extractFile(text).declarations)
    expect(references?.calls).toEqual(['constructor', 'settle', 'close', 'of'])
    expect(references?.calls).not.toContain('Ledger')
    expect(references?.calls).not.toContain('Report')
    expect(references?.identifiers).toContain('Ledger')
  })
})

describe('extractConfig', () => {
  it('reads the first-level fields of a schema object and an interface body', () => {
    const text = [
      'export interface Config {',
      '  mode?: string',
      '  budget: { maxSteps: number }',
      '}',
      'export const Config: z<Config> = z.object({',
      '  mode: z.string().default("shadow"),',
      '  budget: z.object({',
      '    maxSteps: z.number(),',
      '  }),',
      '  retries: z.number(),',
      '})',
    ].join('\n')
    expect(extractConfig(text)).toEqual([
      {
        binding: 'Config',
        line: 1,
        fields: [{ name: 'mode', derivedFrom: 'interface' }, { name: 'budget', derivedFrom: 'interface' }],
      },
      {
        binding: 'Config',
        line: 5,
        fields: [
          { name: 'mode', derivedFrom: 'schema' },
          { name: 'budget', derivedFrom: 'schema' },
          { name: 'retries', derivedFrom: 'schema' },
        ],
      },
    ])
  })

  it('ignores a binding whose name does not end in Config', () => {
    expect(extractConfig('export const Settings = z.object({ mode: z.string() })')).toEqual([])
  })

  it('reads the fields of a schema object written on one line, without its nested keys', () => {
    const text = 'export const Config = z.object({ mode: z.string(), budget: z.object({ maxSteps: z.number() }) })'
    expect(extractConfig(text)).toEqual([
      {
        binding: 'Config',
        line: 1,
        fields: [
          { name: 'mode', derivedFrom: 'schema' },
          { name: 'budget', derivedFrom: 'schema' },
        ],
      },
    ])
  })

  it('ignores a nested declaration binding inside a function body', () => {
    expect(extractConfig(['export function apply() {', '  const Config = z.object({ mode: z.string() })', '}'].join('\n')))
      .toEqual([])
  })
})

describe('configReadFields', () => {
  it('reads a property and a bracketed key of an object named config, once each', () => {
    const text = [
      'const cap = config.maxInlineTokens',
      'const mode = this.config["mode"]',
      'const again = config.maxInlineTokens',
      'const other = configuration.mode',
    ].join('\n')
    expect(configReadFields(text)).toEqual(['maxInlineTokens', 'mode'])
  })
})

describe('workspacePackageOf', () => {
  const names = new Set(['@deepseek-ai/dsh-repo-index', '@deepseek-ai/cordis', 'zod'])

  it('resolves a package name and a subpath to its package', () => {
    expect(workspacePackageOf('zod', names)).toBe('zod')
    expect(workspacePackageOf('@deepseek-ai/dsh-repo-index/types.ts', names)).toBe('@deepseek-ai/dsh-repo-index')
    expect(workspacePackageOf('@deepseek-ai/dsh-repo-index/src/walk.ts', names)).toBe('@deepseek-ai/dsh-repo-index')
  })

  it('reports nothing for a name no manifest declares', () => {
    expect(workspacePackageOf('vitest', names)).toBeUndefined()
    expect(workspacePackageOf('node:crypto', names)).toBeUndefined()
    expect(workspacePackageOf('./relative', names)).toBeUndefined()
  })
})

describe('resolveRelative', () => {
  it('resolves and collapses relative segments against the importing file', () => {
    expect(resolveRelative('src/auth/controller.ts', '../service/auth-service')).toBe('src/service/auth-service')
    expect(resolveRelative('src/index.ts', './util//helpers.ts')).toBe('src/util/helpers.ts')
    expect(resolveRelative('src/index.ts', './a/../b')).toBe('src/b')
  })

  it('rejects a specifier that is not relative', () => {
    expect(resolveRelative('src/index.ts', '@deepseek-ai/dsh-fs')).toBeUndefined()
    expect(resolveRelative('src/index.ts', '/absolute')).toBeUndefined()
  })
})

describe('resolveSpecifier', () => {
  const indexed = new Set([
    'src/auth/service.ts',
    'src/auth/mapper.tsx',
    'src/util/index.ts',
    'src/legacy/old.ts',
  ])

  it('resolves an explicit, an extended, an index, and an emitted path', () => {
    expect(resolveSpecifier('src/auth/controller.ts', './service.ts', indexed)).toBe('src/auth/service.ts')
    expect(resolveSpecifier('src/auth/controller.ts', './mapper', indexed)).toBe('src/auth/mapper.tsx')
    expect(resolveSpecifier('src/auth/controller.ts', '../util', indexed)).toBe('src/util/index.ts')
    expect(resolveSpecifier('src/auth/controller.ts', '../legacy/old.js', indexed)).toBe('src/legacy/old.ts')
  })

  it('returns undefined for a bare or unmatched specifier', () => {
    expect(resolveSpecifier('src/auth/controller.ts', '@deepseek-ai/dsh-fs', indexed)).toBeUndefined()
    expect(resolveSpecifier('src/auth/controller.ts', './missing', indexed)).toBeUndefined()
    expect(resolveSpecifier('src/auth/controller.ts', './missing.js', indexed)).toBeUndefined()
  })
})

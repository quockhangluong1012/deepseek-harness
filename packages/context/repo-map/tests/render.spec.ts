/** The map text: header, node and reference lines, and the byte bound. */
import { describe, expect, it } from 'vitest'
import { renderRepositoryMap } from '../src/render.ts'
import type { RepoMapNode } from '../src/types.ts'

const NODES: readonly RepoMapNode[] = [
  {
    symbol: { id: 'src/auth/auth-controller.ts#AuthController', name: 'AuthController', kind: 'class', path: 'src/auth/auth-controller.ts', line: 12 },
    score: 16,
    related: [
      { id: 'src/auth/auth-service.ts#AuthService', name: 'AuthService', kind: 'class', path: 'src/auth/auth-service.ts', line: 3 },
    ],
  },
  {
    symbol: { id: 'src/ui/table.ts#renderTable', name: 'renderTable', kind: 'function', path: 'src/ui/table.ts', line: 5 },
    score: 2,
    related: [],
  },
]

const COUNTS = { symbols: 3, indexed: 2 }

describe('renderRepositoryMap', () => {
  it('renders the header, one line per node, and its references indented', () => {
    expect(renderRepositoryMap(NODES, COUNTS, 4096)).toBe([
      'Repository map (ranked by relevance to the current task; 3 indexed symbols from 2 files, most relevant first):',
      '- AuthController [class] src/auth/auth-controller.ts:12',
      '  -> AuthService [class] src/auth/auth-service.ts:3',
      '- renderTable [function] src/ui/table.ts:5',
    ].join('\n'))
  })

  it('keeps whole lines only, so a bounded map is a prefix of the complete one', () => {
    const complete = renderRepositoryMap(NODES, COUNTS, 4096)
    const [header, firstNode] = complete.split('\n') as [string, string]
    const headerBytes = Buffer.byteLength(header, 'utf8')
    const firstNodeBytes = headerBytes + 1 + Buffer.byteLength(firstNode, 'utf8')
    expect(renderRepositoryMap(NODES, COUNTS, firstNodeBytes)).toBe(`${header}\n${firstNode}`)
    expect(renderRepositoryMap(NODES, COUNTS, headerBytes)).toBe(header)
    expect(renderRepositoryMap(NODES, COUNTS, headerBytes - 1)).toBe('')
  })

  it('counts the bound in UTF-8 bytes', () => {
    const unicode: readonly RepoMapNode[] = [{
      symbol: { id: 'src/ärger.ts#Ärger', name: 'Ärger', kind: 'class', path: 'src/ärger.ts', line: 1 },
      score: 3,
      related: [],
    }]
    const text = renderRepositoryMap(unicode, { symbols: 1, indexed: 1 }, 4096)
    const [header, nameLine] = text.split('\n') as [string, string]
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length)
    const exact = Buffer.byteLength(header, 'utf8') + 1 + Buffer.byteLength(nameLine, 'utf8')
    expect(renderRepositoryMap(unicode, { symbols: 1, indexed: 1 }, exact)).toBe(text)
    expect(renderRepositoryMap(unicode, { symbols: 1, indexed: 1 }, exact - 1)).toBe(header)
  })

  it('renders nothing when the header alone does not fit', () => {
    const header = 'Repository map (ranked by relevance to the current task; 0 indexed symbols from 0 files, most relevant first):'
    expect(renderRepositoryMap([], { symbols: 0, indexed: 0 }, Buffer.byteLength(header, 'utf8') - 1)).toBe('')
    expect(renderRepositoryMap([], { symbols: 0, indexed: 0 }, Buffer.byteLength(header, 'utf8'))).toBe(header)
  })
})

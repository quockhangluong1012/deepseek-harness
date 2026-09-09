/**
 * Acceptance-path coverage for fragment validation in `verify-md-links`: a
 * `#fragment` onto a Markdown target — same-file anchors included — must name
 * a real heading slug or explicit `<a id>`, while non-Markdown fragments and
 * external targets stay out of scope.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { anchorCache, changedMarkdownSources, documentAnchors, findViolations, githubSlug } from './verify-md-links.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function layout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'md-links-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

function violationsIn(root: string, rel: string): { url: string; reason: string }[] {
  return findViolations(join(root, rel), anchorCache(), root).map(({ url, reason }) => ({ url, reason }))
}

describe('documentAnchors', () => {
  it('slugs rendered heading text, suffixes repeats, and reads explicit <a id> anchors', () => {
    const anchors = documentAnchors([
      '# My Doc',
      '## Live `events` — mode!',
      '## Repeat',
      '## Repeat',
      '<a id="hand-anchor"></a>',
      '',
    ].join('\n'))
    expect(anchors).toEqual(new Set(['my-doc', 'live-events--mode', 'repeat', 'repeat-1', 'hand-anchor']))
    expect(githubSlug('Security and authority are non-goals')).toBe('security-and-authority-are-non-goals')
  })

  it('keeps underscores the way GitHub does', () => {
    expect(githubSlug('Showcase: web_fetch')).toBe('showcase-web_fetch')
    expect(documentAnchors('## Showcase: web_fetch\n')).toEqual(new Set(['showcase-web_fetch']))
  })

  it('slugs a heading containing a link from its rendered text', () => {
    expect(documentAnchors('## [Install](setup.md)\n')).toEqual(new Set(['install']))
  })

  it('bumps repeat suffixes past occupied slugs, matching GitHub', () => {
    const anchors = documentAnchors(['## Repeat', '## Repeat-1', '## Repeat', ''].join('\n'))
    expect(anchors).toEqual(new Set(['repeat', 'repeat-1', 'repeat-2']))
  })

  it('ignores <a id> inside code fences, inline code, and HTML comments', () => {
    const anchors = documentAnchors([
      '# Doc',
      '```md',
      '<a id="fenced"></a>',
      '```',
      'Inline `<a id="inline"></a>` sample.',
      '<!-- <a id="commented"></a> -->',
      '<a id="real"></a>',
      '',
    ].join('\n'))
    expect(anchors).toEqual(new Set(['doc', 'real']))
  })
})

describe('findViolations fragments', () => {
  it('accepts resolving same-file and cross-file fragments, non-md fragments, and externals', () => {
    const root = layout({
      'a.md': '# A\n\n## Deferred work\n\n[self](#deferred-work) [b](b.md#part-two) [code](x.ts#L10) [ext](https://x.example/#frag)\n',
      'b.md': '# B\n\n## Part two\n',
      'x.ts': 'export {}\n',
    })
    expect(violationsIn(root, 'a.md')).toEqual([])
  })

  it('rejects a same-file fragment that names no heading or <a id>', () => {
    const root = layout({ 'a.md': '# A\n\n[gone](#deferred-work)\n' })
    expect(violationsIn(root, 'a.md')).toEqual([{ url: '#deferred-work', reason: 'anchor' }])
  })

  it('rejects a case-variant fragment: element ids are case-sensitive', () => {
    const root = layout({ 'a.md': '# A\n\n## Default Loop\n\n[case](#Default-Loop)\n' })
    expect(violationsIn(root, 'a.md')).toEqual([{ url: '#Default-Loop', reason: 'anchor' }])
  })

  it('rejects a cross-file fragment missing from the target document', () => {
    const root = layout({
      'a.md': '# A\n\n[stale](b.md#old-heading)\n',
      'b.md': '# B\n\n## New heading\n',
    })
    expect(violationsIn(root, 'a.md')).toEqual([{ url: 'b.md#old-heading', reason: 'anchor' }])
  })

  it('still rejects a missing target file, reported as target not anchor', () => {
    const root = layout({ 'a.md': '# A\n\n[ghost](missing.md#anything)\n' })
    expect(violationsIn(root, 'a.md')).toEqual([{ url: 'missing.md#anything', reason: 'target' }])
  })
})

describe('changedMarkdownSources (--since)', () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  }

  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'md-links-since-'))
    roots.push(root)
    git(root, ['init', '--initial-branch=master'])
    git(root, ['config', 'user.email', 'md-links@example.com'])
    git(root, ['config', 'user.name', 'Md Links Tests'])
    git(root, ['config', 'commit.gpgsign', 'false'])
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), content)
      git(root, ['add', '--', rel])
    }
    git(root, ['commit', '-m', 'initial'])
    return root
  }

  function rels(root: string): string[] {
    return changedMarkdownSources(root, 'HEAD').map(file => relative(root, file.abs).split('\\').join('/'))
  }

  it('selects committed, staged, unstaged, and untracked Markdown changes', () => {
    const root = repo({
      'docs/a.md': '# A\n',
      'docs/b.md': '# B\n',
      'docs/del.md': '# Gone\n',
      'x.ts': 'export {}\n',
    })
    writeFileSync(join(root, 'docs/a.md'), '# A\n\n[edit](b.md)\n')
    git(root, ['add', '--', 'docs/a.md'])
    git(root, ['commit', '-m', 'change a'])
    writeFileSync(join(root, 'docs/b.md'), '# B\n\n[staged](a.md)\n')
    git(root, ['add', '--', 'docs/b.md'])
    writeFileSync(join(root, 'docs/a.md'), '# A\n\n[edit](b.md)\n\n[unstaged](b.md)\n')
    writeFileSync(join(root, 'docs/new.md'), '# New\n')
    writeFileSync(join(root, 'x.ts'), 'export const v = 1\n')
    git(root, ['rm', '--quiet', 'docs/del.md'])

    expect(rels(root)).toEqual(['docs/a.md', 'docs/b.md', 'docs/new.md'])
  })

  it('agrees with the full scan on a seeded broken link in the changed file', () => {
    const root = repo({
      'docs/a.md': '# A\n\n[ok](b.md#part-two)\n',
      'docs/b.md': '# B\n\n## Part two\n',
    })
    writeFileSync(join(root, 'docs/a.md'), '# A\n\n[ok](b.md#part-two)\n\n[broken](b.md#old-heading)\n')

    const anchorsOf = anchorCache()
    const incremental = changedMarkdownSources(root, 'HEAD')
      .flatMap(file => findViolations(file.abs, anchorsOf, root))
    expect(incremental.map(({ url, reason }) => ({ url, reason }))).toEqual([
      { url: 'b.md#old-heading', reason: 'anchor' },
    ])
    // The incremental sources are a subset of the full scan, checked with the
    // same violation function and the same full-corpus anchor resolution.
    expect(incremental.map(v => v.file.replaceAll('\\', '/'))).toEqual(['docs/a.md'])
  })

  it('resolves changed-file links against anchors in unchanged files', () => {
    const root = repo({ 'docs/b.md': '# B\n\n## Part two\n' })
    writeFileSync(join(root, 'docs/a.md'), '# A\n\n[ok](b.md#part-two)\n')
    git(root, ['add', '--', 'docs/a.md'])

    const anchorsOf = anchorCache()
    expect(changedMarkdownSources(root, 'HEAD').flatMap(file => findViolations(file.abs, anchorsOf, root))).toEqual([])
  })

  it('fails loud on a ref git cannot resolve', () => {
    const root = repo({ 'docs/a.md': '# A\n' })

    expect(() => changedMarkdownSources(root, 'no-such-ref')).toThrow()
  })
})

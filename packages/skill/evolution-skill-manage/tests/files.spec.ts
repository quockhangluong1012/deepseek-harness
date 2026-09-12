import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildSkillFile,
  checkSkillName,
  expandCreateDir,
  replaceUniqueSubstring,
  resolveSkillDir,
  resolveSkillPath,
  splitFrontmatter,
  validateSkillHead,
} from '../src/files.ts'

describe('evolution skill files', () => {
  it('validates skill names', () => {
    expect(() => { checkSkillName('code-review') }).not.toThrow()
    expect(() => { checkSkillName('Bad Name') }).toThrow('invalid skill name')
    expect(() => { checkSkillName('') }).toThrow('invalid skill name')
  })

  it('expands creation directories', () => {
    expect(expandCreateDir(undefined).endsWith('skills')).toBe(true)
    expect(expandCreateDir('~/skills')).toBe(join(homedir(), 'skills'))
    process.env.EVOLUTION_SKILL_MANAGE_TEST_DIR = '/tmp/evolution-skills'
    expect(expandCreateDir('${EVOLUTION_SKILL_MANAGE_TEST_DIR}/x')).toBe(resolve('/tmp/evolution-skills', 'x'))
    expect(expandCreateDir('$EVOLUTION_SKILL_MANAGE_TEST_DIR')).toBe(resolve('/tmp/evolution-skills'))
    delete process.env.EVOLUTION_SKILL_MANAGE_TEST_DIR
    expect(() => { expandCreateDir('${EVOLUTION_SKILL_MANAGE_TEST_DIR}') }).toThrow('missing environment variable')
  })

  it('resolves catalog skills to writable locations', async () => {
    const list = async () => [
      { name: 'local', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'p', path: '/tmp/skills/local/SKILL.md' },
      { name: 'boxed', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'p', path: '/tmp/skills/boxed/SKILL.md' },
      { name: 'shared', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, source: 'hub-nightly', provider: 'p', path: '/tmp/skills/shared/SKILL.md' },
      { name: 'virtual', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'p' },
    ]
    await expect(resolveSkillDir(list, 'missing', (_dir, file) => file)).rejects.toThrow('unknown or no longer available')
    await expect(resolveSkillDir(list, 'boxed', (_dir, file) => file)).rejects.toThrow('bundled-managed')
    await expect(resolveSkillDir(list, 'shared', (_dir, file) => file)).rejects.toThrow('hub-nightly-managed')
    await expect(resolveSkillDir(list, 'virtual', (_dir, file) => file)).rejects.toThrow('no local directory')
  })

  it('resolves relative paths inside the skill', () => {
    const dir = join('/tmp', 'skills', 'local')
    expect(resolveSkillPath(dir, join('references', 'chapter.md'))).toBe(resolve(dir, 'references', 'chapter.md'))
    expect(() => { resolveSkillPath(dir, '') }).toThrow('must be non-empty')
    expect(() => { resolveSkillPath(dir, '/abs.md') }).toThrow('must be relative')
    expect(() => { resolveSkillPath(dir, join('..', 'escape.md')) }).toThrow('escapes the skill directory')
    expect(() => { resolveSkillPath(dir, 'SKILL.md') }).toThrow('reserved for the patch and edit operations')
  })

  it('splits and validates frontmatter', () => {
    expect(splitFrontmatter('no fences')).toBeUndefined()
    expect(splitFrontmatter('---\nname: x\nno closing')).toBeUndefined()
    expect(splitFrontmatter('---\nname: x\ndescription: d\n---\nbody\n')).toEqual({
      head: 'name: x\ndescription: d',
      body: 'body\n',
    })
    expect(() => { validateSkillHead('name: x\ndescription: d', 'x') }).not.toThrow()
    expect(() => { validateSkillHead('[unclosed', 'x') }).toThrow('invalid frontmatter')
    expect(() => { validateSkillHead('[]', 'x') }).toThrow('must keep name')
    expect(() => { validateSkillHead('123', 'x') }).toThrow('must keep name')
    expect(() => { validateSkillHead('name: other\ndescription: d', 'x') }).toThrow('must keep name')
    expect(() => { validateSkillHead('name: x', 'x') }).toThrow('must keep a description')
  })

  it('builds complete skill files', () => {
    expect(buildSkillFile('x', 'd', 'body\n')).toBe('---\nname: x\ndescription: d\n---\nbody\n')
  })

  it('replaces unique substrings', () => {
    expect(replaceUniqueSubstring('first second', 'second', 'third', 'skill "x" patch')).toBe('first third')
    expect(() => { replaceUniqueSubstring('text', '', 'y', 'skill "x" patch') }).toThrow('must be non-empty')
    expect(() => { replaceUniqueSubstring('text', 'absent', 'y', 'skill "x" patch') }).toThrow('no match')
    expect(() => { replaceUniqueSubstring('a one a', 'a', 'b', 'skill "x" patch') }).toThrow('matches 2 times')
  })
})

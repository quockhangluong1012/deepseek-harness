import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as skillManage from '../src/index.ts'

interface FakeSkill {
  name: string
  source: string
  path?: string
  composableWith?: readonly string[]
}

function summary(name: string, source: string, path?: string, composableWith?: readonly string[]) {
  return {
    name,
    description: `${name} skill`,
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider: 'filesystem',
    ...path === undefined ? {} : { path },
    ...composableWith === undefined ? {} : { composableWith },
  }
}

async function harness(options: { telemetry?: boolean; createDir?: string } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'evm-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const skills: FakeSkill[] = []
  ctx.provide('skills', {
    list: async () => skills.map(skill => summary(skill.name, skill.source, skill.path, skill.composableWith)),
  } as never)
  if (options.telemetry !== false) {
    const { default: EvolutionSkillTelemetry } = await import('@deepseek-ai/dsh-evolution-skill-telemetry')
    await ctx.plugin(EvolutionSkillTelemetry)
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(skillManage, { createDir: options.createDir ?? join(dir, 'skills') })
  return { ctx, fiber, dir, skills }
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

let callSeq = 0

async function manage(
  ctx: Context,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; value: unknown }> {
  callSeq += 1
  const outcome = await ctx.tools.execute({
    callId: ToolCallId(`manage-${callSeq}`),
    name: 'skill_manage',
    arguments: args,
    signal: new AbortController().signal,
  })
  const result = outcome as { isError: boolean; content: { type: string; text?: string }[]; value?: unknown }
  return { isError: result.isError, text: resultText(result), value: (result as { value?: unknown }).value }
}

async function skillFile(dir: string, name: string, body = 'body words'): Promise<string> {
  const skillDir = join(dir, name)
  await mkdir(skillDir, { recursive: true })
  const file = join(skillDir, 'SKILL.md')
  await writeFile(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`)
  return file
}

describe('evolution skill_manage', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('creates skills with valid frontmatter', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const created = await manage(h.ctx, {
        op: 'create',
        name: 'code-review',
        description: 'Reviews code: thoroughly',
        content: 'Check everything.\n',
      })
      expect(created.isError).toBe(false)
      expect(created.text).toContain('skill_manage create code-review')
      const file = join(h.dir, 'skills', 'code-review', 'SKILL.md')
      const text = await readFile(file, 'utf8')
      expect(text).toContain('name: code-review')
      expect(text).toContain('Check everything.')
      // The frontmatter stays parseable after a tricky description.
      const head = text.split('---\n')[1] as string
      expect((parseYaml(head) as { description: string }).description).toBe('Reviews code: thoroughly')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects duplicate creates and malformed arguments', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      expect((await manage(h.ctx, { op: 'create', name: 'dup', description: 'd', content: 'b' })).isError).toBe(false)
      const again = await manage(h.ctx, { op: 'create', name: 'dup', description: 'd', content: 'b' })
      expect(again.isError).toBe(true)
      expect(again.text).toContain('already exists')
      expect((await manage(h.ctx, { op: 'create', name: 'Bad Name', description: 'd', content: 'b' })).text)
        .toContain('invalid skill name')
      expect((await manage(h.ctx, { op: 'create', name: 'nodesc', content: 'b' })).text).toContain('`description`')
      expect((await manage(h.ctx, { op: 'create', name: 'nobody', description: 'd' })).text).toContain('`content`')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records model authorship and the revision chain of every body write', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      await manage(h.ctx, { op: 'create', name: 'writer', description: 'd', content: 'first body\n' })
      const file = join(h.dir, 'skills', 'writer', 'SKILL.md')
      const created = h.ctx.evolutionSkillTelemetry.read('writer')
      expect(created).toMatchObject({ createdBy: 'agent', revision: 1, parentRevisionSha: null, trust: 'provisional' })
      expect(created?.contentSha).toBe(createHash('sha256').update(await readFile(file, 'utf8')).digest('hex'))
      h.skills.push({ name: 'writer', source: 'user-dsh', path: file })
      await manage(h.ctx, { op: 'patch', name: 'writer', old_text: 'first body', new_text: 'second body' })
      const patched = h.ctx.evolutionSkillTelemetry.read('writer')
      expect(patched).toMatchObject({ revision: 2, parentRevisionSha: created?.contentSha })
      expect(patched?.contentSha).toBe(createHash('sha256').update(await readFile(file, 'utf8')).digest('hex'))
      await manage(h.ctx, { op: 'edit', name: 'writer', content: 'third body\n' })
      expect(h.ctx.evolutionSkillTelemetry.read('writer'))
        .toMatchObject({ revision: 3, parentRevisionSha: patched?.contentSha })
      // A supporting file is not a revision of the body.
      await manage(h.ctx, { op: 'write_file', name: 'writer', path: 'notes.md', content: 'notes\n' })
      expect(h.ctx.evolutionSkillTelemetry.read('writer')).toMatchObject({ revision: 3, patchCount: 3 })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('patches unique substrings and counts telemetry', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'polish', 'first\nsecond\n')
      h.skills.push({ name: 'polish', source: 'user-dsh', path: file })
      const patched = await manage(h.ctx, { op: 'patch', name: 'polish', old_text: 'second', new_text: 'third' })
      expect(patched.isError).toBe(false)
      expect(patched.text).toContain('skill_manage patch polish')
      expect(h.ctx.evolutionSkillTelemetry.read('polish')).toMatchObject({ patchCount: 1 })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects patches that are unknown, ambiguous, empty, bundled, or unwritable', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'polish', 'one two one\n')
      h.skills.push({ name: 'polish', source: 'user-dsh', path: file })
      const boxed = await skillFile(h.dir, 'boxed')
      h.skills.push({ name: 'boxed', source: 'bundled', path: boxed })
      h.skills.push({ name: 'gone', source: 'user-dsh', path: join(h.dir, 'deleted', 'SKILL.md') })

      expect((await manage(h.ctx, { op: 'patch', name: 'missing', old_text: 'a', new_text: 'b' })).text)
        .toContain('unknown or no longer available')
      expect((await manage(h.ctx, { op: 'patch', name: 'polish', old_text: 'absent', new_text: 'b' })).text)
        .toContain('no match')
      expect((await manage(h.ctx, { op: 'patch', name: 'polish', old_text: 'one', new_text: 'b' })).text)
        .toContain('matches 2 times')
      expect((await manage(h.ctx, { op: 'patch', name: 'polish', old_text: '', new_text: 'b' })).text)
        .toContain('must be non-empty')
      expect((await manage(h.ctx, { op: 'patch', name: 'boxed', old_text: 'body', new_text: 'b' })).text)
        .toContain('bundled-managed')
      expect((await manage(h.ctx, { op: 'patch', name: 'gone', old_text: 'a', new_text: 'b' })).text)
        .toContain('not writable')
      expect(h.ctx.evolutionSkillTelemetry.read('polish')?.patchCount ?? 0).toBe(0)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('edits whole bodies preserving frontmatter', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'rewrite', 'old body\n')
      h.skills.push({ name: 'rewrite', source: 'user-dsh', path: file })
      const edited = await manage(h.ctx, { op: 'edit', name: 'rewrite', content: 'new body\n' })
      expect(edited.isError).toBe(false)
      const text = await readFile(file, 'utf8')
      expect(text).toContain('name: rewrite')
      expect(text).toContain('new body')
      expect(text).not.toContain('old body')
      expect(h.ctx.evolutionSkillTelemetry.read('rewrite')).toMatchObject({ patchCount: 1 })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects edits with malformed or mismatched frontmatter', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const broken = join(h.dir, 'broken', 'SKILL.md')
      await mkdir(join(h.dir, 'broken'), { recursive: true })
      await writeFile(broken, 'no fences here\n')
      h.skills.push({ name: 'broken', source: 'user-dsh', path: broken })
      expect((await manage(h.ctx, { op: 'edit', name: 'broken', content: 'b' })).text).toContain('malformed frontmatter')

      const renamed = join(h.dir, 'renamed', 'SKILL.md')
      await mkdir(join(h.dir, 'renamed'), { recursive: true })
      await writeFile(renamed, '---\nname: other\ndescription: d\n---\nbody\n')
      h.skills.push({ name: 'renamed', source: 'user-dsh', path: renamed })
      expect((await manage(h.ctx, { op: 'edit', name: 'renamed', content: 'b' })).text).toContain('must keep name')

      const nodesc = join(h.dir, 'nodesc', 'SKILL.md')
      await mkdir(join(h.dir, 'nodesc'), { recursive: true })
      await writeFile(nodesc, '---\nname: nodesc\n---\nbody\n')
      h.skills.push({ name: 'nodesc', source: 'user-dsh', path: nodesc })
      expect((await manage(h.ctx, { op: 'edit', name: 'nodesc', content: 'b' })).text).toContain('must keep a description')
      expect((await manage(h.ctx, { op: 'edit', name: 'renamed' })).text).toContain('`content`')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('writes and removes supporting files inside the skill', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'docs')
      h.skills.push({ name: 'docs', source: 'user-dsh', path: file })
      const written = await manage(h.ctx, {
        op: 'write_file',
        name: 'docs',
        path: 'references/chapter.md',
        content: '# chapter\n',
      })
      expect(written.isError).toBe(false)
      expect(written.text).toContain('skill_manage write_file docs')
      const removed = await manage(h.ctx, { op: 'remove_file', name: 'docs', path: 'references/chapter.md' })
      expect(removed.isError).toBe(false)
      expect(h.ctx.evolutionSkillTelemetry.read('docs')).toMatchObject({ patchCount: 2 })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects file paths outside the skill', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'docs')
      h.skills.push({ name: 'docs', source: 'user-dsh', path: file })
      expect((await manage(h.ctx, { op: 'write_file', name: 'docs', path: '/abs.md', content: 'x' })).text)
        .toContain('must be relative')
      expect((await manage(h.ctx, { op: 'write_file', name: 'docs', path: '../escape.md', content: 'x' })).text)
        .toContain('escapes the skill directory')
      expect((await manage(h.ctx, { op: 'write_file', name: 'docs', path: 'SKILL.md', content: 'x' })).text)
        .toContain('reserved for the patch and edit operations')
      expect((await manage(h.ctx, { op: 'write_file', name: 'docs', path: '', content: 'x' })).text)
        .toContain('must be non-empty')
      expect((await manage(h.ctx, { op: 'remove_file', name: 'docs', path: 'SKILL.md' })).text)
        .toContain('reserved for the patch and edit operations')
      expect((await manage(h.ctx, { op: 'remove_file', name: 'docs', path: 'missing.md' })).text)
        .toContain('has no file')
      expect((await manage(h.ctx, { op: 'write_file', name: 'docs', content: 'x' })).text).toContain('`path`')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('deletes whole skills unless pinned, and keeps telemetry', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'temp')
      h.skills.push({ name: 'temp', source: 'user-dsh', path: file })
      await h.ctx.evolutionSkillTelemetry.setPinned('temp', true)
      expect((await manage(h.ctx, { op: 'delete', name: 'temp' })).text).toContain('pinned')
      // A pin withholds deletion only: patching the same skill still works.
      const patched = await manage(h.ctx, { op: 'patch', name: 'temp', old_text: 'body words', new_text: 'better words' })
      expect(patched.isError).toBe(false)
      expect(h.ctx.evolutionSkillTelemetry.read('temp')).toMatchObject({ pinned: true, patchCount: 1 })
      await h.ctx.evolutionSkillTelemetry.setPinned('temp', false)
      const deleted = await manage(h.ctx, { op: 'delete', name: 'temp' })
      expect(deleted.isError).toBe(false)
      expect(deleted.text).toContain('skill_manage delete temp')
      expect(h.ctx.evolutionSkillTelemetry.read('temp')).toMatchObject({ pinned: false })

      const boxed = await skillFile(h.dir, 'boxed')
      h.skills.push({ name: 'boxed', source: 'bundled', path: boxed })
      expect((await manage(h.ctx, { op: 'delete', name: 'boxed' })).text).toContain('bundled-managed')
      expect((await manage(h.ctx, { op: 'delete', name: 'missing' })).text).toContain('unknown or no longer available')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects missing patch and file arguments', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'docs')
      h.skills.push({ name: 'docs', source: 'user-dsh', path: file })
      expect((await manage(h.ctx, { op: 'patch', name: 'docs', new_text: 'b' })).text).toContain('`old_text`')
      expect((await manage(h.ctx, { op: 'patch', name: 'docs', old_text: 'body' })).text).toContain('`new_text`')
      expect((await manage(h.ctx, { op: 'write_file', name: 'docs', path: 'r.md' })).text).toContain('`content`')
      expect((await manage(h.ctx, { op: 'remove_file', name: 'docs' })).text).toContain('`path`')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('surfaces unexpected filesystem failures', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const conflictDir = join(h.dir, 'skills', 'conflict')
      await mkdir(join(conflictDir, 'SKILL.md'), { recursive: true })
      const conflicted = await manage(h.ctx, { op: 'create', name: 'conflict', description: 'd', content: 'b' })
      expect(conflicted.isError).toBe(true)
      expect(conflicted.text).toContain('already exists')

      const file = await skillFile(h.dir, 'docs')
      h.skills.push({ name: 'docs', source: 'user-dsh', path: file })
      await mkdir(join(h.dir, 'docs', 'refs'), { recursive: true })
      await writeFile(join(h.dir, 'docs', 'refs', 'note.md'), 'note\n')
      const blocked = await manage(h.ctx, { op: 'remove_file', name: 'docs', path: 'refs' })
      expect(blocked.isError).toBe(true)
      expect(blocked.text).not.toContain('has no file')
    } finally {
      await h.fiber.dispose()
    }
  })
  it('synthesizes a new skill from two primitives and records their lineage', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      h.skills.push({ name: 'alpha', source: 'user-dsh' })
      h.skills.push({ name: 'beta', source: 'user-dsh' })
      const derived = await manage(h.ctx, {
        op: 'derive',
        name: 'gamma',
        sources: ['beta', 'alpha'],
        content: '---\nname: gamma\ndescription: alpha meets beta\n---\nDo both things.\n',
      })
      expect(derived.isError).toBe(false)
      expect(derived.text).toContain('skill_manage derive gamma')
      const file = join(h.dir, 'skills', 'gamma', 'SKILL.md')
      const text = await readFile(file, 'utf8')
      const head = parseYaml(text.split('---\n')[1] as string) as Record<string, unknown>
      // The caller's head survives and the lineage names the sources as given.
      expect(head).toMatchObject({ name: 'gamma', description: 'alpha meets beta', derived_from: ['beta', 'alpha'] })
      expect(text).toContain('Do both things.')
      expect(h.ctx.evolutionSkillTelemetry.read('gamma'))
        .toMatchObject({ createdBy: 'agent', revision: 1, trust: 'provisional' })
      expect(h.ctx.evolutionSkillTelemetry.read('gamma')?.contentSha)
        .toBe(createHash('sha256').update(text).digest('hex'))
    } finally {
      await h.fiber.dispose()
    }
  })

  it('replaces a caller-supplied lineage with the sources actually composed', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      h.skills.push({ name: 'alpha', source: 'user-dsh' })
      h.skills.push({ name: 'beta', source: 'user-dsh' })
      await manage(h.ctx, {
        op: 'derive',
        name: 'gamma',
        sources: ['alpha', 'beta'],
        content: '---\nname: gamma\ndescription: d\nderived_from: [invented]\n---\nbody\n',
      })
      const head = parseYaml(
        (await readFile(join(h.dir, 'skills', 'gamma', 'SKILL.md'), 'utf8')).split('---\n')[1] as string,
      ) as Record<string, unknown>
      expect(head['derived_from']).toEqual(['alpha', 'beta'])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('refuses a derivation whose sources are missing, self-naming, duplicative, or incompatible', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      h.skills.push({ name: 'alpha', source: 'user-dsh', composableWith: ['beta'] })
      h.skills.push({ name: 'beta', source: 'user-dsh' })
      h.skills.push({ name: 'gamma', source: 'user-dsh' })
      const derive = (args: Record<string, unknown>) => manage(h.ctx, { op: 'derive', ...args })
      expect((await derive({ name: 'new', sources: ['alpha'], content: 'b' })).text)
        .toContain('at least two distinct `sources`')
      expect((await derive({ name: 'new', sources: ['alpha', 'alpha'], content: 'b' })).text)
        .toContain('at least two distinct `sources`')
      expect((await derive({ name: 'new', content: 'b' })).text).toContain('at least two distinct `sources`')
      expect((await derive({ name: 'new', sources: ['alpha', 'beta'], content: null })).text).toContain('`content`')
      expect((await derive({ name: 'new', sources: ['alpha', 'beta'] })).text).toContain('`content`')
      expect((await derive({ name: 'alpha', sources: ['alpha', 'beta'], content: 'b' })).text)
        .toContain('cannot derive "alpha" from itself')
      expect((await derive({ name: 'new', sources: ['alpha', 'absent'], content: 'b' })).text)
        .toContain('source "absent" is unknown')
      expect((await derive({ name: 'new', sources: ['Bad Name', 'beta'], content: 'b' })).text)
        .toContain('invalid skill name')
      // `alpha` names only `beta`, so pairing it with `gamma` is refused by the
      // same allowlist rule the loader enforces on a load set.
      const incompatible = await derive({ name: 'new', sources: ['alpha', 'gamma'], content: 'b' })
      expect(incompatible.text).toContain('not composable with "gamma"')
      // A refused derivation writes nothing.
      expect(await readFile(join(h.dir, 'skills', 'new', 'SKILL.md'), 'utf8').catch(() => 'absent')).toBe('absent')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('refuses a derived body that breaks frontmatter, and an existing name', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      h.skills.push({ name: 'alpha', source: 'user-dsh' })
      h.skills.push({ name: 'beta', source: 'user-dsh' })
      const sources = ['alpha', 'beta']
      expect((await manage(h.ctx, { op: 'derive', name: 'new', sources, content: 'no fences\n' })).text)
        .toContain('malformed frontmatter')
      expect((await manage(h.ctx, {
        op: 'derive', name: 'new', sources, content: '---\nname: other\ndescription: d\n---\nbody\n',
      })).text).toContain('must keep name "new"')
      expect((await manage(h.ctx, {
        op: 'derive', name: 'new', sources, content: '---\nname: new\n---\nbody\n',
      })).text).toContain('must keep a description')
      await manage(h.ctx, {
        op: 'derive', name: 'new', sources, content: '---\nname: new\ndescription: d\n---\nbody\n',
      })
      expect((await manage(h.ctx, {
        op: 'derive', name: 'new', sources, content: '---\nname: new\ndescription: d\n---\nbody\n',
      })).text).toContain('already exists')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('presents the derive operation', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const definition = h.ctx.tools.get('skill_manage')
      expect(definition?.presentCall?.({ op: 'derive', name: 'x', sources: ['a', 'b'], content: 'y' }))
        .toMatchObject({ title: 'derive skill x from a, b', card: 'diff' })
      expect(definition?.presentCall?.({ op: 'derive', name: 'x' })).toMatchObject({ title: 'derive skill x from ' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('works without telemetry mounted', async () => {
    const h = await harness({ telemetry: false })
    dirs.push(h.dir)
    try {
      const file = await skillFile(h.dir, 'plain')
      h.skills.push({ name: 'plain', source: 'user-dsh', path: file })
      const patched = await manage(h.ctx, { op: 'patch', name: 'plain', old_text: 'body', new_text: 'other' })
      expect(patched.isError).toBe(false)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects unknown ops through direct execution', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const definition = h.ctx.tools.get('skill_manage')
      expect(definition).toBeDefined()
      await expect(definition?.execute({ op: 'explode', name: 'x' }, { signal: new AbortController().signal } as never))
        .rejects.toThrow("unknown skill_manage op 'explode'")
    } finally {
      await h.fiber.dispose()
    }
  })

  it('presents every operation', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      const definition = h.ctx.tools.get('skill_manage')
      expect(definition?.presentCall?.({ op: 'create', name: 'x', content: 'y' })).toMatchObject({
        title: 'create skill x',
      })
      expect(definition?.presentCall?.({ op: 'patch', name: 'x', old_text: 'a', new_text: 'b' })).toMatchObject({
        title: 'patch skill x',
      })
      expect(definition?.presentCall?.({ op: 'edit', name: 'x' })).toMatchObject({ title: 'edit skill x', kind: 'edit' })
      expect(definition?.presentCall?.({ op: 'write_file', name: 'x', path: 'r.md' })).toMatchObject({
        title: 'write r.md in skill x',
      })
      expect(definition?.presentCall?.({ op: 'remove_file', name: 'x', path: 'r.md' })).toMatchObject({
        title: 'remove r.md from skill x',
      })
      expect(definition?.presentCall?.({ op: 'delete', name: 'x' })).toMatchObject({
        title: 'delete skill x',
        kind: 'delete',
      })
      expect(definition?.presentCall?.({ op: 'create', name: 'x' })).toMatchObject({ title: 'create skill x' })
      expect(definition?.presentCall?.({ op: 'patch', name: 'x' })).toMatchObject({ title: 'patch skill x' })
      expect(definition?.presentCall?.({ op: 'write_file', name: 'x' })).toMatchObject({ title: 'write  in skill x' })
      expect(definition?.presentCall?.({ op: 'remove_file', name: 'x' })).toMatchObject({
        title: 'remove  from skill x',
      })
      expect(definition?.presentCall?.({ op: 'explode', name: 'x' })).toBeUndefined()
    } finally {
      await h.fiber.dispose()
    }
  })
})

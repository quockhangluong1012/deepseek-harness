/**
 * Model-facing `skill_manage` tool: create, patch, edit, write, remove, and
 * delete agent skills as files under the managed skills directory or in
 * place where the catalog found them. Mutations report to skill telemetry
 * when it is mounted; pins block deletion but never patches.
 * @module @deepseek-ai/dsh-evolution-skill-manage
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { composabilityRefusal } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools/presentation'
import {
  buildDerivedSkillFile,
  buildSkillFile,
  checkSkillName,
  expandCreateDir,
  replaceUniqueSubstring,
  resolveSkillDir,
  resolveSkillPath,
  SKILL_FILE,
  splitSkillFile,
} from './files.ts'

export {
  buildDerivedSkillFile,
  buildSkillFile,
  checkSkillName,
  expandCreateDir,
  replaceUniqueSubstring,
  resolveSkillDir,
  resolveSkillPath,
  SKILL_FILE,
  splitFrontmatter,
  splitSkillFile,
  validateSkillHead,
} from './files.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'evolution-skill-manage'

/** Required host services. */
export const inject = ['tools', 'skills']

/** Deployment choices for managed skill creation. */
export interface Config {
  /** Directory for newly created skills. Supports `~` and `${VAR}`; omission uses the profile skills directory. */
  createDir?: string
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  createDir: z.string(),
})

/** One managed mutation. */
export type SkillManageOp = 'create' | 'derive' | 'patch' | 'edit' | 'write_file' | 'remove_file' | 'delete'

/**
 * Validated arguments for one skill_manage call. The operation stays a
 * plain string so unknown values reach the executor, which enforces the
 * {@link SkillManageOp} set where the mutation runs.
 */
export interface ResolvedManageArgs {
  op: string
  name: string
  description?: string | null
  content?: string | null
  sources?: readonly string[] | null
  path?: string | null
  old_text?: string | null
  new_text?: string | null
}

/**
 * Register the model-facing `skill_manage` tool.
 * @param ctx - plugin context owning the tool registration.
 * @param config - creation directory choices.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const createDir = expandCreateDir(config.createDir)

  const skillManage = defineTool({
    name: 'skill_manage',
    description: 'Create and revise agent skills. New skills go to the managed skills directory; existing skills are patched in place where the catalog found them. Prefer patch for surgical changes, edit to rewrite a skill body, write_file/remove_file for supporting files, and delete to remove a whole skill. Use derive to synthesize a new skill from at least two existing skills.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        description: 'The mutation to run: `create`, `derive`, `patch`, `edit`, `write_file`, `remove_file`, or `delete`.',
      },
      name: {
        type: 'string',
        required: true,
        description: 'Kebab-case skill name, e.g. `code-review`.',
      },
      description: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Required string parameter of `create`: short routing description recorded in the frontmatter.',
      },
      content: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Required string parameter of `create` (instruction body), `edit` (replacement body), `derive` (the complete new SKILL.md, frontmatter included; its `name` must match and its lineage is filled in), and `write_file` (file content).',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required string-array parameter of `derive`: at least two existing skill names the new skill is synthesized from. Each must declare the others as composable when it declares `composable_with` at all.',
      },
      path: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Required string parameter of `write_file` and `remove_file`: path relative to the skill directory.',
      },
      old_text: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Required string parameter of `patch`: uniquely-occurring substring to replace.',
      },
      new_text: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Required string parameter of `patch`: replacement text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', required: true },
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value: { op: string; name: string; path: string }) => [
        { type: 'text', text: `skill_manage ${value.op} ${value.name}: ${value.path}` },
      ],
    },
    async execute(args, exec) {
      checkSkillName(args.name)
      const cwd = exec.agent?.session.header.cwd
      const signal = exec.signal
      switch (args.op) {
        case 'create':
          return createSkill(ctx, createDir, args, signal)
        case 'derive':
          return deriveSkill(ctx, createDir, args, cwd, signal)
        case 'patch':
          return patchSkill(ctx, args, cwd, signal)
        case 'edit':
          return editSkill(ctx, args, cwd, signal)
        case 'write_file':
          return writeSkillFile(ctx, args, cwd, signal)
        case 'remove_file':
          return removeSkillFile(ctx, args, cwd, signal)
        case 'delete':
          return deleteSkill(ctx, args, cwd, signal)
        default:
          throw new Error(`unknown skill_manage op '${args.op}'`)
      }
    },
    presentCall(args: {
      op: string
      name: string
      content?: string | null
      sources?: readonly string[] | null
      path?: string | null
      old_text?: string | null
      new_text?: string | null
    }): ToolCallView | undefined {
      switch (args.op) {
        case 'create': {
          const path = join(createDir, args.name, SKILL_FILE)
          return {
            card: 'diff',
            title: `create skill ${args.name}`,
            diffs: [{ path, oldText: null, newText: args.content ?? '' }],
            locations: [{ path }],
          }
        }
        case 'derive': {
          const path = join(createDir, args.name, SKILL_FILE)
          return {
            card: 'diff',
            title: `derive skill ${args.name} from ${(args.sources ?? []).join(', ')}`,
            diffs: [{ path, oldText: null, newText: args.content ?? '' }],
            locations: [{ path }],
          }
        }
        case 'patch':
          return {
            card: 'diff',
            title: `patch skill ${args.name}`,
            diffs: [{ path: SKILL_FILE, oldText: args.old_text ?? null, newText: args.new_text ?? '' }],
            locations: [{ path: SKILL_FILE }],
          }
        case 'edit':
          return { card: 'generic', title: `edit skill ${args.name}`, kind: 'edit', locations: [{ path: SKILL_FILE }] }
        case 'write_file':
          return {
            card: 'generic',
            title: `write ${args.path ?? ''} in skill ${args.name}`,
            kind: 'edit',
            locations: [{ path: args.path ?? '' }],
          }
        case 'remove_file':
          return {
            card: 'generic',
            title: `remove ${args.path ?? ''} from skill ${args.name}`,
            kind: 'delete',
            locations: [{ path: args.path ?? '' }],
          }
        case 'delete':
          return { card: 'generic', title: `delete skill ${args.name}`, kind: 'delete' }
        default:
          return undefined
      }
    },
  })
  ctx.tools.register(skillManage)
}

/**
 * Require one string argument for an operation.
 * @param value - raw argument value.
 * @param field - argument name for the failure message.
 * @param op - operation name for the failure message.
 * @returns the string value.
 */
function requiredArg(value: string | null | undefined, field: string, op: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`skill_manage ${op} parameter \`${field}\` must be non-empty`)
  }
  return value
}

async function createSkill(
  ctx: Context,
  createDir: string,
  args: ResolvedManageArgs,
  signal: AbortSignal,
): Promise<{ op: string; name: string; path: string }> {
  const description = requiredArg(args.description ?? undefined, 'description', 'create')
  const body = requiredArg(args.content ?? undefined, 'content', 'create')
  const file = join(createDir, args.name, SKILL_FILE)
  const content = buildSkillFile(args.name, description, body)
  await writeNewSkillFile(file, content, args.name, signal)
  const telemetry = ctx.get('evolutionSkillTelemetry')
  await telemetry?.markAgentCreated(args.name)
  await telemetry?.markRevised(args.name, content)
  return { op: 'create', name: args.name, path: file }
}

/**
 * Synthesize one new skill from existing primitives. The sources are catalog
 * skills, so the lineage names skills the host can resolve; the caller's file
 * text goes through the same head invariant `edit` enforces, and its lineage is
 * replaced with the sources actually composed.
 * @param ctx - plugin context owning the catalog and telemetry seams.
 * @param createDir - directory for the synthesized skill.
 * @param args - the call's arguments: the new name, its file text, and the sources.
 * @param cwd - workspace selector for the catalog lookup.
 * @param signal - cancellation for the lookup and the write.
 * @returns the written location.
 */
async function deriveSkill(
  ctx: Context,
  createDir: string,
  args: ResolvedManageArgs,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<{ op: string; name: string; path: string }> {
  const content = requiredArg(args.content ?? undefined, 'content', 'derive')
  const sources = [...new Set(args.sources ?? [])]
  if (sources.length < 2) throw new Error('skill_manage derive requires at least two distinct `sources`')
  for (const source of sources) checkSkillName(source)
  if (sources.includes(args.name)) throw new Error(`skill_manage derive cannot derive "${args.name}" from itself`)
  const catalog = await ctx.skills.list({ cwd, signal })
  const missing = sources.find(source => !catalog.some(skill => skill.name === source))
  if (missing !== undefined) {
    throw new Error(`skill_manage derive source "${missing}" is unknown or no longer available`)
  }
  const refusal = composabilityRefusal(catalog.filter(skill => sources.includes(skill.name)))
  if (refusal !== undefined) throw new Error(`skill_manage derive sources are not composable: ${refusal}`)
  const file = buildDerivedSkillFile(content, args.name, sources)
  const path = join(createDir, args.name, SKILL_FILE)
  await writeNewSkillFile(path, file, args.name, signal)
  const telemetry = ctx.get('evolutionSkillTelemetry')
  await telemetry?.markAgentCreated(args.name)
  await telemetry?.markRevised(args.name, file)
  return { op: 'derive', name: args.name, path }
}

/**
 * Write one brand-new skill file, refusing an existing name. `create` and
 * `derive` share it so the collision contract is one implementation.
 * @param file - absolute SKILL.md path to create.
 * @param content - complete file text.
 * @param name - skill name for the collision failure.
 * @param signal - cancellation for the directory creation and the write.
 */
async function writeNewSkillFile(
  file: string,
  content: string,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  signal.throwIfAborted()
  try {
    await writeFile(file, content, { flag: 'wx', signal })
  } catch (error) {
    /* v8 ignore else -- Non-EEXIST creation failures need a platform permission or I/O fault. */
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new Error(`skill "${name}" already exists: ${file}`)
    }
    /* v8 ignore next -- Non-EEXIST creation failures need a platform permission or I/O fault. */
    throw error
  }
}

async function patchSkill(
  ctx: Context,
  args: ResolvedManageArgs,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<{ op: string; name: string; path: string }> {
  const oldText = requiredArg(args.old_text ?? undefined, 'old_text', 'patch')
  const newText = args.new_text ?? undefined
  if (newText === undefined) throw new Error('skill_manage patch requires a string parameter `new_text`')
  const resolved = await resolveSkillDir(
    () => ctx.skills.list({ cwd, signal }),
    args.name,
    (_dir, file) => file,
  )
  signal.throwIfAborted()
  const current = await readFile(resolved.file, 'utf8')
  const next = replaceUniqueSubstring(current, oldText, newText, `skill "${args.name}" patch`)
  signal.throwIfAborted()
  await writeFile(resolved.file, next, { signal })
  const telemetry = ctx.get('evolutionSkillTelemetry')
  await telemetry?.markPatched(args.name, resolved.source)
  await telemetry?.markRevised(args.name, next)
  return { op: 'patch', name: args.name, path: resolved.file }
}

async function editSkill(
  ctx: Context,
  args: ResolvedManageArgs,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<{ op: string; name: string; path: string }> {
  const content = requiredArg(args.content ?? undefined, 'content', 'edit')
  const resolved = await resolveSkillDir(
    () => ctx.skills.list({ cwd, signal }),
    args.name,
    (_dir, file) => file,
  )
  signal.throwIfAborted()
  const current = await readFile(resolved.file, 'utf8')
  const split = splitSkillFile(current, args.name)
  signal.throwIfAborted()
  const file = `---\n${split.head}\n---\n${content}`
  await writeFile(resolved.file, file, { signal })
  const telemetry = ctx.get('evolutionSkillTelemetry')
  await telemetry?.markPatched(args.name, resolved.source)
  await telemetry?.markRevised(args.name, file)
  return { op: 'edit', name: args.name, path: resolved.file }
}

async function writeSkillFile(
  ctx: Context,
  args: ResolvedManageArgs,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<{ op: string; name: string; path: string }> {
  const rel = requiredArg(args.path ?? undefined, 'path', 'write_file')
  const content = requiredArg(args.content ?? undefined, 'content', 'write_file')
  const resolved = await resolveSkillDir(
    () => ctx.skills.list({ cwd, signal }),
    args.name,
    dir => dir,
  )
  const target = resolveSkillPath(resolved.dir, rel)
  signal.throwIfAborted()
  await mkdir(dirname(target), { recursive: true })
  signal.throwIfAborted()
  await writeFile(target, content, { signal })
  await ctx.get('evolutionSkillTelemetry')?.markPatched(args.name, resolved.source)
  return { op: 'write_file', name: args.name, path: target }
}

async function removeSkillFile(
  ctx: Context,
  args: ResolvedManageArgs,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<{ op: string; name: string; path: string }> {
  const rel = requiredArg(args.path ?? undefined, 'path', 'remove_file')
  const resolved = await resolveSkillDir(
    () => ctx.skills.list({ cwd, signal }),
    args.name,
    dir => dir,
  )
  const target = resolveSkillPath(resolved.dir, rel)
  signal.throwIfAborted()
  try {
    await rm(target)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new Error(`skill "${args.name}" has no file "${rel}"`)
    }
    throw error
  }
  await ctx.get('evolutionSkillTelemetry')?.markPatched(args.name, resolved.source)
  return { op: 'remove_file', name: args.name, path: target }
}

async function deleteSkill(
  ctx: Context,
  args: ResolvedManageArgs,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<{ op: string; name: string; path: string }> {
  const resolved = await resolveSkillDir(
    () => ctx.skills.list({ cwd, signal }),
    args.name,
    dir => dir,
  )
  const telemetry = ctx.get('evolutionSkillTelemetry')
  if (telemetry?.read(args.name)?.pinned === true) {
    throw new Error(`skill "${args.name}" is pinned and cannot be deleted`)
  }
  signal.throwIfAborted()
  await rm(resolved.dir, { recursive: true, force: true })
  return { op: 'delete', name: args.name, path: resolved.dir }
}

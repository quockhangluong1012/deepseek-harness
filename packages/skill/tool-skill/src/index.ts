/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-shell'
import { SessionSeq, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillDefinition,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_OUTPUT_CHARS, resolveSkillLoad, renderSkillBody, type SkillConfigMap } from './load.ts'
import { skillDirForSkillPath } from './template.ts'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/**
 * Durable provider and item records for one published session skill catalog. The catalog is a
 * `catalog`-form context, so it records the entries it published beside the
 * model-facing prose: a consumer presenting the list must not re-parse the
 * `<available_skills>` block, whose framing exists for the model.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly { readonly name: string; readonly description: string }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/** Durable entry list mirroring the rendered catalog lines, for non-model consumers. */
function catalogSourceEntries(
  skills: SkillSummary[],
  descriptionMaxLength: number,
): SkillCatalogSource['entries'] {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(skill.description, descriptionMaxLength),
  }))
}

/**
 * Result properties of one loaded skill. The `skill` tool returns the
 * requested skill in these properties and every composed prerequisite in
 * `composed`, so both are declared from this one place.
 */
const SKILL_VIEW_PROPERTIES = {
  name: { type: 'string', required: true },
  provider: { type: 'string', required: true },
  resourceBase: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'directory' },
          path: { type: 'string', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'url' },
          url: { type: 'string', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'opaque' },
          description: { type: 'string', required: true },
        },
      },
    ],
  },
  content: { type: 'string', required: true },
} as const

/**
 * One loaded skill as the tool result carries it: exactly the fields the
 * result schema declares and {@link renderSkillContent} renders.
 */
type LoadedSkillView = Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'>

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /** Deployment-side skill settings. */
  skills?: {
    /**
     * Per-skill configuration values injected at load, keyed by skill name then
     * config key. A deployed value overrides the skill's own declared default.
     */
    config?: SkillConfigMap
  }
  /** Deployment budgets for opt-in inline shell expansion. */
  shell?: {
    /**
     * Default inline shell timeout in milliseconds when a skill declares no
     * `metadata.shellTimeoutMs`. Minimum 1.
     */
    timeoutMs?: number
    /**
     * Per-expansion output budget in characters. Minimum 1.
     */
    outputMaxChars?: number
  }
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  skills: z.object({
    config: z.dict(z.dict(z.string())).default({}),
  }),
  shell: z.object({
    timeoutMs: z.number().step(1).min(1).default(DEFAULT_SHELL_TIMEOUT_MS),
    outputMaxChars: z.number().step(1).min(1).default(MAX_SHELL_OUTPUT_CHARS),
  }).default({ timeoutMs: DEFAULT_SHELL_TIMEOUT_MS, outputMaxChars: MAX_SHELL_OUTPUT_CHARS }),
})

/**
 * Register the model-facing skill loader and its visibility-matched
 * durable session catalog. The catalog is emitted only when the calling agent
 * resolves this plugin's exact tool registration; a restriction or scoped
 * same-name shadow therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  const shellTimeoutMs = config.shell?.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
  assertPositiveInteger('shell.timeoutMs', shellTimeoutMs)
  const shellOutputMaxChars = config.shell?.outputMaxChars ?? MAX_SHELL_OUTPUT_CHARS
  assertPositiveInteger('shell.outputMaxChars', shellOutputMaxChars)

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...SKILL_VIEW_PROPERTIES,
          composed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: SKILL_VIEW_PROPERTIES,
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [value, ...value.composed ?? []].map(skill => renderSkillContent(skill)).join('\n\n'),
      }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const catalog = await ctx.skills.list(lookup)
      const summary = catalog.find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const vars = { sessionId: exec.agent?.session.id, signal: exec.signal }
      const body = await loadSkillBody(ctx, config, skill, vars)
      if (!body.ok) throw new Error(body.error)
      const composed = await composePrerequisites({ ctx, config, skill, catalog, lookup, vars })
      if (!composed.ok) throw new Error(composed.error)
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: body.content,
        ...composed.composed.length > 0 ? { composed: composed.composed } : {},
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)

  // User-explicit skill invocation: a claimed user message whose first line
  // starts with `/<name>` naming a user-invocable skill is a deterministic
  // load gesture. The rendered body enters this step as injected
  // instructions context appended after every other injection — background
  // first (workspace rules, runtime policy, the catalog), the material the
  // model must act on last, closest to its answer. Registration order makes
  // that placement deterministic: this listener registers before the catalog
  // listener, so the waterfall hands it the catalog-bearing list to extend.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // catalog and the `skill` tool below never see them.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const body = await loadSkillBody(ctx, config, skill, { sessionId: agent.session.id, signal })
      if (!body.ok) {
        ctx.logger.warn(`skill "${name}" skipped: ${body.error}`)
        continue
      }
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent({ ...skill, content: body.content }) }],
        source,
      }))
    }
    if (injections.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  })

  // Register after the tool so reverse teardown removes guidance first. Exact definition
  // identity prevents a scoped shadow merely named `skill` from inheriting this catalog.
  //
  // The comparison is against the definition this plugin registered, not against
  // a lookup of its own name: `register()` files into the CALLING context's
  // scope, so a plugin mounted inside an agent preset registers for that agent
  // alone and an unscoped lookup correctly finds nothing.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool
    const snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })
      : { skills: [], complete: true }
    signal.throwIfAborted()
    if (!snapshot.complete) return decision
    const skills = snapshot.skills.filter(isModelInvocable)
    const entries = catalogSourceEntries(skills, catalogDescriptionMaxLength)
    const digest = digestCatalogEntries(entries)
    const history = catalogHistory(agent)
    const existing = catalogMessage(decision.messages)
    if (history.visibleDigest === digest) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    if (existing !== undefined && digestCatalogEntries(existing.entries) === digest) return decision
    if (!history.published && skills.length === 0) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    const catalog = history.published
      ? renderCatalogUpdate(entries)
      : renderCatalogMessage(entries)
    return {
      ...decision,
      messages: existing === undefined
        ? [...decision.messages, catalog]
        : decision.messages.map(message => message.id === existing.message.id ? catalog : message),
    }
  })
}

/**
 * Resolve one skill's load-time environment and render its body, sharing the
 * deployment configuration, host environment, and shell executor across both
 * loader paths. The caller decides how a resolution failure surfaces: the tool
 * throws the explanatory load error, and the user-explicit injection warns and
 * skips the skill for that step.
 * @param ctx - host context carrying the skill registry and the shell executor.
 * @param config - this plugin's configuration with the deployment-side skill values.
 * @param skill - the loaded skill definition about to render.
 * @param vars - session id and abort signal of the loading step.
 * @returns the rendered body, or the explanatory misconfiguration load error.
 */
async function loadSkillBody(
  ctx: Context,
  config: Config,
  skill: SkillDefinition,
  vars: { readonly sessionId: string | undefined; readonly signal: AbortSignal | undefined },
): Promise<{ readonly ok: true; readonly content: string } | { readonly ok: false; readonly error: string }> {
  const resolution = resolveSkillLoad({
    skill,
    skillsConfig: config.skills?.config,
    env: process.env,
    // Validated in apply(); the fallback covers direct construction, mirroring catalogDescriptionMaxLength above.
    shellDefaults: {
      timeoutMs: config.shell?.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      outputMaxChars: config.shell?.outputMaxChars ?? MAX_SHELL_OUTPUT_CHARS,
    },
  })
  if (!resolution.ok) return resolution
  return {
    ok: true,
    content: await renderSkillBody({
      spec: resolution.spec,
      skillDir: skillDirForSkillPath(skill.path),
      sessionId: vars.sessionId,
      shell: ctx.get('shell'),
      signal: vars.signal,
      warn: (message) => { ctx.logger.warn(message) },
    }),
  }
}

function renderCatalogMessage(entries: SkillCatalogSource['entries']): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries,
    },
  })
}

function renderCatalogUpdate(entries: SkillCatalogSource['entries']): UserMessage {
  const availability = entries.length === 0
    ? [
      'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
    ]
    : [
      'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries,
    },
  })
}

/**
 * Model-facing catalog lines, projected from the same entries the source records.
 * The pseudo-XML escaping belongs to this frame, not to the published fact, so it
 * is applied here and never stored. Names are `isSkillName`-validated and carry
 * no escapable character.
 */
function renderCatalogEntries(entries: SkillCatalogSource['entries']): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/**
 * Catalog identity over the durable entry list rather than the rendered prose.
 * The entries are what changes; the surrounding `<system-reminder>` framing is
 * written for the model and must not decide whether a republish is needed.
 */
function digestCatalogEntries(entries: SkillCatalogSource['entries']): string {
  // JSON per entry rather than a separator character: every separator is itself
  // a legal description character, so only quoting makes the boundary exact.
  const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256')
    .update(canonical)
    .digest('hex')
}

/**
 * Entries of one durable catalog message, or undefined when the record is not a
 * usable catalog.
 *
 * `agent.session.snapshotEvents()` may contain a resumed, forked, or externally written seed,
 * and seed validation only guarantees a source object with a non-empty `kind`;
 * no per-kind field is checked there. An unreadable record is therefore treated
 * as "not this plugin's catalog" — the posture the replaced content digest had —
 * rather than throwing inside the step listener, which would fail every
 * subsequent turn of that session.
 */
function readCatalogEntries(source: unknown): SkillCatalogSource['entries'] | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: { name: string; description: string }[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description } = entry as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  return readable
}

function catalogHistory(agent: Agent): { visibleDigest?: string; published: boolean } {
  const visible = new Set(agent.session.surface.nodes)
  let published = false
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`skill catalog cannot read seq ${String(index)} below the current Session length`)
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(event.data.source)
    if (entries === undefined) continue
    const digest = digestCatalogEntries(entries)
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digest, published }
  }
  return { published }
}

function catalogMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; entries: SkillCatalogSource['entries'] } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(message.source)
    if (entries !== undefined) return { message, entries }
  }
  return undefined
}

function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}

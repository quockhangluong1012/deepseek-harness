/**
 * File-defined agent discovery and compilation: accepted frontmatter, every
 * rejected spelling, precedence between roots, and diagnostics that keep one
 * bad file from failing another agent's delegation.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse as parsePath, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverFileAgents,
  mergeToolFilters,
  normalizeToolName,
  parseAgentFile,
  type AgentFileParse,
} from '../src/agent-files.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One frontmatter block with the given body. */
function fm(body: string): string {
  return `---\n${body}---\n`
}

/** One temp directory this spec owns. */
async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-files-'))
  roots.push(root)
  return root
}

/** Write one definition file, creating its root. */
async function writeDefinition(root: string, name: string, source: string): Promise<string> {
  await mkdir(root, { recursive: true })
  const path = join(root, name)
  await writeFile(path, source, 'utf8')
  return path
}

/** A parsed agent from one frontmatter body, failing the test when the file was rejected. */
function agentOf(body: string): Extract<AgentFileParse, { ok: true }> {
  const parsed = parseAgentFile(fm(body), '/agents/code-reviewer.md')
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.problem)
  return parsed
}

/** The diagnostic one frontmatter body reports. */
function problemOf(body: string): string {
  const parsed = parseAgentFile(fm(body), '/agents/broken.md')
  expect(parsed.ok).toBe(false)
  if (parsed.ok) throw new Error('expected a rejected definition')
  return parsed.problem
}

describe('agent-file frontmatter', () => {
  it('compiles every accepted field into child restriction, route, and permission', () => {
    const parsed = parseAgentFile(fm(`name: code-reviewer
description: Reviews a diff for defects
tools: Read, grep, bash
model: alpha/reviewer-model
permission:
  edit: deny
  bash: ask
`), '/agents/code-reviewer.md')
    expect(parsed).toEqual({
      ok: true,
      notices: ['`permission` for bash is recorded but not enforced; this child keeps those tools'],
      agent: {
        name: 'code-reviewer',
        path: '/agents/code-reviewer.md',
        description: 'Reviews a diff for defects',
        toolFilter: { allow: ['read', 'grep', 'bash'], deny: ['edit'] },
        agentOptions: { provider: 'alpha', model: 'reviewer-model' },
        permission: { edit: 'deny', bash: 'ask' },
      },
    })
  })

  it('names an agent after its file when the file declares no frontmatter', () => {
    const parsed = parseAgentFile('Just a body.\n', '/agents/code-reviewer.md')
    if (!parsed.ok) throw new Error(parsed.problem)
    expect(parsed.agent).toEqual({ name: 'code-reviewer', path: '/agents/code-reviewer.md' })
    expect(parsed.notices).toEqual([])
  })

  it('ignores a body and reports unknown fields while reading comments and inline values', () => {
    const parsed = agentOf(`# a comment
name: planner

description: "Plan a fix: then act"   # inline comment
temperature: 0.4
tools: [read, grep]
`)
    expect(parsed.notices).toEqual(['ignored unknown field "temperature"'])
    expect(parsed.agent.name).toBe('planner')
    expect(parsed.agent.description).toBe('Plan a fix: then act')
    expect(parsed.agent.toolFilter).toEqual({ allow: ['read', 'grep'] })
  })

  it('reads CRLF frontmatter and single-quoted values', () => {
    const parsed = parseAgentFile("---\r\nname: reader\r\ndescription: 'quoted'\r\n---\r\n", '/agents/x.md')
    if (!parsed.ok) throw new Error(parsed.problem)
    expect(parsed.agent.name).toBe('reader')
    expect(parsed.agent.description).toBe('quoted')
  })

  it('treats a tools mapping as denials of the disabled tools only', () => {
    expect(agentOf('tools:\n  write: false\n  edit: true\n').agent.toolFilter).toEqual({ deny: ['write'] })
    expect(agentOf('tools:\n  edit: true\n').agent.toolFilter).toBeUndefined()
  })

  it('reads one permission mapping per tool and rejects a list or inline mapping', () => {
    expect(agentOf('permission:\n  edit: deny\n  read: allow\n').agent.permission)
      .toEqual({ edit: 'deny', read: 'allow' })
    expect(problemOf('permission: [edit]\n')).toBe('`permission` must be an indented map of tool: allow, ask, or deny')
    expect(problemOf('permission: {edit: deny}\n')).toBe('`permission` must be an indented map of tool: allow, ask, or deny')
  })

  it('inherits the child route for an absent or explicit inherit model', () => {
    expect(agentOf('name: a\n').agent.agentOptions).toBeUndefined()
    expect(agentOf('model: inherit\n').agent.agentOptions).toBeUndefined()
    expect(agentOf('model: reviewer-model\n').agent.agentOptions).toEqual({ model: 'reviewer-model' })
    expect(problemOf('model: /reviewer-model\n')).toBe('`model` must be "provider/model", a bare model id, or `inherit`')
    expect(problemOf('model: alpha/\n')).toBe('`model` must be "provider/model", a bare model id, or `inherit`')
  })

  it('restricts nothing for an empty tools declaration', () => {
    expect(agentOf('tools: []\n').agent.toolFilter).toBeUndefined()
    expect(agentOf('tools: ,\n').agent.toolFilter).toBeUndefined()
  })

  it('rejects a malformed field instead of reading it as something else', () => {
    expect(problemOf('name: [a, b]\n')).toBe('`name` must be one plain value')
    expect(problemOf('name: ""\n')).toBe('the agent name is empty')
    expect(problemOf('description:\n  nested: x\n')).toBe('`description` must be one plain value')
    expect(problemOf('model: [a]\n')).toBe('`model` must be one plain value')
    expect(problemOf('tools:\n  write: maybe\n')).toBe('`tools.write` must be true or false')
    expect(problemOf('tools: {write: false}\n')).toBe(
      '`tools` must be a comma-separated list, an inline list, or an indented map of tool: true|false',
    )
    expect(problemOf('tools: [read, grep\n')).toBe('frontmatter line 2 has an unterminated inline list')
    expect(problemOf('permission:\n  edit: maybe\n')).toBe('`permission.edit` must be allow, ask, or deny')
  })

  it('rejects malformed frontmatter blocks and entries', () => {
    expect(parseAgentFile('---\nname: a\n', '/agents/broken.md')).toEqual({
      ok: false,
      problem: 'the frontmatter block has no closing "---"',
    })
    expect(problemOf('- read\n')).toBe('frontmatter line 2 is not a "field: value" entry')
    expect(problemOf('bad name: a\n')).toBe('frontmatter line 2 has an invalid field name "bad name"')
    expect(problemOf('  name: a\n')).toBe('frontmatter line 2 is indented but no mapping is open')
    expect(problemOf('permission:\n  edit:\n')).toBe('frontmatter line 3 declares no mapping value')
    expect(problemOf('name: # only a comment\n')).toBe('frontmatter line 2 declares no value')
    expect(agentOf('\n# comment\nname: a\n').agent.name).toBe('a')
  })

  it('keeps a quoted value that never closes and a one-character name', () => {
    expect(agentOf('name: a\n').agent.name).toBe('a')
    expect(agentOf('description: "unclosed\n').agent.description).toBe('"unclosed')
  })
})

describe('tool-name and filter compilation', () => {
  it('maps Claude Code spellings to harness tool names', () => {
    expect(normalizeToolName('WebFetch')).toBe('web_fetch')
    expect(normalizeToolName('TodoWrite')).toBe('todo_write')
    expect(normalizeToolName(' read ')).toBe('read')
    expect(normalizeToolName('mcp__srv__tool')).toBe('mcp__srv__tool')
  })

  it('intersects allow lists, unions deny lists, and drops an absent side', () => {
    expect(mergeToolFilters(undefined, undefined)).toBeUndefined()
    expect(mergeToolFilters({ allow: ['read'] }, undefined)).toEqual({ allow: ['read'] })
    expect(mergeToolFilters(undefined, { allow: ['grep'] })).toEqual({ allow: ['grep'] })
    expect(mergeToolFilters({ allow: ['read', 'grep'] }, { allow: ['grep'] })).toEqual({ allow: ['grep'] })
    expect(mergeToolFilters({ deny: ['bash'] }, undefined)).toEqual({ deny: ['bash'] })
    expect(mergeToolFilters(undefined, { deny: ['write'] })).toEqual({ deny: ['write'] })
    expect(mergeToolFilters({ deny: ['bash'] }, { deny: ['write', 'bash'] })).toEqual({ deny: ['bash', 'write'] })
    expect(mergeToolFilters({ allow: ['read'] }, { deny: ['read'] })).toEqual({ allow: ['read'], deny: ['read'] })
  })
})

describe('agent-file discovery', () => {
  it('lets a project root win over a user root and an earlier root over a later one', async () => {
    const project = await tempDir()
    const home = await tempDir()
    const firstPath = await writeDefinition(join(project, 'first'), 'duplicate.md', fm('description: first\n'))
    await writeDefinition(join(project, 'second'), 'duplicate.md', fm('description: second\n'))
    await writeDefinition(join(project, 'first'), 'project-only.md', fm(''))
    await writeDefinition(join(home, '.dsh/agents'), 'duplicate.md', fm('description: user\n'))
    const userPath = await writeDefinition(join(home, '.dsh/agents'), 'user-only.md', fm(''))
    const warnings: string[] = []
    const catalog = await discoverFileAgents(
      { project: [join(project, 'first'), join(project, 'second'), join(project, 'first')], user: ['~/.dsh/agents'] },
      { cwd: project, home, warn: message => warnings.push(message) },
    )
    expect([...catalog.agents.keys()]).toEqual(['duplicate', 'project-only', 'user-only'])
    expect(catalog.agents.get('duplicate')?.path).toBe(firstPath)
    expect(catalog.agents.get('duplicate')?.description).toBe('first')
    expect(catalog.agents.get('user-only')?.path).toBe(userPath)
    expect(warnings).toEqual([])
    expect(catalog.roots).toEqual([
      join(project, 'first'),
      join(project, 'second'),
      join(home, '.dsh/agents'),
    ])
  })

  it('resolves a relative project root against the nearest .git ancestor', async () => {
    const project = await tempDir()
    await mkdir(join(project, '.git'), { recursive: true })
    const cwd = join(project, 'packages/nested')
    await mkdir(cwd, { recursive: true })
    await writeDefinition(join(project, '.dsh/agents'), 'rooted.md', fm(''))
    const catalog = await discoverFileAgents(
      { project: ['.dsh/agents'], user: [] },
      { cwd, home: project, warn: () => undefined },
    )
    expect([...catalog.agents.keys()]).toEqual(['rooted'])
    expect(catalog.roots).toEqual([join(project, '.dsh/agents')])
  })

  it('treats a directory outside any repository as its own project root', async () => {
    const root = parsePath(resolve('/')).root
    const catalog = await discoverFileAgents(
      { project: ['.dsh/agents'], user: ['.dsh/agents'] },
      { cwd: root, home: root, warn: () => undefined },
    )
    expect(catalog.roots).toEqual([join(root, '.dsh/agents')])
  })

  it('expands a short home entry and a backslash-separated one to the same root', async () => {
    const home = await tempDir()
    await writeDefinition(join(home, 'agents'), 'shrunk.md', fm(''))
    const catalog = await discoverFileAgents(
      { project: [], user: ['~\\agents', '~'] },
      { cwd: home, home, warn: () => undefined },
    )
    expect([...catalog.agents.keys()]).toEqual(['shrunk'])
    expect(catalog.roots).toEqual([join(home, 'agents'), home])
  })

  it('compiles the role, ceilings, turn cap, and output schema a definition declares', () => {
    const parsed = agentOf(`name: reviewer
role: review
budget:
  maxTokens: 50000
  maxCostUsd: 1.5
maxTurns: 6
outputSchema: ./reviewer.schema.json
`)
    expect(parsed.agent.role).toBe('review')
    expect(parsed.agent.workerLimits).toEqual({ maxTokens: 50_000, maxCostUsd: 1.5, maxTurns: 6 })
    expect(parsed.agent.outputSchemaPath).toBe('./reviewer.schema.json')
    expect(parsed.notices).toEqual([])
  })

  it.each([
    { label: 'an unknown ceiling', body: 'budget:\n  maxWallMs: 1000\n', problem: '`budget.maxWallMs` is not a declared ceiling; declare maxTokens or maxCostUsd' },
    { label: 'a fractional token count', body: 'budget:\n  maxTokens: 1.5\n', problem: '`budget.maxTokens` must be a non-negative whole number' },
    { label: 'a negative amount', body: 'budget:\n  maxCostUsd: -1\n', problem: '`budget.maxCostUsd` must be a non-negative number' },
    { label: 'a scalar budget', body: 'budget: 100\n', problem: '`budget` must be an indented map of maxTokens and maxCostUsd' },
    { label: 'a negative turn cap', body: 'maxTurns: -1\n', problem: '`maxTurns` must be a non-negative whole number' },
    { label: 'a list turn cap', body: 'maxTurns: [3]\n', problem: '`maxTurns` must be one number' },
    { label: 'an empty role', body: 'role: "  "\n', problem: '`role` must name a role' },
    { label: 'an empty schema path', body: 'outputSchema: "  "\n', problem: '`outputSchema` must name a schema file' },
  ])('rejects $label', ({ body, problem }) => {
    expect(problemOf(body)).toBe(problem)
  })

  it('reads a declared output schema at discovery and skips the definition when it is unusable', async () => {
    const project = await tempDir()
    const definitions = join(project, '.dsh/agents')
    await writeDefinition(definitions, 'reviewer.schema.json', JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: { summary: { type: 'string' } },
    }))
    await writeDefinition(definitions, 'reviewer.md', '---\nname: reviewer\noutputSchema: reviewer.schema.json\n---\n')
    await writeDefinition(definitions, 'broken-schema.md', '---\nname: broken\noutputSchema: absent.json\n---\n')
    await writeDefinition(definitions, 'not-a-schema.md', '---\nname: not-a-schema\noutputSchema: scalar.json\n---\n')
    await writeDefinition(definitions, 'scalar.json', '{"type": "string"}')

    const warnings: string[] = []
    const catalog = await discoverFileAgents(
      { project: [definitions], user: [] },
      { cwd: project, home: project, warn: message => warnings.push(message) },
    )

    expect([...catalog.agents.keys()]).toEqual(['reviewer'])
    expect(catalog.agents.get('reviewer')?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { summary: { type: 'string' } },
    })
    expect(warnings.some(message => message.includes('broken-schema.md skipped'))).toBe(true)
    expect(warnings.some(message => message.includes('not-a-schema.md skipped'))).toBe(true)
  })

  it('reports unusable definitions and keeps the usable ones', async () => {
    const project = await tempDir()
    const definitions = join(project, '.dsh/agents')
    await mkdir(join(definitions, 'unreadable.md'), { recursive: true })
    await writeDefinition(definitions, 'unusable.md', fm('name: [x]\n'))
    await writeDefinition(definitions, 'notes.txt', 'ignored')
    await mkdir(join(definitions, 'nested'), { recursive: true })
    await writeDefinition(join(definitions, 'nested'), 'hidden.md', fm(''))
    await writeDefinition(definitions, 'usable.md', fm('permission:\n  edit: deny\n'))
    const warnings: string[] = []
    const catalog = await discoverFileAgents(
      { project: [definitions], user: [] },
      { cwd: project, home: project, warn: message => warnings.push(message) },
    )
    expect([...catalog.agents.keys()]).toEqual(['usable'])
    expect(catalog.agents.get('usable')?.toolFilter).toEqual({ deny: ['edit'] })
    expect(warnings.some(message => message.includes('unusable.md skipped: `name` must be one plain value'))).toBe(true)
    expect(warnings.some(message => message.includes('unreadable.md could not be read'))).toBe(true)
  })
})

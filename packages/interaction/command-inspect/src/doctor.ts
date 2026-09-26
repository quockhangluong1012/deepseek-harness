/**
 * The doctor's deployment checks: sandbox enforcement, provider credentials,
 * MCP servers, language servers, and workspace disk space.
 *
 * Every check is independent. A service a smaller deployment omits, a probe
 * that fails, and a provider that refuses all become a reported status; no
 * check throws into the report, and no check reports a credential value — a
 * missing credential is named by its reference only.
 *
 * @module @deepseek-ai/dsh-command-inspect/doctor
 */

import { statfs } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { PluginInventoryEntry } from '@deepseek-ai/dsh-host-plugin-inventory'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { redactSecrets } from '@deepseek-ai/dsh-prompt-injection'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** Outcome of one check: enforced/configured, working with a caveat, or no data. */
export type DoctorCheckStatus = 'ok' | 'degraded' | 'unavailable'

/** The five deployment facts the doctor reports. */
export type DoctorCheckId = 'sandbox' | 'provider-keys' | 'mcp' | 'lsp' | 'disk'

/** One check's status and the observation behind it. */
export interface DoctorCheck {
  /** Which deployment fact this check reports. */
  readonly id: DoctorCheckId
  readonly status: DoctorCheckStatus
  /** Concrete observation: the mode, reference name, server, row, or byte count. */
  readonly detail: string
}

/** The complete doctor report; `checks` carries one entry per {@link DoctorCheckId}. */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[]
}

/** Human titles for the check ids, in report order. */
const CHECK_TITLES: Record<DoctorCheckId, string> = {
  sandbox: 'Sandbox',
  'provider-keys': 'Provider keys',
  mcp: 'MCP',
  lsp: 'LSP',
  disk: 'Disk',
}

/** Tool-name prefix every MCP-bridged tool carries. */
const MCP_TOOL_PREFIX = 'mcp__'
/** Module specifier of the MCP client plugin, one Loader row per configured server. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
/** Loader module-name prefix shared by the sandbox family. */
const SANDBOX_MODULE_PREFIX = '@deepseek-ai/dsh-sandbox-'
/** The sandbox-family module that owns policy rather than enforcement. */
const SANDBOX_POLICY_MODULE = '@deepseek-ai/dsh-sandbox-policy'
/** Loader module-name prefix shared by the LSP family. */
const LSP_MODULE_PREFIX = '@deepseek-ai/dsh-lsp'

/** One row's enabled flag and fiber phase. */
function describeEntry(entry: PluginInventoryEntry): string {
  const phase = entry.fiberPhase ?? 'not loaded'
  return entry.enabled ? phase : `${phase}, disabled`
}

/** Loader rows whose module name satisfies `matches`, or `undefined` without a Loader. */
async function familyEntries(
  ctx: Context,
  matches: (moduleName: string) => boolean,
): Promise<PluginInventoryEntry[] | undefined> {
  if (ctx.get('loader') === undefined) return undefined
  const inventory = await readPluginInventory(ctx)
  return inventory.entries.filter(entry => matches(entry.moduleName))
}

/** Read a durable settings value at a path; a missing or non-object node reads `undefined`. */
function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** One string field of a decoded settings profile, or `undefined` when it is absent or not a string. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

/** MCP tools grouped by the server segment of their bridged tool name, in first-seen order. */
export function groupMcpServers(tools: readonly ToolSchema[]): Map<string, string[]> {
  const servers = new Map<string, string[]>()
  for (const tool of tools) {
    if (!tool.name.startsWith(MCP_TOOL_PREFIX)) continue
    // The prefix guarantees a separator, so the server segment always exists.
    const segments = tool.name.split('__')
    const server = segments[1] as string
    const name = segments.slice(2).join('__')
    const grouped = servers.get(server) ?? []
    grouped.push(name.length === 0 ? tool.name : name)
    servers.set(server, grouped)
  }
  return servers
}

/**
 * Report confinement: the resolved mode, its workspace root, and the sandbox
 * backend rows the Loader carries.
 * @param ctx - plugin context; the policy and backend services are read with `ctx.get`.
 * @param session - the invoking session, whose cwd and mode override resolve the policy.
 * @returns the sandbox check.
 */
async function sandboxCheck(ctx: Context, session: Session): Promise<DoctorCheck> {
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) {
    return { id: 'sandbox', status: 'unavailable', detail: 'no sandboxPolicy service is mounted' }
  }
  const resolved = policy.resolve({ session })
  const entries = await familyEntries(
    ctx,
    moduleName => moduleName.startsWith(SANDBOX_MODULE_PREFIX) && moduleName !== SANDBOX_POLICY_MODULE,
  )
  let backend: string
  if (entries === undefined) backend = 'unknown (no Loader)'
  else if (entries.length === 0) backend = 'none mounted'
  else backend = entries.map(entry => `${entry.moduleName} (${describeEntry(entry)})`).join(', ')
  const detail = `mode ${resolved.mode}, workspace root ${resolved.workspaceRoot}, backend ${backend}`
  // `danger-full-access` requests no confinement, so an absent backend enforces what was asked for.
  if (resolved.mode === 'danger-full-access') return { id: 'sandbox', status: 'ok', detail }
  if (ctx.get('sandbox') === undefined) {
    return {
      id: 'sandbox',
      status: 'degraded',
      detail: `${detail}; no sandbox provider is mounted, so this mode cannot be enforced`,
    }
  }
  return { id: 'sandbox', status: 'ok', detail }
}

/** Every route the adapters advertise, live or only configurable. */
function routeCount(ctx: Context): number {
  const routes = new Set(ctx.llm.listProviders().map(provider => provider.id))
  for (const entry of ctx.llm.listConfigurableProviders()) routes.add(entry.provider)
  return routes.size
}

/** One provider route with the credential reference its settings profile declares. */
interface DeclaredKey {
  readonly route: string
  readonly ref: string
}

/** Credential references the configured provider profiles name, read from their settings values. */
function declaredKeys(ctx: Context): DeclaredKey[] {
  const settings = ctx.get('settings')
  const descriptors = settings === undefined ? [] : settings.describe()
  const declared: DeclaredKey[] = []
  for (const entry of ctx.llm.listConfigurableProviders()) {
    const descriptor = descriptors.find(row => row.ns === entry.settingsNs)
    const profile = descriptor === undefined ? undefined : valueAtPath(descriptor.value, entry.settingsPath)
    const ref = stringField(profile, 'apiKeyEnv')
    if (ref !== undefined) declared.push({ route: entry.provider, ref })
  }
  return declared
}

/**
 * Report provider credentials by reference name. Configured state comes from
 * the credentials seam, which answers presence without exposing a value.
 * @param ctx - plugin context; the llm registry and the optional settings and credentials seams are read.
 * @returns the provider-key check.
 */
async function providerKeysCheck(ctx: Context): Promise<DoctorCheck> {
  const declared = declaredKeys(ctx)
  if (declared.length === 0) {
    return {
      id: 'provider-keys',
      status: 'ok',
      detail: `${String(routeCount(ctx))} route(s), none declaring a credential reference`,
    }
  }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    return {
      id: 'provider-keys',
      status: 'unavailable',
      detail: `${String(declared.length)} declared reference(s), unreadable: no credentials service is mounted`,
    }
  }
  const missing: string[] = []
  for (const { route, ref } of declared) {
    const info = await credentials.describe(credentialRef(ref))
    if (!info.configured) missing.push(`${route} → ${ref}`)
  }
  const count = `${String(declared.length)} declared reference(s)`
  if (missing.length === 0) return { id: 'provider-keys', status: 'ok', detail: `${count}, all configured` }
  return { id: 'provider-keys', status: 'degraded', detail: `${count}, missing: ${missing.join(', ')}` }
}

/**
 * Report MCP servers: the mounted client rows and the servers whose bridged
 * tools the registry carries. The Loader projection exposes no failure
 * message, so a row that failed activation is named by its entry id.
 * @param ctx - plugin context; the tool registry and the optional Loader are read.
 * @returns the MCP check.
 */
async function mcpCheck(ctx: Context): Promise<DoctorCheck> {
  const names = [...groupMcpServers(ctx.tools.schemas()).keys()]
  const bridged = `${String(names.length)} server(s) bridged${names.length === 0 ? '' : `: ${names.join(', ')}`}`
  const entries = await familyEntries(ctx, moduleName => moduleName === MCP_CLIENT_MODULE)
  if (entries === undefined) {
    return names.length === 0
      ? { id: 'mcp', status: 'unavailable', detail: 'no Loader and no bridged MCP tool, so no MCP server can be named' }
      : { id: 'mcp', status: 'ok', detail: `${bridged}; mounted client rows unknown (no Loader)` }
  }
  if (entries.length === 0) {
    return names.length === 0
      ? { id: 'mcp', status: 'unavailable', detail: 'no mcp-client row is mounted and no bridged MCP tool is registered' }
      : { id: 'mcp', status: 'ok', detail: bridged }
  }
  const mounted = entries.filter(entry => entry.enabled)
  const detail = `${String(mounted.length)} mounted row(s); ${bridged}`
  const failed = entries.filter(entry => entry.fiberPhase === 'failed')
  if (failed.length > 0) {
    return { id: 'mcp', status: 'unavailable', detail: `${detail}; failed: ${failed.map(entry => entry.entryId).join(', ')}` }
  }
  if (mounted.length > names.length) {
    return { id: 'mcp', status: 'degraded', detail: `${detail}; a mounted server published no bridged tool` }
  }
  return { id: 'mcp', status: 'ok', detail }
}

/**
 * Report language servers: whether the seam is mounted and which `dsh-lsp-*`
 * rows the Loader carries. A provider starts its server process on the first
 * matching query, so a row's phase describes the plugin, not a live process.
 * @param ctx - plugin context; the lsp seam and the optional Loader are read.
 * @returns the LSP check.
 */
async function lspCheck(ctx: Context): Promise<DoctorCheck> {
  if (ctx.get('lsp') === undefined) {
    return { id: 'lsp', status: 'unavailable', detail: 'no lsp service is mounted' }
  }
  const entries = await familyEntries(ctx, moduleName => moduleName.startsWith(LSP_MODULE_PREFIX))
  if (entries === undefined) {
    return { id: 'lsp', status: 'unavailable', detail: 'no Loader, so registered language-server rows cannot be listed' }
  }
  if (entries.length === 0) {
    return { id: 'lsp', status: 'degraded', detail: 'the lsp service is mounted but no language-server row is mounted' }
  }
  const detail = entries.map(entry => `${entry.entryId} (${describeEntry(entry)})`).join(', ')
  const failed = entries.filter(entry => entry.fiberPhase === 'failed')
  if (failed.length > 0) {
    return { id: 'lsp', status: 'unavailable', detail: `${detail}; failed: ${failed.map(entry => entry.entryId).join(', ')}` }
  }
  return { id: 'lsp', status: 'ok', detail }
}

/**
 * Report free space on the workspace volume.
 * @param ctx - plugin context; the optional sandbox policy supplies the workspace root.
 * @param session - the invoking session, whose cwd is the root when no policy is mounted.
 * @returns the disk check.
 */
async function diskCheck(ctx: Context, session: Session): Promise<DoctorCheck> {
  const policy = ctx.get('sandboxPolicy')
  const root = policy === undefined ? session.header.cwd : policy.resolve({ session }).workspaceRoot
  if (root === undefined || root === '') {
    return { id: 'disk', status: 'unavailable', detail: 'no workspace root: no sandboxPolicy service and no session cwd' }
  }
  try {
    const stats = await statfs(root)
    return { id: 'disk', status: 'ok', detail: `${String(stats.bavail * stats.bsize)} bytes free on ${root}` }
  } catch (error) {
    return {
      id: 'disk',
      status: 'unavailable',
      detail: `the workspace volume could not be read: ${redactSecrets(String(error)).text}`,
    }
  }
}

/**
 * Run every check. A check that throws reports its own failure as
 * unavailable; the remaining checks still run and report.
 * @param ctx - plugin context the checks read.
 * @param session - the invoking session used to resolve the sandbox policy and workspace root.
 * @returns the complete report, in {@link CHECK_TITLES} order.
 */
export async function runDoctorChecks(ctx: Context, session: Session): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  for (const [id, check] of [
    ['sandbox', sandboxCheck],
    ['provider-keys', providerKeysCheck],
    ['mcp', mcpCheck],
    ['lsp', lspCheck],
    ['disk', diskCheck],
  ] as const) {
    try {
      checks.push(await check(ctx, session))
    } catch (error) {
      checks.push({ id, status: 'unavailable', detail: `the check failed: ${redactSecrets(String(error)).text}` })
    }
  }
  return { checks }
}

/**
 * Render the report as one line per check plus its machine-readable form.
 * @param report - the checks to render.
 * @returns the report text, newline-separated and without a trailing newline.
 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map(check => `${CHECK_TITLES[check.id]}: ${check.status} — ${check.detail}`)
  return [...lines, `Machine-readable: ${JSON.stringify(report)}`].join('\n')
}

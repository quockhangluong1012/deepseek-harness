/**
 * User-facing permission presets over the independent sandbox-mode and
 * approval-policy knobs. A switch records the selected preset, then writes
 * changed knobs through their canonical setters. Execution, prompt narration,
 * and replay keep reading their knob folds. The preset event preserves user
 * intent when two presets share a bundle. The Auto review integration may
 * publish one fixed, current-session-only preset with a synchronous admission
 * check; settings defaults remain limited to the configured table. The read
 * side exposes a process catalog plus the current-value-only `permissions`
 * Session projection; the write side ships as the `/permission` command.
 *
 * The selected preset's capability policy, the rules the user remembered from
 * scoped approval outcomes, and the plan layer while plan mode governs compose
 * one session policy layer: the gate consults it before asking, and it is
 * published to the agent kernel through `registerPolicyProfileProvider`, so a
 * preset narrows or relaxes its own gate through the same document the kernel
 * evaluates. Remembered rules live in the session log.
 *
 * @module dsh-permission-presets
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// Side-effect type import: declaration-merges `ctx.shell` (the capability fact
// `sandboxMode` this service reads), without a value dependency on the seam.
import type {} from '@deepseek-ai/dsh-shell'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { APPROVAL_POLICIES, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
// Type-only: resolves the required projection service and optional settings/command children.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: declaration-merges the `plan` projection key this service reads to enforce plan mode.
import type {} from '@deepseek-ai/dsh-plan-mode'
import { compilePolicy, POLICY_ACTIONS, POLICY_EFFECTS } from '@deepseek-ai/dsh-agent-kernel'
import type {
  Capability,
  CapabilityRequest,
  PolicyAction,
  PolicyDocument,
  PolicyProfileProvider,
  PolicyProfileSelection,
  PolicyRule,
} from '@deepseek-ai/dsh-agent-kernel'
import type { PermissionCatalog, PermissionSelection, PresetOption } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    permissionPresets: PermissionPresetService
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest logged permission overrides and constructor-seed status. */
    permissions: PermissionProjectionState
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records the selected preset as durable, log-only user intent. The knob
     * events follow in the same turn and control execution; this event stays
     * out of the model transcript and lets the permission projection unit
     * preserve a selection when bundles match.
     */
    'permission/preset': { preset: string }
    /**
     * The complete set of rules the user chose to remember, in one log-only
     * whole-value event: remembering one grant or revoking rules both append
     * the resulting set, and the last event wins. The set is the durable home
     * of an `allowed-session` or `allowed-always` approval outcome, so replay
     * restores what the user stopped being asked about.
     */
    'permission/rules': { rules: RememberedRule[] }
  }
}

/** One preset's sandbox/approval bundle, optional policy restriction, and client presentation. */
export interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** Additional capability rules intersected with the deployment policy. */
  policy?: PolicyDocument
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}

/**
 * Returned when effective knob values match no available preset. Clients may
 * show it as the current value, but it is never a switch target or event payload.
 */
export const CUSTOM_PRESET = 'custom'

/** Canonical identity of the experimental per-call review preset. */
export const AUTO_PRESET = 'auto'

/**
 * Fixed execution bundle for the live Auto integration: routine work runs
 * inside a workspace-confined sandbox, and the approval policy stays askable so
 * an action the reviewer refuses to auto-approve reaches the user instead of
 * being rejected on the reviewer's behalf.
 */
const AUTO_PRESET_SPEC: PresetSpec = {
  sandbox: 'workspace-write',
  approval: 'ask',
}

/**
 * The projection unit's knob state: the last seen value of each knob event,
 * null before an override (composition defaults apply at view time).
 */
export interface KnobState {
  /** Last `permission/preset` payload, or null. */
  preset: string | null
  /** Last `sandbox/mode` payload, or null. */
  sandbox: SandboxMode | null
  /** Last `approval/policy` payload, or null. */
  approval: ApprovalPolicy | null
}

/** Projection state for permission overrides and constructor-seed status. */
interface PermissionProjectionState extends KnobState {
  /** Rules the user remembered, in the order they were remembered. */
  rules: RememberedRule[]
  /** Whether the log contains a constructor-seed boundary. */
  seeded: boolean
}

const permissionStateSchema: zod.ZodType<PermissionProjectionState> = zod.object({
  preset: zod.string().nullable(),
  sandbox: zod.union([
    zod.literal('read-only'),
    zod.literal('workspace-write'),
    zod.literal('danger-full-access'),
  ]).nullable(),
  approval: zod.union([zod.literal('ask'), zod.literal('never')]).nullable(),
  rules: zod.array(zod.object({
    action: zod.enum(POLICY_ACTIONS),
    resource: zod.string(),
    scope: zod.enum(['session', 'workspace']),
  }).strict()),
  seeded: zod.boolean(),
}).strict()

/** State for the empty log: every knob at its composition default. */
const EMPTY_KNOBS: KnobState = { preset: null, sandbox: null, approval: null }

/**
 * One-event permission-state transition (the projection unit's `apply`). Unrelated
 * events return the same reference — the registry's change gate.
 * @param state - the folded knob state before `event`.
 * @param event - one committed session event.
 * @returns the next state; the same reference when the event is unrelated.
 */
function applyPermissionEvent(
  state: PermissionProjectionState,
  event: SessionEvent,
): PermissionProjectionState {
  switch (event.type) {
    case 'permission/preset':
      return { ...state, preset: event.data.preset }
    case 'permission/rules':
      return { ...state, rules: [...event.data.rules] }
    case 'sandbox/mode':
      return { ...state, sandbox: event.data.mode }
    case 'approval/policy':
      return { ...state, approval: event.data.policy }
    case 'session/end-seed':
      return { ...state, seeded: true }
    default:
      return state
  }
}

/** Tools gated behind an approval ask whenever this service is composed.
 *
 * Entries are exact tool names, except a trailing `*` which matches a name
 * prefix (`mcp__*` covers every dynamically-registered MCP bridge tool).
 * Unknown names are legal: a pattern matching no currently registered tool
 * stays valid in a deployment that loads no such tool.
 */
export const DEFAULT_APPROVAL_TOOLS: readonly string[] = [
  'bash',
  'pwsh',
  'write',
  'edit',
  'str_replace_editor',
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'terminal_close',
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
  'todo_write',
  'job_kill',
  'skill',
  'run_code',
  'mcp__*',
  'schedule_*',
  'cordis_*',
]

/**
 * Whether one tool name requires an approval ask under the composed gate.
 * @param toolName - the model-facing tool name about to dispatch.
 * @param approvalTools - exact names and `prefix*` patterns to gate.
 * @returns true when the call must resolve through `ctx.approval`.
 */
export function requiresApproval(toolName: string, approvalTools: readonly string[] = DEFAULT_APPROVAL_TOOLS): boolean {
  for (const entry of approvalTools) {
    if (entry.endsWith('*')) {
      if (toolName.startsWith(entry.slice(0, -1))) return true
    } else if (toolName === entry) {
      return true
    }
  }
  return false
}

/**
 * The action family each capability belongs to, mirroring the kernel's own
 * policy table. The kernel decides an action only on its own
 * `tools/pre-execute` listener, but this service must decide, before that ask
 * exists, whether the session's own layer already allows a call, so it projects
 * the same families. `tests/policy-family.spec.ts` asserts every entry against
 * the kernel's own evaluation, so a capability the kernel re-homes fails this
 * package's suite instead of silently widening or dropping a rule.
 */
const CAPABILITY_ACTIONS: Readonly<Record<Capability, PolicyAction>> = {
  'fs.read': 'read',
  'fs.write': 'write',
  'git.read': 'read',
  'git.write': 'write',
  'fs.edit': 'edit',
  'process.exec': 'shell',
  'terminal.interactive': 'shell',
  'network.read': 'network',
  'network.write': 'network',
  'browser.read': 'browser',
  'mcp.call': 'mcp',
  'memory.read': 'memory',
  'memory.write': 'memory',
  'subagent.spawn': 'delegate',
  'workflow.start': 'workflow',
  'approval.request': 'policy',
  'policy.propose': 'policy',
}

/** How long a rule a human chose to remember lasts. */
export type RememberedRuleScope = 'session' | 'workspace'

/**
 * One approval rule the user remembered for a granted call. A `session` rule
 * selects exactly the resource that was granted; a `workspace` rule selects it
 * and every later call sharing the prefix, so it is the same grant over a path
 * that already proved routine.
 */
export interface RememberedRule {
  /** Action family of the granted call, from the kernel's policy vocabulary. */
  action: PolicyAction
  /** Resource the granted call declared: a workspace path, a command line, or another tool's domain selector. */
  resource: string
  /** Whether the rule lasts for the live session or is a workspace prefix rule. */
  scope: RememberedRuleScope
}

/** The rule a scoped approval grant on one pending call would remember, before the human picks a scope. */
type PendingRule = Omit<RememberedRule, 'scope'>

/** User setting resolved when a new session receives its initial permission. */
export interface PermissionSettings {
  /** Preset pinned into a newly created session. */
  defaultPreset: string
}

/** The {@link PermissionPresetService} config: preset table and composition default. */
export interface Config {
  /**
   * The preset table: name → sandbox/approval bundle with an optional
   * capability policy. Defaults to `workspace-write` (workspace-write + ask)
   * and `danger-full-access` (danger-full-access + never). The names `custom`
   * and `auto` are reserved for derived state and the Auto review integration.
   */
  presets: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset: Volatile<string | undefined>
  /**
   * Tool names gated behind an approval ask. Exact names match exactly; a
   * trailing `*` matches a name prefix (`mcp__*`). Defaults to
   * {@link DEFAULT_APPROVAL_TOOLS}.
   */
  approvalTools?: string[]
  /**
   * The policy layer this service publishes while the `plan` projection reports
   * plan mode active. Its rules are appended after the selected preset's and the
   * remembered ones, so a plan-mode denial wins for the same action family; its
   * defaults decide the composed layer's default when the selected preset
   * declares no document of its own. The shipped default denies the file
   * mutations and shell commands a plan must precede, since a shell command can
   * change the workspace just as directly. Defaults to that document.
   */
  planModePolicy: PolicyDocument
}

/** The capability-policy shape every policy field of this plugin's config accepts. */
const policyDocumentSchema = z.object({
  defaults: z.object({ effect: z.union(POLICY_EFFECTS) }),
  rules: z.array(z.object({
    action: z.union(POLICY_ACTIONS),
    resource: z.string().pattern(/[\s\S]+/),
    effect: z.union(POLICY_EFFECTS),
  })),
})

/**
 * The plan-mode policy a deployment gets without configuring one: the file
 * mutations and the shell commands that could perform them are denied while a
 * plan is being prepared, and everything else keeps the deployment's rules.
 */
const DEFAULT_PLAN_MODE_POLICY: PolicyDocument = {
  defaults: { effect: 'allow' },
  rules: [
    { action: 'write', resource: '**', effect: 'deny' },
    { action: 'edit', resource: '**', effect: 'deny' },
    { action: 'shell', resource: '**', effect: 'deny' },
  ],
}

/** One memoized session policy layer: its document and the three inputs it was composed from. */
interface ComposedLayer {
  preset: string
  plan: boolean
  remembered: readonly RememberedRule[]
  document: PolicyDocument | undefined
}

/**
 * Owns the deployment's configured permission presets, the fixed Auto
 * integration hook, and their write path. Requires a confining `ctx.shell` executor and
 * `ctx.approval`; unmatched knob values are reported as
 * {@link CUSTOM_PRESET}, not an error.
 */
export class PermissionPresetService extends TypertRemoteService {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config = z.object({
    presets: z.dict(z.object({
      sandbox: z.union(SANDBOX_MODES as SandboxMode[]).required(),
      approval: z.union(APPROVAL_POLICIES as ApprovalPolicy[]).required(),
      policy: z.union([policyDocumentSchema, z.const(undefined)]),
      name: z.string(),
      description: z.string(),
    })).default({
      // Table order decides the derived preset for a fresh session, so the
      // plain workspace bundle stays first: `accept-edits` shares its sandbox
      // and approval values and is told apart by its own selection event.
      'workspace-write': {
        sandbox: 'workspace-write', approval: 'ask',
        name: 'workspace-write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access', approval: 'never',
        name: 'danger-full-access', description: 'Full file access without approval prompts.',
      },
      'accept-edits': {
        sandbox: 'workspace-write', approval: 'ask',
        policy: {
          defaults: { effect: 'allow' },
          rules: [
            { action: 'edit', resource: '**', effect: 'allow' },
            { action: 'write', resource: '**', effect: 'allow' },
          ],
        },
        name: 'accept-edits', description: 'File edits inside the workspace are approved automatically; shell commands still ask.',
      },
    }),
    defaultPreset: z.string().volatile(),
    approvalTools: z.array(z.string()).default([...DEFAULT_APPROVAL_TOOLS]),
    planModePolicy: policyDocumentSchema.default(DEFAULT_PLAN_MODE_POLICY),
  })

  static inject = ['shell', 'approval', 'sessions', 'sessionProjections']

  private readonly presets: Record<string, PresetSpec>
  private readonly planModePolicy: PolicyDocument
  private autoAdmit: (() => void) | undefined
  private defaultSettings: () => PermissionSettings
  /**
   * The rules a scoped grant on one pending call would remember, armed by the
   * gate when it asks and consumed by the approval answerer that carries the
   * outcome back. Both run inside the same call, and an entry is dropped when
   * that call's approval settles or runs without asking.
   */
  private readonly pending = new Map<ToolExecution['callId'], PendingRule[]>()
  /** Last composed session layer and the inputs it came from; see {@link layerDocument}. */
  private composed: ComposedLayer | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'permissionPresets')

    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    // The schema defaulted the table — the cast records that runtime fact.
    this.presets = config.presets
    if (CUSTOM_PRESET in this.presets) {
      throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state and cannot name a table entry`)
    }
    if (AUTO_PRESET in this.presets) {
      throw new Error(`permission: "${AUTO_PRESET}" is reserved and cannot name a configured preset`)
    }
    for (const [name, spec] of Object.entries(this.presets)) {
      if (spec.policy === undefined) continue
      // Fail loud at load: the kernel owns the permission vocabulary, so a
      // preset that names an unknown action or an empty resource is a
      // misconfiguration of this table, not a runtime surprise.
      try {
        compilePolicy(spec.policy)
      } catch (error) {
        throw new Error(`permission: preset "${name}" declares an invalid capability policy`, { cause: error })
      }
    }
    if (ctx.shell.sandboxMode === undefined) {
      throw new Error('permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration')
    }
    this.planModePolicy = config.planModePolicy
    const inferredDefault = this.derive(EMPTY_KNOBS)
    const defaultPreset = config.defaultPreset.get() ?? inferredDefault
    if (defaultPreset === CUSTOM_PRESET) {
      throw new Error('permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly')
    }
    this.resolve(defaultPreset)
    this.defaultSettings = () => {
      const defaultPreset = config.defaultPreset.get() ?? inferredDefault
      if (!Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`)
      return { defaultPreset }
    }

    const selectionSchema = zod.object({
      currentValue: zod.string().min(1),
    }) as zod.ZodType<PermissionSelection>
    ctx.sessionProjections.register({
      key: 'permissions',
      stateVersion: 3,
      stateSchema: permissionStateSchema,
      init: () => ({ ...EMPTY_KNOBS, rules: [], seeded: false }),
      apply: applyPermissionEvent,
      wire: { viewSchema: selectionSchema, view: state => ({ currentValue: this.derive(state) }) },
    })
    ctx.on('session/created', (session) => {
      this.pinInitialPermission(session)
    })
    for (const session of ctx.sessions.list()) {
      this.pinInitialPermission(session)
    }

    // The selected preset adds policy restrictions to the kernel without
    // making AgentKernel a requirement for the user-facing selector.
    const policyProfiles: PolicyProfileProvider = {
      resolve: session => this.policyProfileOf(session),
    }
    ctx.inject(['agentKernel'], (kernelCtx) => {
      kernelCtx.effect(() => kernelCtx.agentKernel.registerPolicyProfileProvider(policyProfiles))
    })

    // First-class approval producer: gated tools resolve through `ctx.approval`
    // before dispatch. The `ask` decision always routes through the approval
    // service, so the `never` policy still fails closed with its audit pair and
    // an `unavailable` channel still denies. Observation tools delegate to the
    // next listener unchanged. This listener is the shipped bundle's only
    // producer of `{kind: 'ask'}`.
    // The schema defaulted the list — the cast records that runtime fact.
    const approvalTools = [...(config.approvalTools as string[])]
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (!requiresApproval(exec.name, approvalTools)) return next()
      // A session already standing on danger-full-access carries the
      // deployment's unrestricted file authority: the gate protects nothing
      // there, and asking would only feed the `never` policy's deterministic
      // rejection — the failure that makes the Full access preset reject every
      // gated write. Agentless calls keep the ask (fail closed with no session
      // to read).
      const session = exec.agent?.session
      if (session === undefined) {
        return { kind: 'ask', reason: `tool "${exec.name}" requires approval under the current permission preset` }
      }
      const knobs = this.permissionState(session)
      if ((knobs.sandbox ?? this.ctx.shell.sandboxMode) === 'danger-full-access') return next()
      // A live Auto Session already resolves this exact call through its
      // reviewer, which allows routine sandboxed work and routes risky work
      // back into this same approval service. Asking again here would put the
      // identical call to the user after the reviewer approved it, so the
      // reviewer is the Session's single approval decision point.
      if (this.autoAdmit !== undefined && this.current(session) === AUTO_PRESET) return next()

      // The session's own layer — the selected preset, the rules the user
      // remembered, and the plan layer — decides before the human is asked.
      // Its verdict needs the capabilities the tool declared, so an undeclared
      // or unsupported tool keeps asking rather than running unchecked.
      const declared = this.ctx.get('agentKernel')?.capabilities.resolve(exec.name, exec.arguments)
      const verdict = declared === undefined || declared.length === 0
        ? undefined
        : this.layerVerdict(session, declared)
      if (verdict?.effect === 'allow') {
        this.pending.delete(exec.callId)
        return next()
      }
      if (verdict?.effect === 'deny') {
        return { kind: 'deny', reason: `the session's permission preset denies ${verdict.rule.action} ${JSON.stringify(verdict.rule.resource)}` }
      }
      // Arm the rule a scoped grant on this call would remember: the resource
      // projection belongs to the declaring tool, and the answerer that carries
      // the outcome back has no arguments to project from.
      if (declared !== undefined && declared.length > 0) {
        this.pending.set(exec.callId, declared.map(request => ({
          action: CAPABILITY_ACTIONS[request.capability],
          resource: request.resource,
        })))
      }
      return { kind: 'ask', reason: `tool "${exec.name}" requires approval under the current permission preset` }
    })

    // A scoped grant is the human's permission to stop asking. This listener
    // prepares the composed answerer chain so it observes the outcome and
    // records the rule the gate armed for the same call; the outcome itself
    // travels on unchanged, and the tool registry still owns the grant.
    ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
      const outcome = await next()
      if (outcome !== 'allowed-session' && outcome !== 'allowed-always') return outcome
      const callId = req.callId
      const pending = callId === undefined ? undefined : this.pending.get(callId)
      if (callId !== undefined) this.pending.delete(callId)
      if (pending === undefined || pending.length === 0) {
        this.ctx.logger.warn(`permission: the scoped grant for tool "${req.toolName}" has no rememberable scope; it applies to this call only`)
        return outcome
      }
      this.remember(req.agent.session, pending, outcome === 'allowed-always' ? 'workspace' : 'session')
      return outcome
    }, { prepend: true })

    // The /permission command: the one write path a web client uses (the
    // popup contribution submits the picked preset as this line). The child
    // activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'),
        name: 'permission',
        description: 'Switch the permission preset (sandbox mode + approval policy), list remembered rules, or forget them',
        input: { hint: '<preset|rules|forget all|forget N>' },
        // No settlement text labels its value with this command's own name: a
        // surface that renders `name · text` (the web command row) would
        // otherwise read `permission · Permission preset: workspace-write.`
        handler: ({ agent, rawInput }) => {
          const query = rawInput.trim()
          const rules = this.permissionState(agent.session).rules
          if (query === 'rules') {
            return rules.length === 0
              ? { kind: 'success', text: `preset ${this.current(agent.session)}; remembered rules: none (every gated action asks)` }
              : {
                kind: 'success',
                text: `remembered rules (${String(rules.length)}):\n${rules.map((rule, index) =>
                  `${String(index + 1)}. ${rule.action} ${JSON.stringify(rule.scope === 'workspace' ? `${rule.resource}**` : rule.resource)} (${rule.scope})`,
                ).join('\n')}`,
              }
          }
          if (query === 'forget' || query.startsWith('forget ')) {
            const target = query.slice('forget'.length).trim()
            const index = target === '' || target === 'all' ? undefined : Number(target)
            if (index !== undefined && (!Number.isInteger(index) || index < 1 || index > rules.length)) {
              return { kind: 'error', text: `unknown remembered rule "${target}" (use /permission rules)` }
            }
            const removed = this.forget(agent.session, (_rule, at) => index !== undefined && at !== index - 1)
            return { kind: 'success', text: `forgot ${String(removed)} remembered rule(s)` }
          }
          if (query === '') {
            return { kind: 'success', text: `current preset ${this.current(agent.session)} (available: ${this.names.join(', ')})` }
          }
          if (!this.names.includes(query)) {
            return { kind: 'error', text: `unknown preset "${query}" (available: ${this.names.join(', ')})` }
          }
          this.apply(agent.session, query, (policy) => { this.ctx.approval.setPolicy(agent, policy) })
          return { kind: 'success', text: `preset ${query}` }
        },
      })
    })
  }

  /**
   * The advertised preset names: configured entries in declaration order,
   * followed by Auto while its integration is live.
   * @returns every switchable preset name.
   */
  get names(): readonly string[] {
    return [...Object.keys(this.presets), ...(this.autoAdmit === undefined ? [] : [AUTO_PRESET])]
  }

  /**
   * Read the complete process-level catalog exposed to current-session UI.
   * @returns every currently selectable preset in contribution order.
   */
  @Remote('catalog')
  catalog(): PermissionCatalog {
    return {
      options: this.names.map(name => this.optionOf(name)),
      defaultOptions: Object.keys(this.presets).map(name => this.optionOf(name)),
      defaultPreset: this.defaultSettings().defaultPreset,
    }
  }

  /**
   * Publish the fixed current-session Auto preset for the calling
   * integration's effect lifetime.
   * @param admit - synchronous gate run before live Auto selection or restore.
   * @returns the async effect disposer that removes Auto.
   */
  registerAuto(admit: () => void): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.autoAdmit !== undefined) throw new Error('permission: preset "auto" is already registered')
      this.autoAdmit = admit
      this.emitCatalogChanged()
      return () => {
        this.autoAdmit = undefined
        this.emitCatalogChanged()
      }
    }, 'permissionPresets.registerAuto()')
  }

  /**
   * The preset currently selected as the default for future sessions.
   * @returns the resolved settings value, or the composition default without
   * a mounted settings provider.
   */
  get defaultPreset(): string {
    return this.defaultSettings().defaultPreset
  }

  private permissionState(session: Session): PermissionProjectionState {
    const state = this.ctx.sessionProjections.stateOf(session, 'permissions')
    if (state === undefined) throw new Error('permission: permissions session projection is not registered')
    return state
  }

  /**
   * Whether plan mode governs the session's next call. A logged selection that
   * has not taken effect yet already governs the prompt, so it governs the
   * layer too; the plan projection is absent when plan mode is not composed.
   */
  private planModeActive(session: Session): boolean {
    const plan = this.ctx.sessionProjections.stateOf(session, 'plan')
    return plan !== undefined && (plan.wanted ?? plan.active)
  }

  /**
   * The session's own permission layer as one document, memoized on the three
   * inputs it is composed from so the kernel keeps caching its compiled engine
   * across calls. `undefined` means neither the preset, the remembered rules,
   * nor the plan layer says anything, so the kernel evaluates the deployment
   * document alone.
   */
  private layerDocument(session: Session): PolicyDocument | undefined {
    const preset = this.current(session)
    const plan = this.planModeActive(session)
    const remembered = this.permissionState(session).rules
    const cached = this.composed
    if (cached !== undefined && cached.preset === preset && cached.plan === plan && cached.remembered === remembered) {
      return cached.document
    }
    const rules: PolicyRule[] = [...this.specOf(preset)?.policy?.rules ?? []]
    for (const rule of remembered) {
      rules.push({ action: rule.action, resource: rule.scope === 'workspace' ? `${rule.resource}**` : rule.resource, effect: 'allow' })
    }
    if (plan) rules.push(...this.planModePolicy.rules)
    // The primary layer's defaults decide: the selected preset's, or the plan
    // layer's while plan mode governs without a preset document. A layer that
    // is not primary contributes rules only, because a default is a decision
    // about everything the layer does not name.
    const declared = this.specOf(preset)?.policy
    const document = rules.length === 0
      ? undefined
      : { defaults: declared?.defaults ?? (plan ? this.planModePolicy.defaults : { effect: 'allow' as const }), rules }
    this.composed = { preset, plan, remembered, document }
    return document
  }

  /**
   * The session layer's verdict for one call's declared capabilities. Denial
   * dominates across them, and a capability the layer does not mention keeps
   * asking: the gate may only relax where the layer explicitly allows, so a
   * remembered rule can never widen what the layer does not cover. A denial
   * carries the rule that made it, so the refusal can name it.
   */
  private layerVerdict(
    session: Session,
    declared: readonly CapabilityRequest[],
  ): { effect: 'allow' | 'ask' } | { effect: 'deny'; rule: PolicyRule } {
    const document = this.layerDocument(session)
    if (document === undefined) return { effect: 'ask' }
    const compiled = compilePolicy(document)
    let effect: 'allow' | 'ask' = 'allow'
    for (const request of declared) {
      const action = CAPABILITY_ACTIONS[request.capability]
      let matched: PolicyRule | undefined
      for (const [index, rule] of document.rules.entries()) {
        if (rule.action !== action || compiled.rules[index]?.pattern.test(request.resource) !== true) continue
        matched = rule
      }
      if (matched?.effect === 'deny') return { effect: 'deny', rule: matched }
      if (matched?.effect !== 'allow') effect = 'ask'
    }
    return { effect }
  }

  /**
   * Append the rules a scoped grant remembers. The whole set travels in one
   * log-only event, so remembering a grant and revoking rules are the same
   * write. A resource that is itself a selector cannot be remembered: the
   * policy vocabulary has no escape character, so a literal `*` would widen the
   * rule past what the human granted; the call's own grant still applies.
   */
  private remember(session: Session, pending: readonly PendingRule[], scope: RememberedRuleScope): void {
    const granted = pending.map(rule => ({ ...rule, scope }))
    const unrememberable = granted.find(rule => /[*?]/.test(rule.resource))
    if (unrememberable !== undefined) {
      this.ctx.logger.warn(`permission: resource ${JSON.stringify(unrememberable.resource)} is itself a selector, so it was not remembered; the grant applies to this call only`)
      return
    }
    const current = this.permissionState(session).rules
    const next = [
      ...current.filter(rule => !granted.some(added => added.action === rule.action && added.resource === rule.resource)),
      ...granted,
    ]
    const unchanged = next.length === current.length
      && next.every((rule, index) => {
        const before = current[index]
        return before !== undefined && before.action === rule.action && before.resource === rule.resource && before.scope === rule.scope
      })
    if (unchanged) return
    session.append('permission/rules', { rules: next })
  }

  /**
   * Replace the remembered rule set, dropping every rule when `keep` returns
   * false; the command's revocation path.
   * @param session - the session whose rules change.
   * @param keep - whether one rule survives.
   * @returns how many rules were removed.
   */
  private forget(session: Session, keep: (rule: RememberedRule, index: number) => boolean): number {
    const current = this.permissionState(session).rules
    const next = current.filter(keep)
    if (next.length !== current.length) session.append('permission/rules', { rules: next })
    return current.length - next.length
  }

  /** Resolve the selected preset's and the session layer's policy for the kernel. */
  private policyProfileOf(session: Session): PolicyProfileSelection {
    const profile = this.current(session)
    const document = this.layerDocument(session)
    return { profile, ...document === undefined ? {} : { document } }
  }

  /**
   * Resolve the preset matching the effective knob values. A still-matching
   * last selection wins shared-bundle ties; otherwise the first configured
   * match wins. Returns
   * {@link CUSTOM_PRESET} when no available preset matches.
   * @param session - the session whose knob state is read.
   * @returns the effective preset name, or `custom` when nothing matches.
   */
  current(session: Session): string {
    return this.derive(this.permissionState(session))
  }

  /** Resolve the preset for one folded knob state (the shared mathematics of `current` and the projection unit). */
  private derive(state: KnobState): string {
    const sandbox = state.sandbox ?? this.ctx.shell.sandboxMode
    const approval = state.approval ?? this.ctx.approval.config.policy ?? 'ask'
    const matches = (spec: PresetSpec): boolean => spec.sandbox === sandbox && spec.approval === approval
    if (state.preset !== null) {
      const spec = this.specOf(state.preset)
      if (spec !== undefined && matches(spec)) return state.preset
    }
    for (const [name, spec] of Object.entries(this.presets)) {
      if (matches(spec)) return name
    }
    return CUSTOM_PRESET
  }

  /**
   * Resolve an available preset's knob bundle.
   * @param name - the preset name to resolve.
   * @returns the configured bundle.
   * @throws when `name` is neither configured nor the currently live Auto preset.
   */
  resolve(name: string): PresetSpec {
    const spec = this.specOf(name)
    if (spec === undefined) {
      throw new Error(`permission: unknown preset "${name}" (known: ${this.names.join(', ')})`)
    }
    return spec
  }

  /**
   * Build the client option for an available preset or {@link CUSTOM_PRESET}.
   * A missing label falls back to the preset key.
   * @param name - a configured preset key, live `auto`, or `custom`.
   * @returns the option a client renders.
   * @throws when `name` is neither a configured preset, live `auto`, nor `custom`.
   */
  optionOf(name: string): PresetOption {
    if (name === CUSTOM_PRESET) {
      return { value: CUSTOM_PRESET, name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }
    }
    const spec = this.resolve(name)
    return { value: name, name: spec.name ?? name, ...spec.description !== undefined ? { description: spec.description } : {} }
  }

  /**
   * Record a changed preset, then update each changed knob through its own
   * setter. Selecting the effective preset again appends nothing.
   * @param session - the session the switch belongs to.
   * @param name - the preset to switch to; unknown names throw.
   */
  set(session: Session, name: string): void {
    this.apply(session, name, (policy) => { setApprovalPolicy(session, policy) })
  }

  /** Apply one preset through its durable identity and canonical knob setters. */
  private apply(session: Session, name: string, setApproval: (policy: ApprovalPolicy) => void): void {
    const spec = this.resolve(name)
    if (name === AUTO_PRESET) this.autoAdmit?.()
    const current = this.current(session)
    const knobs = this.permissionState(session)
    const updateKnobs = (): void => {
      if (spec.sandbox !== (knobs.sandbox ?? this.ctx.shell.sandboxMode)) {
        setSandboxMode(session, spec.sandbox)
      }
      if (spec.approval !== (knobs.approval ?? this.ctx.approval.config.policy ?? 'ask')) {
        setApproval(spec.approval)
      }
    }
    if (current !== name) session.append('permission/preset', { preset: name })
    updateKnobs()
  }

  /**
   * Fill every missing permission fact before a session is published. A
   * genuinely fresh session uses the current user default; seeded or partially
   * initialized sessions preserve their effective knob values and only gain
   * the missing durable facts. A stored Auto identity requires its live
   * integration and passes its admission check before publication, then adopts
   * the current Auto bundle: the reviewer's execution scope is part of that
   * identity, so a Session recorded under an earlier bundle is narrowed to the
   * current one instead of resuming with a stale scope.
   */
  private pinInitialPermission(session: Session): void {
    const state = this.permissionState(session)
    const { preset, sandbox, approval, seeded } = state
    if (preset === AUTO_PRESET) {
      if (this.autoAdmit === undefined) {
        throw new Error('permission: cannot restore preset "auto" without its active integration')
      }
      this.autoAdmit()
      if (sandbox !== AUTO_PRESET_SPEC.sandbox) setSandboxMode(session, AUTO_PRESET_SPEC.sandbox)
      if (approval !== AUTO_PRESET_SPEC.approval) setApprovalPolicy(session, AUTO_PRESET_SPEC.approval)
    }
    if (preset === null && sandbox === null && approval === null && !seeded) {
      const name = this.defaultPreset
      const spec = this.resolve(name)
      session.append('permission/preset', { preset: name })
      setSandboxMode(session, spec.sandbox)
      setApprovalPolicy(session, spec.approval)
      return
    }

    const effective = this.derive(state)
    if (preset === null && effective !== CUSTOM_PRESET) {
      session.append('permission/preset', { preset: effective })
    }
    if (sandbox === null) {
      setSandboxMode(session, this.ctx.shell.sandboxMode as SandboxMode)
    }
    if (approval === null) {
      setApprovalPolicy(session, this.ctx.approval.config.policy ?? 'ask')
    }
  }

  /** Publish a non-vetoing payload-free catalog invalidation. */
  private emitCatalogChanged(): void {
    for (const listener of this.ctx.events.dispatch('emit', ['permission-presets/catalog-changed']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).catch((error: unknown) => {
            this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Resolve one configured or currently live fixed preset without throwing. */
  private specOf(name: string): PresetSpec | undefined {
    return this.presets[name]
      ?? (name === AUTO_PRESET && this.autoAdmit !== undefined ? AUTO_PRESET_SPEC : undefined)
  }
}

export default PermissionPresetService

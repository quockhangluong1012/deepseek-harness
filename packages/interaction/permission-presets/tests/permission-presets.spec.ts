import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, {
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import AgentKernel, { CAPABILITY_VOCABULARY, POLICY_ACTIONS } from '@deepseek-ai/dsh-agent-kernel'
import type { Capability, CapabilityRequest, PolicyProfileProvider } from '@deepseek-ai/dsh-agent-kernel'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { PlanUnitState } from '@deepseek-ai/dsh-plan-mode/types'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import PermissionPresetService, {
  AUTO_PRESET, CUSTOM_PRESET, DEFAULT_APPROVAL_TOOLS, requiresApproval,
} from '@deepseek-ai/dsh-permission-presets'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const configurations = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()

async function mounted(options: {
  config?: NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>
  bashDefault?: SandboxMode | undefined
  approvalDefault?: ApprovalPolicy | undefined
  projection?: boolean
} = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.projection !== false) await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', {
    sandboxMode: 'bashDefault' in options ? options.bashDefault : 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  ctx.provide('approval', { config: { policy: 'approvalDefault' in options ? options.approvalDefault : 'ask' } })
  await ctx.plugin(PermissionPresetService, options.config ?? {})
  return ctx
}

function freshSession(id: string): Session {
  return Session.create(SessionId(id))
}

async function mountAuto(ctx: Context, admit: () => void = () => {}) {
  return ctx.plugin(Object.assign((pluginCtx: Context) => {
    pluginCtx.permissionPresets.registerAuto(admit)
  }, { inject: ['permissionPresets'] }))
}

async function mountedStore(options: { approvalDefault?: ApprovalPolicy | undefined } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  ctx.provide('approval', {
    config: { policy: 'approvalDefault' in options ? options.approvalDefault : 'ask' },
  })
  configurations.set(ctx, await liveConfig(ctx, PermissionPresetService))
  return ctx
}

type GateExec = { name: string; arguments?: unknown; callId?: string; agent?: { session: Session } }
type GateHandler = (exec: GateExec, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>

/** The agent-kernel surfaces the gate reads, plus the provider it registers. */
interface KernelStub {
  /** Capability declarations keyed by tool name, as the builtins plugin registers them. */
  declarations: Record<string, readonly CapabilityRequest[]>
  /** The providers the service registered, in registration order. */
  providers: PolicyProfileProvider[]
  service: Record<string, unknown>
}

/** One agent-kernel stand-in: `resolve` reads the live declaration table so a spec can declare per call. */
function kernelStub(): KernelStub {
  const stub: KernelStub = {
    declarations: {},
    providers: [],
    service: {},
  }
  stub.service = {
    capabilities: { resolve: (tool: string) => stub.declarations[tool] },
    registerPolicyProfileProvider: (provider: PolicyProfileProvider) => {
      stub.providers.push(provider)
      return () => {}
    },
  }
  return stub
}

/** Mount the service on a fresh context and return its captured gate listener. */
async function gateHarness(options: {
  config?: NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>
  kernel?: KernelStub
  approval?: boolean
} = {}): Promise<{ ctx: Context; gated: GateHandler }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('no exec') },
    run() { throw new Error('no exec') },
    start() { throw new Error('no exec') },
  })
  if (options.approval === true) {
    await ctx.plugin(ApprovalService)
  } else {
    ctx.provide('approval', { config: { policy: 'ask' } })
  }
  if (options.kernel !== undefined) ctx.provide('agentKernel', options.kernel.service as never)
  let gated: GateHandler | undefined
  const originalOn = ctx.on.bind(ctx) as (...args: never[]) => unknown
  vi.spyOn(ctx, 'on').mockImplementation(((...args: never[]) => {
    const [event, handler] = args as unknown as [string, GateHandler]
    if (event === 'tools/pre-execute') gated = handler
    return originalOn(...args)
  }) as never)
  await ctx.plugin(PermissionPresetService, options.config ?? {})
  if (gated === undefined) throw new Error('permission gate listener not registered')
  return { ctx, gated }
}

const allow = async (): Promise<{ kind: string }> => ({ kind: 'allow' })

describe('permission preset fold', () => {
  it('folds the latest preset selection and steps over unrelated events', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-fold')
    const presetOf = () => ctx.sessionProjections.stateOf(session, 'permissions')?.preset ?? null
    expect(presetOf()).toBeNull()
    session.append('permission/preset', { preset: 'danger-full-access' })
    session.append('permission/preset', { preset: 'workspace-write' })
    expect(presetOf()).toBe('workspace-write')
    // The knob fold steps over non-preset events to the latest selection.
    session.append('sandbox/mode', { mode: 'read-only' })
    expect(presetOf()).toBe('workspace-write')

    const seeded = Session.create(SessionId('sess-fold-seeded'), [])
    expect(ctx.sessionProjections.stateOf(seeded, 'permissions')?.seeded).toBe(true)
  })
})

describe('PermissionPresetService', () => {
  it('does not activate without the required projection registry', async () => {
    const ctx = await mounted({ projection: false })
    expect(ctx.get('permissionPresets')).toBeUndefined()
  })

  it('fails when the permissions projection key is absent', async () => {
    const ctx = await mounted()
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    expect(() => ctx.permissionPresets.current(freshSession('missing-permission-projection-key')))
      .toThrow('permission: permissions session projection is not registered')
  })

  it('advertises the preset table in declaration order and resolves bundles', async () => {
    const ctx = await mounted()
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access', 'accept-edits'])
    expect(ctx.permissionPresets.resolve('danger-full-access')).toMatchObject({ sandbox: 'danger-full-access', approval: 'never' })
    expect(() => ctx.permissionPresets.resolve('plan')).toThrow(/unknown preset "plan"/)
  })

  it('retains a capability policy on its configured preset', async () => {
    const policy = {
      defaults: { effect: 'deny' },
      rules: [{ action: 'read', resource: 'workspace/**', effect: 'allow' }],
    }
    const ctx = await mounted({ config: {
      presets: {
        'read-review': { sandbox: 'workspace-write', approval: 'ask', policy },
      },
    } as never })

    expect(ctx.permissionPresets.resolve('read-review').policy).toEqual(policy)
  })

  it('rejects policy rules outside the shared vocabulary', async () => {
    const invalid = {
      presets: {
        invalid: {
          sandbox: 'workspace-write', approval: 'ask',
          policy: { defaults: { effect: 'allow' }, rules: [{ action: 'evade', resource: '**', effect: 'allow' }] },
        },
      },
    }

    let rejected = false
    try {
      await mounted({ config: invalid as never })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })

  it('supplies the selected policy profile when AgentKernel mounts later', async () => {
    const ctx = await mounted({ config: {
      presets: {
        'read-review': {
          sandbox: 'workspace-write', approval: 'ask',
          policy: { defaults: { effect: 'deny' }, rules: [] },
        },
      },
    } as never })
    await ctx.plugin(AgentKernel, {})
    const session = freshSession('policy-profile-late-kernel')
    ctx.permissionPresets.set(session, 'read-review')

    const task = ctx.agentKernel.intake(
      { id: SessionId('policy-profile-agent'), session } as never,
      { objective: 'test preset policy', agentProfile: 'default', policyProfile: 'default' },
    )

    expect(task.policyProfile).toBe('read-review')
  })

  it('publishes an effect-scoped current-session preset and removes it on unload', async () => {
    const ctx = await mounted()
    const fiber = await mountAuto(ctx)
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access', 'accept-edits', AUTO_PRESET])
    expect(ctx.permissionPresets.resolve(AUTO_PRESET)).toEqual({
      sandbox: 'workspace-write', approval: 'ask',
    })
    expect(ctx.permissionPresets.optionOf(AUTO_PRESET)).toEqual({
      value: AUTO_PRESET,
      name: AUTO_PRESET,
    })

    await fiber.dispose()
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access', 'accept-edits'])
    expect(() => ctx.permissionPresets.resolve(AUTO_PRESET)).toThrow(/unknown preset "auto"/)
  })

  it('rejects a duplicate Auto integration', async () => {
    const ctx = await mounted()
    ctx.permissionPresets.registerAuto(() => {})
    expect(() => ctx.permissionPresets.registerAuto(() => {}))
      .toThrow(/already registered/)
  })

  it('runs Auto admission before any write, including a no-op selection', async () => {
    const ctx = await mounted()
    let admissions = 0
    await mountAuto(ctx, () => { admissions += 1 })
    const session = freshSession('sess-auto-admit')

    ctx.permissionPresets.set(session, AUTO_PRESET)
    expect(admissions).toBe(1)
    // The Auto bundle is the composition default's knobs, so the selection
    // writes only its identity.
    expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: AUTO_PRESET }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe(AUTO_PRESET)

    ctx.permissionPresets.set(session, AUTO_PRESET)
    expect(admissions).toBe(2)
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('leaves the session untouched when dynamic admission rejects a selection', async () => {
    const ctx = await mounted()
    await mountAuto(ctx, () => {
      throw new Error('auto review is closing')
    })
    const session = freshSession('sess-auto-closed')
    expect(() => {
      ctx.permissionPresets.set(session, AUTO_PRESET)
    }).toThrow(/closing/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('records a shared-bundle switch between Auto and its matching preset by identity only', async () => {
    const config = { presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    } } satisfies NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>
    const ctx = await mounted({ config })
    await mountAuto(ctx)
    const session = freshSession('shared-bundle-switch')
    ctx.permissionPresets.set(session, AUTO_PRESET)
    const baselineLength = session.snapshotEvents().length

    ctx.permissionPresets.set(session, 'workspace-write')
    expect(session.snapshotEvents().slice(baselineLength).map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'workspace-write' }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')

    ctx.permissionPresets.set(session, AUTO_PRESET)
    expect(session.snapshotEvents().slice(baselineLength + 1).map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: AUTO_PRESET }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe(AUTO_PRESET)
  })

  it('current() derives from the effective knobs: composition defaults hit workspace-write, a switch hits its preset', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-current')
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
  })

  it('a knob state matching no table entry derives custom — a state, not an error', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-custom')
    session.append('sandbox/mode', { mode: 'read-only' })
    expect(ctx.permissionPresets.current(session)).toBe(CUSTOM_PRESET)
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
    expect(() => ctx.permissionPresets.resolve(CUSTOM_PRESET)).toThrow(/unknown preset/)
  })

  it('composition defaults outside the table still derive custom when an explicit new-session default is configured', async () => {
    const ctx = await mounted({
      approvalDefault: 'never',
      config: { defaultPreset: 'workspace-write' },
    })
    const session = freshSession('sess-defaults-custom')
    expect(ctx.permissionPresets.current(session)).toBe(CUSTOM_PRESET)
  })

  it('the fold breaks bundle ties; a stale fold no longer matching falls back to table order', async () => {
    const ctx = await mounted({ config: { presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      agentish: { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    } } })
    const session = freshSession('sess-tie')
    ctx.permissionPresets.set(session, 'agentish')
    expect(ctx.permissionPresets.current(session)).toBe('agentish')
    session.append('approval/policy', { policy: 'never' })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
  })

  it('set() writes through: one preset event plus both knob events', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-set')
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(session.snapshotEvents().map(e => [e.type, e.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
  })

  it('set() to the current preset is a no-op when the knobs already match (clicks are not switches)', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-noop')
    ctx.permissionPresets.set(session, 'workspace-write')
    expect(session.snapshotEvents()).toHaveLength(0)
  })

  it('re-asserting a preset from a drifted (custom) state re-records the choice and repairs the knob', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-drift')
    ctx.permissionPresets.set(session, 'danger-full-access')
    // Re-selecting from a drifted state records the choice and repairs only
    // the changed knob.
    session.append('sandbox/mode', { mode: 'read-only' })
    ctx.permissionPresets.set(session, 'danger-full-access')
    const tail = session.snapshotEvents().slice(4)
    expect(tail.map(e => [e.type, e.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
    ])
  })

  it('rejects composition over a non-confining executor at load', async () => {
    await expect(mounted({ bashDefault: undefined }))
      .rejects.toThrow(/does not confine/)
  })

  it('optionOf() presents shipped labels/descriptions, falls back to the raw key, and fixes custom', async () => {
    const ctx = await mounted()
    expect(ctx.permissionPresets.optionOf('danger-full-access')).toEqual({ value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access without approval prompts.' })
    expect(ctx.permissionPresets.optionOf('custom')).toEqual({ value: 'custom', name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' })
    const bare = await mounted({ config: { presets: { plain: { sandbox: 'workspace-write', approval: 'ask' } } } })
    expect(bare.permissionPresets.optionOf('plain')).toEqual({ value: 'plain', name: 'plain' })
    expect(() => ctx.permissionPresets.optionOf('plan')).toThrow(/unknown preset/)
  })

  it('rejects a table entry named custom (reserved for the derived state)', async () => {
    await expect(mounted({ config: { presets: { custom: { sandbox: 'read-only', approval: 'ask' } } } }))
      .rejects.toThrow(/reserved for the derived not-a-preset state/)
  })

  it('reserves auto for an integration contribution instead of configured defaults', async () => {
    await expect(mounted({ config: { presets: { auto: { sandbox: 'danger-full-access', approval: 'never' } } } }))
      .rejects.toThrow(/"auto" is reserved/)
  })

  it('requires an explicit default when composition defaults match no preset', async () => {
    await expect(mounted({ approvalDefault: 'never' }))
      .rejects.toThrow(/configure defaultPreset explicitly/)
  })

  it('reads a schema-less approval stand-in as the ask default', async () => {
    const ctx = await mounted({ approvalDefault: undefined })
    const session = freshSession('sess-standin')
    ctx.permissionPresets.set(session, 'workspace-write')
    expect(session.snapshotEvents()).toHaveLength(0)
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
  })
})

describe('new-session default', () => {
  it('rejects persisted Auto before publication when its integration is absent', async () => {
    const ctx = await mounted()
    const source = freshSession('auto-source')
    source.append('permission/preset', { preset: AUTO_PRESET })
    source.append('sandbox/mode', { mode: 'danger-full-access' })
    source.append('approval/policy', { policy: 'never' })

    const id = SessionId('auto-without-integration')
    expect(() => ctx.sessions.create(id, { seed: source.snapshotEvents() })).toThrow(/cannot restore preset "auto"/)
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(source.snapshotEvents().at(-1)).toMatchObject({ type: 'approval/policy' })
  })

  it('admits persisted Auto through the live integration without rewriting it', async () => {
    const ctx = await mounted()
    let admissions = 0
    await mountAuto(ctx, () => { admissions += 1 })
    const source = freshSession('auto-source-present')
    source.append('permission/preset', { preset: AUTO_PRESET })
    source.append('sandbox/mode', { mode: 'danger-full-access' })
    source.append('approval/policy', { policy: 'never' })

    const resumed = ctx.sessions.create(SessionId('auto-with-integration'), { seed: source.snapshotEvents() })
    expect(admissions).toBe(1)
    expect(ctx.permissionPresets.current(resumed)).toBe(AUTO_PRESET)
    expect(resumed.snapshotEvents().filter(event => event.type === 'permission/preset')).toHaveLength(1)
    // A Session recorded under an earlier Auto bundle adopts the current
    // reviewer scope instead of resuming outside it.
    expect(resumed.snapshotEvents().slice(-2).map(event => [event.type, event.data])).toEqual([
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ])
  })

  it('pins the current setting into each new session without changing earlier sessions', async () => {
    const ctx = await mountedStore()
    const first = ctx.sessions.create(SessionId('first'))
    expect(first.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'workspace-write' }],
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ])

    await configurations.get(ctx)!.update({
      defaultPreset: 'danger-full-access',
    })
    expect(ctx.permissionPresets.defaultPreset).toBe('danger-full-access')
    const second = ctx.sessions.create(SessionId('second'))
    expect(ctx.permissionPresets.current(first)).toBe('workspace-write')
    expect(ctx.permissionPresets.current(second)).toBe('danger-full-access')
    expect(second.snapshotEvents().map(event => event.type)).toEqual([
      'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
  })

  it('preserves a seeded legacy session instead of applying the latest user default', async () => {
    const ctx = await mountedStore()
    await configurations.get(ctx)!.update({
      defaultPreset: 'danger-full-access',
    })
    const legacy = freshSession('legacy-source')
    legacy.append('turn/start', { turn: 1 })
    legacy.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const resumed = ctx.sessions.create(SessionId('legacy-resumed'), { seed: legacy.snapshotEvents() })
    expect(ctx.permissionPresets.current(resumed)).toBe('workspace-write')
    expect(resumed.snapshotEvents().slice(-3).map(event => event.type)).toEqual([
      'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
  })

  it('preserves composition defaults when an empty stored session resumes', async () => {
    const ctx = await mountedStore()
    await configurations.get(ctx)!.update({
      defaultPreset: 'danger-full-access',
    })
    const resumed = ctx.sessions.create(SessionId('empty-resumed'), { seed: [] })
    expect(ctx.permissionPresets.current(resumed)).toBe('workspace-write')
    expect(resumed.snapshotEvents().map(event => event.type)).toEqual([
      'session/end-seed', 'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
  })

  it('pins sessions that already exist when the service remounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('permission tests do not execute bash') },
      run() { throw new Error('permission tests do not execute bash') },
      start() { throw new Error('permission tests do not execute bash') },
    })
    ctx.provide('approval', { config: { policy: 'ask' } })
    const existing = ctx.sessions.create(SessionId('existing-before-permission'))
    expect(existing.snapshotEvents()).toEqual([])

    configurations.set(ctx, await liveConfig(ctx, PermissionPresetService))
    expect(existing.snapshotEvents().map(event => event.type)).toEqual([
      'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
    expect(ctx.permissionPresets.current(existing)).toBe('workspace-write')
  })

  it('preserves existing knob overrides when the service remounts over a knob-bearing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('permission tests do not execute bash') },
      run() { throw new Error('permission tests do not execute bash') },
      start() { throw new Error('permission tests do not execute bash') },
    })
    ctx.provide('approval', { config: { policy: 'ask' } })
    const existing = ctx.sessions.create(SessionId('existing-knobs'))
    existing.append('sandbox/mode', { mode: 'read-only' })
    existing.append('approval/policy', { policy: 'never' })

    configurations.set(ctx, await liveConfig(ctx, PermissionPresetService))
    // The remount sweep must read the folded knob events instead of treating
    // the session as fresh; no default preset events may overwrite the
    // overrides (read-only + never matches no preset table entry).
    expect(existing.snapshotEvents().map(event => event.type)).toEqual([
      'sandbox/mode', 'approval/policy',
    ])
    expect(ctx.permissionPresets.current(existing)).toBe(CUSTOM_PRESET)
  })

  it('fills only missing legacy facts and preserves an unmatched seeded combination', async () => {
    const ctx = await mountedStore()
    const partial = freshSession('partial-source')
    partial.append('sandbox/mode', { mode: 'workspace-write' })
    partial.append('approval/policy', { policy: 'ask' })
    const resumed = ctx.sessions.create(SessionId('partial-resumed'), { seed: partial.snapshotEvents() })
    expect(resumed.snapshotEvents().at(-1)).toMatchObject({
      type: 'permission/preset',
      data: { preset: 'workspace-write' },
    })

    const custom = freshSession('custom-source')
    custom.append('sandbox/mode', { mode: 'read-only' })
    custom.append('approval/policy', { policy: 'never' })
    const unmatched = ctx.sessions.create(SessionId('custom-resumed'), { seed: custom.snapshotEvents() })
    expect(ctx.permissionPresets.current(unmatched)).toBe(CUSTOM_PRESET)
    expect(unmatched.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
  })

  it('materializes ask when a legacy seed and approval stand-in omit the policy', async () => {
    const ctx = await mountedStore({ approvalDefault: undefined })
    const partial = freshSession('approval-fallback-source')
    partial.append('sandbox/mode', { mode: 'workspace-write' })
    const resumed = ctx.sessions.create(SessionId('approval-fallback-resumed'), { seed: partial.snapshotEvents() })
    expect(resumed.snapshotEvents().at(-1)).toMatchObject({
      type: 'approval/policy',
      data: { policy: 'ask' },
    })
  })

  it('fails to read a stored default outside the configured preset table until it is repaired', async () => {
    const ctx = await mountedStore()
    await mountAuto(ctx)
    await configurations.get(ctx)!.update({ defaultPreset: AUTO_PRESET })
    expect(() => ctx.permissionPresets.defaultPreset).toThrow(/unknown default preset/)
    await configurations.get(ctx)!.update({ defaultPreset: 'workspace-write' })
    expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write')
  })
})

describe('approval gate (tools/pre-execute producer)', () => {
  it('gates mutating tools and third-party bridges, allows observation tools', () => {
    expect(requiresApproval('bash')).toBe(true)
    expect(requiresApproval('pwsh')).toBe(true)
    expect(requiresApproval('write')).toBe(true)
    expect(requiresApproval('mcp__srv__tool')).toBe(true)
    expect(requiresApproval('schedule_run')).toBe(true)
    expect(requiresApproval('cordis_host_run')).toBe(true)
    expect(requiresApproval('read')).toBe(false)
    expect(requiresApproval('glob')).toBe(false)
    expect(requiresApproval('ask_user_question')).toBe(false)
    expect(requiresApproval('exit_plan_mode')).toBe(false)
    expect(DEFAULT_APPROVAL_TOOLS.length).toBeGreaterThan(0)
  })

  it('gates every current terminal_* tool name that mutates or signals a session', () => {
    // Regression: an earlier list gated the retired `terminal_spawn`/`terminal_kill`
    // names, leaving the current tool-terminal registrations ungated.
    expect(requiresApproval('terminal_open')).toBe(true)
    expect(requiresApproval('terminal_send')).toBe(true)
    expect(requiresApproval('terminal_signal')).toBe(true)
    expect(requiresApproval('terminal_close')).toBe(true)
    expect(requiresApproval('terminal_read')).toBe(false)
    expect(requiresApproval('terminal_list')).toBe(false)
    expect(requiresApproval('terminal_spawn')).toBe(false)
    expect(requiresApproval('terminal_kill')).toBe(false)
  })

  it('gates both the spawn and fork subagent tool names', () => {
    expect(requiresApproval('subagent')).toBe(true)
    expect(requiresApproval('subagent_fork')).toBe(true)
  })

  it('registers a tools/pre-execute listener that asks for gated tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('no exec') },
      run() { throw new Error('no exec') },
      start() { throw new Error('no exec') },
    })
    ctx.provide('approval', { config: { policy: 'ask' } })
    const seen: string[] = []
    const originalOn = ctx.on.bind(ctx) as (...args: never[]) => unknown
    let gated: ((exec: { name: string }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>) | undefined
    vi.spyOn(ctx, 'on').mockImplementation(((...args: never[]) => {
      const [event, handler] = args as unknown as [string, typeof gated]
      if (event === 'tools/pre-execute') gated = handler
      seen.push(event)
      return originalOn(...args)
    }) as never)
    await ctx.plugin(PermissionPresetService, {})
    expect(seen).toContain('tools/pre-execute')
    expect(gated).toBeDefined()
    await expect(gated!({ name: 'bash' }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'ask' })
    await expect(gated!({ name: 'read' }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'allow' })
  })

  it('delegates gated tools for a session standing on danger-full-access', async () => {
    const { ctx, gated } = await gateHarness()
    const session = ctx.sessions.create(SessionId('gate-full-access'))
    ctx.permissionPresets.set(session, 'danger-full-access')
    const agent = { session }
    // The Full access preset must not ask: the `never` policy would
    // deterministically reject the ask and every write would fail.
    await expect(gated({ name: 'write', agent }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'allow' })
    await expect(gated({ name: 'bash', agent }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'allow' })
  })

  it('still asks for a session on a confined sandbox mode', async () => {
    const { ctx, gated } = await gateHarness()
    const session = ctx.sessions.create(SessionId('gate-confined'))
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
    await expect(gated({ name: 'write', agent: { session } }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'ask' })
  })

  it('delegates a gated tool for a live Auto session and asks again after it closes', async () => {
    const { ctx, gated } = await gateHarness()
    const fiber = await mountAuto(ctx)
    const session = ctx.sessions.create(SessionId('gate-auto'))
    ctx.permissionPresets.set(session, AUTO_PRESET)
    const agent = { session }
    // Auto review resolves this exact call through its reviewer, which routes
    // risky work into the same approval service: the gate must not ask twice.
    await expect(gated({ name: 'write', agent }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'allow' })
    await expect(gated({ name: 'bash', agent }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'allow' })

    await fiber.dispose()
    // Without a live reviewer the session returns to the askable workspace
    // preset, so the generic gate owns the decision again.
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
    await expect(gated({ name: 'write', agent }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'ask' })
  })

  it('asks for a session with no pinned sandbox knob (composition default applies)', async () => {
    const { gated } = await gateHarness()
    // A bare session carries no knob events: the gate falls back to the
    // confining composition default and still asks for gated tools.
    const session = freshSession('gate-bare')
    await expect(gated({ name: 'write', agent: { session } }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'ask' })
  })

  /**
   * A plan projection with plan-mode's own key and shape, so a spec governs
   * plan state by appending the same `plan/mode` event the real package logs.
   */
  function planStub(init: Pick<PlanUnitState, 'active' | 'wanted'> = { active: false, wanted: null }) {
    return {
      key: 'plan',
      stateVersion: 1,
      stateSchema: zod.object({
        active: zod.boolean(),
        wanted: zod.boolean().nullable(),
        running: zod.null(),
        activeAtLastHeader: zod.boolean().nullable(),
      }) as ZodType<PlanUnitState>,
      init: () => ({ ...init, running: null, activeAtLastHeader: null }),
      apply: (state, event) => event.type === 'plan/mode' ? { ...state, active: event.data.active, wanted: null } : state,
      wire: {
        viewSchema: zod.object({ active: zod.boolean(), pending: zod.boolean() }),
        view: state => ({ active: state.active, pending: false }),
      },
    } satisfies ProjectionDefinition<'plan', PlanUnitState>
  }

  it('leaves an in-workspace edit to the next listener and still asks for a shell command', async () => {
    const kernel = kernelStub()
    kernel.declarations.edit = [{ capability: 'fs.edit', resource: 'src/a.ts' }]
    kernel.declarations.bash = [{ capability: 'process.exec', resource: 'pnpm test' }]
    const { ctx, gated } = await gateHarness({ config: { defaultPreset: 'accept-edits' }, kernel })
    const session = ctx.sessions.create(SessionId('layer-accept-edits'))
    expect(ctx.permissionPresets.current(session)).toBe('accept-edits')
    const agent = { session }
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts' }, callId: 'accept-1', agent }, allow))
      .resolves.toMatchObject({ kind: 'allow' })
    // The preset allows edits only: a shell command keeps the gate's ask, and
    // the tool's own sandbox still bounds the path an accepted edit may touch.
    await expect(gated({ name: 'bash', arguments: { command: 'pnpm test' }, callId: 'accept-2', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
  })

  it('stops asking for a resource prefix once a workspace grant is remembered', async () => {
    const kernel = kernelStub()
    kernel.declarations.edit = [{ capability: 'fs.edit', resource: 'src/a.ts' }]
    const { ctx, gated } = await gateHarness({ kernel, approval: true })
    const session = ctx.sessions.create(SessionId('layer-always'))
    session.append('turn/start', { turn: 1 })
    const agent = { session }
    // Two pending calls on the same resource, then one "always" answer each:
    // the second answer is a no-op because the rule is already remembered.
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts' }, callId: 'always-1', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts' }, callId: 'always-2', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-always'))
    const request = (callId: string) => ctx.approval.request({ agent: agent as never, toolName: 'edit', callId: callId as never })
    await expect(request('always-1')).resolves.toBe('allowed-always')
    await expect(request('always-2')).resolves.toBe('allowed-always')
    expect(session.snapshotEvents().filter(event => event.type === 'permission/rules').map(event => event.data))
      .toEqual([{ rules: [{ action: 'edit', resource: 'src/a.ts', scope: 'workspace' }] }])
    expect(ctx.sessionProjections.stateOf(session, 'permissions')?.rules)
      .toEqual([{ action: 'edit', resource: 'src/a.ts', scope: 'workspace' }])
    // The granted prefix runs without a second prompt; a sibling path still asks.
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts' }, callId: 'always-3', agent }, allow))
      .resolves.toMatchObject({ kind: 'allow' })
    kernel.declarations.edit = [{ capability: 'fs.edit', resource: 'src/b.ts' }]
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/b.ts' }, callId: 'always-4', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
  })

  it('covers only the granted resource for a session-scoped grant', async () => {
    const kernel = kernelStub()
    kernel.declarations.edit = [{ capability: 'fs.edit', resource: 'src/a.ts' }]
    const { ctx, gated } = await gateHarness({ kernel, approval: true })
    const session = ctx.sessions.create(SessionId('layer-session'))
    session.append('turn/start', { turn: 1 })
    const agent = { session }
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts' }, callId: 'session-1', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-session'))
    await expect(ctx.approval.request({ agent: agent as never, toolName: 'edit', callId: 'session-1' as never })).resolves.toBe('allowed-session')
    expect(session.snapshotEvents().filter(event => event.type === 'permission/rules').map(event => event.data))
      .toEqual([{ rules: [{ action: 'edit', resource: 'src/a.ts', scope: 'session' }] }])
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts' }, callId: 'session-2', agent }, allow))
      .resolves.toMatchObject({ kind: 'allow' })
    kernel.declarations.edit = [{ capability: 'fs.edit', resource: 'src/a.ts.bak' }]
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts.bak' }, callId: 'session-3', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
  })

  it('reports a scoped grant it cannot remember and returns the outcome unchanged', async () => {
    // No agent kernel, so the call declares no resource to remember a rule for.
    const { ctx } = await gateHarness({ approval: true })
    const session = ctx.sessions.create(SessionId('layer-unarmed'))
    session.append('turn/start', { turn: 1 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-always'))
    await expect(ctx.approval.request({ agent: { session } as never, toolName: 'bash', callId: 'unarmed-1' as never }))
      .resolves.toBe('allowed-always')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no rememberable scope'))
    expect(session.snapshotEvents().some(event => event.type === 'permission/rules')).toBe(false)
  })

  it('refuses to remember a resource that is itself a selector', async () => {
    const kernel = kernelStub()
    kernel.declarations.bash = [{ capability: 'process.exec', resource: 'rm *.tmp' }]
    const { ctx, gated } = await gateHarness({ kernel, approval: true })
    const session = ctx.sessions.create(SessionId('layer-selector'))
    session.append('turn/start', { turn: 1 })
    const agent = { session }
    await expect(gated({ name: 'bash', arguments: { command: 'rm *.tmp' }, callId: 'selector-1', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-always'))
    await expect(ctx.approval.request({ agent: agent as never, toolName: 'bash', callId: 'selector-1' as never }))
      .resolves.toBe('allowed-always')
    // A `*` in the granted resource has no escaped form in the rule vocabulary,
    // so remembering it would widen the rule past what the human granted.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is itself a selector'))
    expect(session.snapshotEvents().some(event => event.type === 'permission/rules')).toBe(false)
  })

  it('denies a mutation while plan mode governs and publishes the same layer to the kernel', async () => {
    const kernel = kernelStub()
    kernel.declarations.write = [{ capability: 'fs.write', resource: 'src/a.ts' }]
    const { ctx, gated } = await gateHarness({ kernel })
    ctx.sessionProjections.register(planStub())
    const session = ctx.sessions.create(SessionId('layer-plan'))
    const agent = { session }
    await expect(gated({ name: 'write', arguments: { file_path: 'src/a.ts' }, callId: 'plan-1', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
    session.append('plan/mode', { active: true })
    await expect(gated({ name: 'write', arguments: { file_path: 'src/a.ts' }, callId: 'plan-2', agent }, allow))
      .resolves.toMatchObject({ kind: 'deny', reason: expect.stringContaining('denies write "**"') as string })
    // The kernel reads the same composed layer through the policy profile seam.
    const provider = kernel.providers[0]
    expect(provider?.resolve(session)?.document).toEqual({
      defaults: { effect: 'allow' },
      rules: [
        { action: 'write', resource: '**', effect: 'deny' },
        { action: 'edit', resource: '**', effect: 'deny' },
        { action: 'shell', resource: '**', effect: 'deny' },
      ],
    })
    session.append('plan/mode', { active: false })
    expect(provider?.resolve(session)?.document).toBeUndefined()
    await expect(gated({ name: 'write', arguments: { file_path: 'src/a.ts' }, callId: 'plan-3', agent }, allow))
      .resolves.toMatchObject({ kind: 'ask' })
  })

  it('applies the plan layer from a selection that has not been logged yet', async () => {
    const kernel = kernelStub()
    kernel.declarations.write = [{ capability: 'fs.write', resource: 'src/a.ts' }]
    const { ctx, gated } = await gateHarness({ kernel })
    ctx.sessionProjections.register(planStub({ active: false, wanted: true }))
    const session = ctx.sessions.create(SessionId('layer-plan-pending'))
    // A selection awaits the next accepted pre-step; the guidance already
    // governs the step, so the layer does too.
    await expect(gated({ name: 'write', arguments: { file_path: 'src/a.ts' }, callId: 'pending-1', agent: { session } }, allow))
      .resolves.toMatchObject({ kind: 'deny' })
  })

  it('appends the remembered rules after the selected preset’s own rules', async () => {
    const kernel = kernelStub()
    kernel.declarations.edit = [{ capability: 'fs.edit', resource: 'src/a.ts' }]
    const { ctx, gated } = await gateHarness({ kernel })
    const session = ctx.sessions.create(SessionId('layer-composed'))
    // A session-scoped rule for the same resource, then reads through the
    // provider: the preset's rules stay first and the rule follows them.
    session.append('permission/rules', { rules: [{ action: 'edit', resource: 'src/a.ts', scope: 'session' }] })
    ctx.permissionPresets.set(session, 'accept-edits')
    const provider = kernel.providers.length > 0 ? kernel.providers[0] : undefined
    // The provider registers only when a kernel is provided, which this harness
    // does; read the selection it resolves for the session.
    expect(provider).toBeDefined()
    expect(provider!.resolve(session)?.document?.rules).toEqual([
      { action: 'edit', resource: '**', effect: 'allow' },
      { action: 'write', resource: '**', effect: 'allow' },
      { action: 'edit', resource: 'src/a.ts', effect: 'allow' },
    ])
    await expect(gated({ name: 'edit', arguments: { file_path: 'src/a.ts' }, callId: 'composed-1', agent: { session } }, allow))
      .resolves.toMatchObject({ kind: 'allow' })
  })

  it('rejects a planModePolicy rule outside the shared policy vocabulary at load', async () => {
    await expect(gateHarness({ config: {
      planModePolicy: { defaults: { effect: 'allow' }, rules: [{ action: 'write', resource: '', effect: 'deny' }] },
    } as never })).rejects.toThrow(/\$\.planModePolicy/)
  })
})

describe('capability action families', () => {
  it('agrees with the kernel on the family every capability selects', async () => {
    // The kernel keeps its capability-to-family table private, so this package
    // projects it to decide the session layer at the gate. The kernel's own
    // evaluation is the authority this spec asserts against: one allow rule per
    // family on a shared resource makes the last matching rule index name the
    // family the kernel assigns the capability.
    const kernelCtx = new Context()
    await kernelCtx.plugin(AgentKernel, {
      policy: { defaults: { effect: 'deny' }, rules: POLICY_ACTIONS.map(action => ({ action, resource: 'probe', effect: 'allow' as const })) },
    })
    const kernelFamily = (capability: Capability): string | undefined => {
      const decision = kernelCtx.agentKernel.policy.evaluate({
        action: { toolName: 'probe' },
        capabilities: [{ capability, resource: 'probe' }],
        undeclared: false,
        sandbox: {},
      } as never)
      return decision.matchedRuleIndex === null ? undefined : POLICY_ACTIONS[decision.matchedRuleIndex]
    }

    const kernel = kernelStub()
    const { ctx, gated } = await gateHarness({ kernel, config: {
      defaultPreset: 'probe',
      approvalTools: ['probe'],
      presets: {
        probe: {
          sandbox: 'workspace-write',
          approval: 'ask',
          policy: { defaults: { effect: 'ask' }, rules: POLICY_ACTIONS.map(action => ({ action, resource: action, effect: 'allow' })) },
        },
      },
    } as never })
    const session = ctx.sessions.create(SessionId('families'))
    for (const capability of CAPABILITY_VOCABULARY) {
      kernel.declarations.probe = [{ capability, resource: 'read' }]
      const allowed: string[] = []
      for (const action of POLICY_ACTIONS) {
        kernel.declarations.probe = [{ capability, resource: action }]
        const decision = await gated({ name: 'probe', callId: `family-${capability}`, agent: { session } }, allow)
        if (decision.kind === 'allow') allowed.push(action)
      }
      expect(allowed).toEqual([kernelFamily(capability)])
    }
  })
})

/** Package-owned permission-preset event invariants. @module @deepseek-ai/dsh-permission-presets/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { POLICY_ACTIONS } from '@deepseek-ai/dsh-agent-kernel'
import { AUTO_PRESET } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-permission-presets'

/** Cordis companion plugin name. */
export const name = 'permission-presets-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(ctx: Context, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'permission/preset'
    && event.data.preset !== AUTO_PRESET
    && !ctx.permissionPresets.names.includes(event.data.preset)) {
    fail(`permission/preset names unknown preset ${JSON.stringify(event.data.preset)}`)
  }
  if (event.type === 'permission/rules') {
    for (const rule of event.data.rules) {
      // The log is a durable boundary: a rule whose action left the kernel's
      // vocabulary, or whose resource is itself a selector, would silently
      // widen or stop matching after a reload.
      if (!POLICY_ACTIONS.includes(rule.action)) {
        fail(`permission/rules names unknown action ${JSON.stringify(rule.action)}`)
      }
      if (rule.resource === '' || /[*?]/.test(rule.resource)) {
        fail(`permission/rules names a resource that is not a literal: ${JSON.stringify(rule.resource)}`)
      }
    }
  }
}

/** Install validation that loaded and newly appended preset events remain resolvable. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents()) validateEvent(ctx, event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(ctx, event, fail)
  }, { global: true })
}, { inject: ['permissionPresets', 'sessions'] })

/**
 * Register the permission invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

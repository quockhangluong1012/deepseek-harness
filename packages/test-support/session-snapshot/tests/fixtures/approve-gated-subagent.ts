import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'

export const name = 'approve-gated-subagent'

/**
 * Snapshot-only answerer: grant `subagent` once per ask. A scenario that forces
 * a root session to `read-only` puts every gated tool behind the approval gate,
 * and the SDK runtime has no answerer of its own — the request would fail
 * closed before the flow the scenario exists to prove could start.
 */
export function apply(ctx: Context): void {
  ctx.on('approval/request', async (req, next) => (
    req.toolName === 'subagent' ? 'allowed-once' : next()
  ))
}

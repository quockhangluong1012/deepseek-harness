/**
 * Billed-token accounting for a scored run. The token meter owns the pricing
 * fold, so a harvested session is rebuilt into the meter's own `Session` view
 * and measured there; the scorer never recounts text.
 * @module @deepseek-ai/dsh-evolution-scorer/sessions
 */

import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { HarvestedLog } from '@deepseek-ai/dsh-session-snapshot'

/**
 * Measure the billed tokens of one run from its harvested session logs.
 *
 * Each log is parsed by the replay package's fixture reader (the same reader
 * that validated it as a replay source), rebuilt as a `Session`, and measured
 * by the token meter. Every harvested session contributes its own total, so a
 * nested run bills parent and children.
 * @param meter - the host's token meter, normally `ctx.tokenMeter`.
 * @param logs - harvested session logs, parent first.
 * @returns the summed billed tokens; zero for a run that harvested no session.
 */
export function measureRunTokens(meter: TokenMeter, logs: readonly HarvestedLog[]): number {
  let total = 0
  for (const log of logs) {
    const session = Session.create(SessionId(log.id), parseSessionLog(log.content))
    total += meter.measure(session).totalTokens
  }
  return total
}

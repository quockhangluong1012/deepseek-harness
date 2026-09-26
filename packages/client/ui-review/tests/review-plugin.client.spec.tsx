/**
 * The review plugin's browser half on a real cordis Context: it registers the
 * `review` Definition, the keyed Chat renderer, and the `review` dictionary, and
 * all three leave with the plugin fiber. The Definition it registered folds a
 * durable `review/report` and leaves a malformed one with no node to render. The
 * node half stays inert.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  UiConversation,
  type ConversationEventRegistry,
  type ConversationNodeContext,
  type ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

/** One durable review report, as the two review commands record it. */
function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: 'command-1',
    kind: 'code',
    target: '',
    summary: 'One issue found.',
    findings: [{ file: 'a.ts', line: '10', severity: 'high', message: 'boom' }],
    ...overrides,
  }
}

/** One `review/report` log record; a log written by another build may be malformed. */
function recorded(data: unknown): SessionEvent<'review/report'> {
  return { type: 'review/report', seq: SessionSeq(7), time: 700, data } as SessionEvent<'review/report'>
}

/** The Context the engine hands the Definition for one start Match. */
function context(start: ConversationStartMatch): ConversationNodeContext {
  return { key: 'review:command-1', kind: 'review', id: 'command-1', matches: [start], start, state: undefined, current: new Map() }
}

/** Client faces the browser half injects, with the plugin fiber already running. */
async function boot(): Promise<{
  ctx: Context
  events: ConversationEventRegistry
  translate: (key: string) => string
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('sessions', new TestSessions(async (action) => { await action() }, ctx))
  const events = new UiConversation(ctx, ctx.sessions).events
  // The locale service the browser half injects, provided directly: the
  // ui-locale plugin itself stays pending without a `settings` transport, and
  // this suite asserts the review half, not the locale host's boot.
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.setLocale('zh')
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    events,
    translate: key => locale.bind('review')(key as never),
    dispose: async () => { await fiber.dispose() },
  }
}

describe('ui-review plugin lifecycle', () => {
  it('registers and removes the Definition, keyed renderer, and dictionary with its fiber', async () => {
    const { ctx, events, translate, dispose } = await boot()

    expect(events.entries().map(entry => entry.kind)).toEqual(['review'])
    const renderers = ctx.slots.entries('conversation.chat.node')
    expect(renderers).toHaveLength(1)
    expect(renderers[0]?.options.key).toBe('review')
    expect(renderers[0]?.locale).toBe('review')
    // The dictionary is the panel's only copy, so a resolved key (not the raw
    // key echoed back) is what proves the namespace was registered.
    expect(translate('kind.code')).toBe('代码审查')

    await dispose()
    expect(events.entries()).toEqual([])
    expect(ctx.slots.entries('conversation.chat.node')).toEqual([])
    expect(translate('kind.code')).toBe('kind.code')
  })

  it('folds a registered durable report into one visible Chat node', async () => {
    const { events } = await boot()
    const [definition] = events.entries()
    if (definition === undefined) throw new Error('the plugin registered no Definition')

    const event = recorded(report())
    const claim = definition.match(event)
    if (claim === null) throw new Error('the registered Definition claimed no review/report')
    const start: ConversationStartMatch = { event, role: 'start', location: { kind: 'unresolved' } }
    const folded = context(start)
    const state = definition.start(folded, start, { previous: () => undefined })
    const node = definition.buildViewNode?.({ ...folded, state })
    expect(node).toMatchObject({
      kind: 'review',
      id: 'command-1',
      target: 'chat',
      anchorSeq: 7,
      data: { kind: 'code', summary: 'One issue found.' },
    })
  })

  it('leaves a malformed review/report record with no node to render', async () => {
    const { events } = await boot()
    const [definition] = events.entries()
    if (definition === undefined) throw new Error('the plugin registered no Definition')

    // A finding whose severity no build of this panel understands: the record
    // is claimed (it is a review/report), but the fold refuses, so the engine
    // never adopts a State and the view builder has no start to anchor on.
    const event = recorded(report({ findings: [{ file: 'a.ts', severity: 'critical', message: 'boom' }] }))
    const claim = definition.match(event)
    if (claim === null) throw new Error('the registered Definition claimed no review/report')
    const start: ConversationStartMatch = { event, role: 'start', location: { kind: 'unresolved' } }
    expect(() => definition.start(context(start), start, { previous: () => undefined }))
      .toThrow('review/report carries no complete review report')
    expect(definition.buildViewNode?.({ ...context(start), start: undefined, matches: [] })).toBeNull()
  })

  it('keeps the node half inert', () => {
    // The feature is entirely browser-side, so the Host half has nothing to
    // register: composing the plugin on the Host is a statement and returns.
    nodeApply()
  })
})

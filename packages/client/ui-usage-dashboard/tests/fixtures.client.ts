/**
 * Shared harness for the dashboard specs: a real store instance, a real face
 * over a scripted summary fetch, scripted projections, and the owner props
 * the session panel and the overlay dialog carry.
 */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { act } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { UsageRange, UsageSummary } from '@deepseek-ai/dsh-usage-ledger/types'
import type { UsageDashboardProps } from '../src/client/UsageDashboard.tsx'
import type { DashboardActionProps } from '../src/client/DashboardAction.tsx'
import { usageFace } from '../src/client/face.ts'
import type { UsageInjected } from '../src/client/face.ts'
import type { FetchUsageSummary } from '../src/client/rpc.ts'
import { createUsageDashboardStore } from '../src/client/store.ts'
import type { UsageStore } from '../src/client/store.ts'

/** One summary the Host would return for its range. */
export function summary(range: UsageRange, overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    range,
    totals: { requests: 3, inputTokens: 1300, outputTokens: 500, cacheReadTokens: 260, cacheHitAvg: 0.2 },
    daily: [
      { day: '2026-09-08', requests: 1, inputTokens: 300, outputTokens: 100 },
      { day: '2026-09-09', requests: 2, inputTokens: 1000, outputTokens: 400 },
    ],
    models: [
      { provider: 'deepseek', model: 'deepseek-chat', requests: 3, inputTokens: 1300, outputTokens: 500, cacheHitAvg: 0.2 },
    ],
    ...overrides,
  }
}

/** Empty summary: the window's day frame with zeroed totals. */
export function emptyDay(range: UsageRange): UsageSummary {
  return {
    range,
    totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheHitAvg: 0 },
    daily: [{ day: '2026-09-09', requests: 0, inputTokens: 0, outputTokens: 0 }],
    models: [],
  }
}

/** One failed summary fetch. */
export function failure(code = 'gateway/internal'): RemoteResult<UsageSummary> {
  return { ok: false, error: { code, message: 'boom', details: {} } as unknown as RemoteFailure }
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

/** Key-echoing translate that also shows its parameters. */
export function t(key: string, params?: Record<string, unknown>): string {
  return params === undefined ? key : `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`
}

/** Flush fetches that resolved since the last render, then React's work. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Current-session projection values behind the session panel. */
export interface ProjectionScript {
  usage?: TokenUsageProjection
  stats?: { steps: number }
}

/** What the dashboard harness hands a spec. */
export interface Harness {
  /** The live store instance the overlay reads. */
  instance: ReturnType<UsageStore['create']>
  /** The face bound to the scripted fetch. */
  face: UsageInjected
  /** The scripted summary fetch. */
  fetch: Mock<FetchUsageSummary>
  /** The scripted projections. */
  useProjection: Mock<(key: string) => unknown>
  /** Composed session-panel props (no fetch: the panel reads projections). */
  props: () => UsageDashboardProps
  /** Composed overlay props for the footer action. */
  overlayProps: (wide?: boolean) => DashboardActionProps
  /** Script what one range resolves to from now on. */
  script(range: UsageRange, result: RemoteResult<UsageSummary>): void
  /** Script the session projections for the next render. */
  setProjections(script: ProjectionScript): void
}

/**
 * The dashboard harness.
 * @param script - what each range resolves to; an unscripted range stays pending.
 * @param projections - the session projections behind the session panel.
 * @returns the store, the scripted faces, and props builders.
 */
export function harness(
  script: Partial<Record<UsageRange, RemoteResult<UsageSummary>>> = {},
  projections: ProjectionScript = {
    usage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 },
    stats: { steps: 4 },
  },
): Harness {
  const instance = createUsageDashboardStore().create()
  const results: Partial<Record<UsageRange, RemoteResult<UsageSummary>>> = { ...script }
  const fetch = vi.fn<FetchUsageSummary>((range, _signal) =>
    Promise.resolve(results[range] ?? new Promise<RemoteResult<UsageSummary>>(() => {})))
  const face = usageFace(fetch)(instance.actions)
  const current: { script: ProjectionScript } = { script: projections }
  const useProjection = vi.fn<(key: string) => unknown>((key: string) =>
    key === 'tokenUsage' ? current.script.usage : current.script.stats)
  const props = () => ({
    useProjection,
    t,
  }) as unknown as UsageDashboardProps
  const overlayProps = (wide = true) => ({
    wide,
    useStore: hookOf(instance),
    actions: instance.actions,
    loadSummary: face.loadSummary,
    t,
  }) as unknown as DashboardActionProps
  return {
    instance,
    face,
    fetch,
    useProjection,
    props,
    overlayProps,
    script(range, result) { results[range] = result },
    setProjections(next) { current.script = next },
  }
}

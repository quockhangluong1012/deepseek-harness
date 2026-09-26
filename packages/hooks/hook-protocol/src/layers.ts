/**
 * Layered hook-config discovery shared by both bridges. A bridge names its
 * layers lowest precedence first; this module reads and JSON-parses each one,
 * skips what is absent or broken with a diagnostic, and folds the parsed layer
 * maps into one per-event group table.
 * @module @deepseek-ai/dsh-hook-protocol/layers
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MatcherGroup } from './types.ts'

/** One config layer that exists and parsed: the file path and its parsed JSON. */
export interface HookConfigLayer {
  /** The layer path as the bridge named it. */
  readonly path: string
  /** The layer's parsed JSON, passed to the dialect parser unchanged. */
  readonly raw: unknown
}

/** Whether a filesystem failure means the layer is simply absent. */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Read and JSON-parse hook-config layers in precedence order.
 *
 * A layer that does not exist is skipped silently: an unconfigured layer is
 * normal, and a deployment that mounts the bridge without hooks must still
 * start. A layer that exists but cannot be read or parsed is skipped with a
 * diagnostic through `onDiagnostic`, so one broken file can never hide the
 * layers around it. The same file named by two layers is read once, at its
 * highest-precedence position (paths are compared after resolution), so a
 * `configPath` that repeats a discovered layer cannot run its hooks twice.
 *
 * @param paths - layer paths, lowest precedence first.
 * @param onDiagnostic - sink for each present-but-unusable layer's diagnostic.
 * @returns one entry per layer that parsed, in precedence order.
 */
export function readHookConfigLayers(
  paths: readonly string[],
  onDiagnostic: (message: string) => void,
): HookConfigLayer[] {
  // Re-inserting a seen path moves it to the end, so the surviving entry sits at
  // the highest precedence position the caller gave it.
  const unique = new Map<string, string>()
  for (const path of paths) {
    const absolute = resolve(path)
    unique.delete(absolute)
    unique.set(absolute, path)
  }

  const layers: HookConfigLayer[] = []
  for (const [absolute, path] of unique) {
    let text: string
    try {
      text = readFileSync(absolute, 'utf8')
    } catch (error: unknown) {
      if (isMissingFile(error)) continue
      onDiagnostic(`could not read hook config "${path}": ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      layers.push({ path, raw: JSON.parse(text) })
    } catch (error: unknown) {
      onDiagnostic(`could not parse hook config "${path}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return layers
}

/**
 * Concatenate per-event matcher groups across parsed layers. Layers are given
 * lowest precedence first: the first layer's hooks run first, a later layer
 * appends to them, and no layer removes or replaces another's hooks — so the
 * effective hook set is deterministic for a given set of files.
 * @param layerConfigs - parsed per-event group maps, lowest precedence first.
 * @returns the merged per-event groups (`{}` when no layer configured hooks).
 */
export function mergeMatcherGroups(
  layerConfigs: readonly Record<string, MatcherGroup[]>[],
): Record<string, MatcherGroup[]> {
  const merged: Record<string, MatcherGroup[]> = {}
  for (const config of layerConfigs) {
    for (const [event, groups] of Object.entries(config)) {
      merged[event] = [...merged[event] ?? [], ...groups]
    }
  }
  return merged
}

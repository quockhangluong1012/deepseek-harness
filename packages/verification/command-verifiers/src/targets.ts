/**
 * Resolution of the verifier configuration into one claim table, and the
 * path-scope test the `diff` target uses. Every unusable entry fails the
 * plugin load: a target that could never decide a criterion must not load
 * silently inert.
 *
 * @module @deepseek-ai/dsh-command-verifiers/targets
 */

import picomatch from 'picomatch'
import type { Config } from './index.ts'
import type { ResolvedCommandTarget, ResolvedContractTarget, ResolvedScopeTarget, ResolvedTarget, VerifierEntry } from './types.ts'

/** Entry fields a scope target rejects, each with the test for whether an entry uses it. */
const COMMAND_ONLY_FIELDS: Readonly<Record<'args' | 'cwd' | 'timeoutMs' | 'expectedExitCodes', (entry: VerifierEntry) => boolean>> = {
  args: entry => (entry.args?.length ?? 0) > 0,
  cwd: entry => entry.cwd !== undefined,
  timeoutMs: entry => entry.timeoutMs !== undefined,
  expectedExitCodes: entry => (entry.expectedExitCodes?.length ?? 0) > 0,
}

/**
 * Entry fields a contract target rejects: every field that configures a command
 * or a scope target, because a contract target reads both the boundary and the
 * changed scopes from the verification request.
 */
const CONTRACT_INERT_FIELDS: Readonly<Record<'command' | 'args' | 'cwd' | 'timeoutMs' | 'expectedExitCodes' | 'expectedPaths', (entry: VerifierEntry) => boolean>> = {
  command: entry => entry.command !== undefined,
  ...COMMAND_ONLY_FIELDS,
  expectedPaths: entry => (entry.expectedPaths?.length ?? 0) > 0,
}

/**
 * Resolve the deployment document into the targets a criterion is looked up in.
 * @param config - the validated plugin configuration.
 * @returns every target keyed by the claim it was declared under.
 * @throws When no target is declared, or one declares fields it cannot use.
 */
export function resolveTargets(config: Config): ReadonlyMap<string, ResolvedTarget> {
  const declared = Object.entries(config.verifiers ?? {})
  if (declared.length === 0) {
    throw new Error('command-verifiers: verifiers must declare at least one target, or this deployment answers no criterion')
  }
  const targets = new Map<string, ResolvedTarget>()
  for (const [claim, entry] of declared) {
    if (claim.trim().length === 0) {
      throw new Error('command-verifiers: a verifier target declares an empty claim')
    }
    targets.set(claim, resolveEntry(claim, entry))
  }
  return targets
}

/**
 * Resolve one entry into a command, scope, or contract target. The
 * configuration schema materializes an absent array as `[]`, so kind is read
 * from `command`, from `contract === true`, and from a non-empty
 * `expectedPaths`, never from a field's mere presence.
 * @param claim - the configuration key the entry was declared under.
 * @param entry - the declared fields.
 * @returns the resolved target.
 * @throws When the entry declares more than one target kind, none, or unusable fields.
 */
function resolveEntry(claim: string, entry: VerifierEntry): ResolvedTarget {
  const expectedPaths = entry.expectedPaths ?? []
  if (entry.contract === true) return resolveContractTarget(claim, entry)
  if (entry.command !== undefined && expectedPaths.length > 0) {
    throw new Error(`command-verifiers: target "${claim}" declares command and expectedPaths together; a target runs a command or checks scopes, never both`)
  }
  if (entry.command !== undefined) return resolveCommandTarget(claim, entry, entry.command)
  if (expectedPaths.length > 0) return resolveScopeTarget(claim, entry, expectedPaths)
  throw new Error(`command-verifiers: target "${claim}" declares neither a command, a non-empty expectedPaths, nor contract: true`)
}

/**
 * Resolve one command target, requiring every field its command needs.
 * @param claim - the configuration key the entry was declared under.
 * @param entry - the declared fields.
 * @param command - the declared command line, non-empty.
 * @returns the resolved command target.
 * @throws When the command line, ceiling, or accepted exit codes are unusable.
 */
function resolveCommandTarget(claim: string, entry: VerifierEntry, command: string): ResolvedCommandTarget {
  if (command.trim().length === 0) {
    throw new Error(`command-verifiers: target "${claim}" declares an empty command`)
  }
  if (entry.cwd !== undefined && entry.cwd.trim().length === 0) {
    throw new Error(`command-verifiers: target "${claim}" declares an empty cwd`)
  }
  const { timeoutMs, expectedExitCodes } = entry
  if (timeoutMs === undefined || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`command-verifiers: target "${claim}" needs a positive integer timeoutMs, got ${JSON.stringify(timeoutMs)}`)
  }
  if (expectedExitCodes === undefined || expectedExitCodes.length === 0 || expectedExitCodes.some(code => !Number.isInteger(code))) {
    throw new Error(`command-verifiers: target "${claim}" needs a non-empty expectedExitCodes list of integers, got ${JSON.stringify(expectedExitCodes)}`)
  }
  return {
    kind: 'command',
    claim,
    command: [command, ...entry.args ?? []].join(' '),
    timeoutMs,
    expectedExitCodes: [...expectedExitCodes],
    ...entry.cwd === undefined ? {} : { cwd: entry.cwd },
  }
}

/**
 * Resolve one scope target, rejecting the command fields it would ignore.
 * @param claim - the configuration key the entry was declared under.
 * @param entry - the declared fields.
 * @param expectedPaths - the declared globs.
 * @returns the resolved scope target.
 * @throws When a command-only field accompanies the globs, or a glob is empty.
 */
function resolveScopeTarget(claim: string, entry: VerifierEntry, expectedPaths: readonly string[]): ResolvedScopeTarget {
  const inert = Object.entries(COMMAND_ONLY_FIELDS).find(([, used]) => used(entry))?.[0]
  if (inert !== undefined) {
    throw new Error(`command-verifiers: target "${claim}" declares ${inert} beside expectedPaths, but a scope target runs no command`)
  }
  if (expectedPaths.some(path => path.trim().length === 0)) {
    throw new Error(`command-verifiers: target "${claim}" needs at least one non-empty expectedPaths glob`)
  }
  return { kind: 'scopes', claim, expectedPaths: [...expectedPaths] }
}

/**
 * Resolve one contract target, rejecting the command and scope fields it would
 * ignore.
 * @param claim - the configuration key the entry was declared under.
 * @param entry - the declared fields.
 * @returns the contract target.
 * @throws When the entry declares a field a contract target does not read.
 */
function resolveContractTarget(claim: string, entry: VerifierEntry): ResolvedContractTarget {
  const inert = Object.entries(CONTRACT_INERT_FIELDS).find(([, used]) => used(entry))?.[0]
  if (inert !== undefined) {
    throw new Error(`command-verifiers: target "${claim}" declares ${inert} beside contract, but a contract target reads the declared change contract and the changed scopes from the verification request`)
  }
  return { kind: 'contract', claim }
}

/**
 * Whether one changed scope lies inside a target's expected paths.
 * @param scope - one path the task changed, relative to the session working directory.
 * @param expectedPaths - the target's declared globs.
 * @returns true when at least one glob selects the scope.
 */
export function withinExpectedPaths(scope: string, expectedPaths: readonly string[]): boolean {
  const normalized = scope.replaceAll('\\', '/')
  return expectedPaths.some(glob => picomatch.isMatch(normalized, glob, { dot: true }))
}

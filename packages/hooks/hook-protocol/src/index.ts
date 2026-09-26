/**
 * Shared, non-plugin hook protocol library: matching, command and HTTP
 * execution and decoding, restrictive outcome merging, durable event helpers,
 * layered config discovery, the run-level halt, and detached run quiescence.
 * Claude Code and Codex bridges own their distinct payloads, environment rules,
 * matcher mode, and typed extension-point mappings.
 * @module @deepseek-ai/dsh-hook-protocol
 */

export type {
  CommandHook,
  HookDialect,
  HookHandler,
  HookOutput,
  HookRequestPatch,
  HttpHook,
  MatcherGroup,
  MatcherMode,
} from './types.ts'
export { matcherDiagnostic, matchesMatcher } from './matcher.ts'
export { parseHookBody, parseHookOutput } from './codec.ts'
export { DEFAULT_HOOK_TIMEOUT_MS, isHttpHook, runHook } from './runner.ts'
export type { RunHookOptions, RunHookResult } from './runner.ts'
export { mergeHookOutputs } from './merge.ts'
export type { MergedDecision, MergedHookOutcome } from './merge.ts'
export { classifyHookOutput, UNTRUSTED_HOOK_CONTEXT_NOTICE } from './contribution.ts'
export type { HookContribution, HookContributionKind } from './contribution.ts'
export { appendHookInvoked, appendHookResult, DEFAULT_STDERR_SUMMARY_MAX_CHARS, summarizeStderr } from './events.ts'
export type { HookInvocation, HookResultRecord } from './events.ts'
export { mergeMatcherGroups, readHookConfigLayers } from './layers.ts'
export type { HookConfigLayer } from './layers.ts'
export { applyRunHalt } from './halt.ts'
export type { HaltableRun } from './halt.ts'
export { createDetachedRuns } from './detached.ts'
export type { DetachedRuns } from './detached.ts'

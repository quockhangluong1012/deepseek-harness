/**
 * One benchmark task turned into a run, and one run folded into the numbers
 * §13.5 measures. A dataset task is a definition with no recorded session and
 * no expected output, so the runner supplies the input script and the caller
 * supplies the wiring: {@link taskScript} is the one place a task's text
 * becomes the prompt a fresh process answers, and {@link runFacts} folds that
 * process's harvested sessions through the folds that already own each counter
 * — the kernel's own metrics for steps, task closure, failures, and recoveries,
 * and the token meter's own context-pressure projection for how much of the
 * context window the run's requests occupied.
 *
 * Nothing here decides whether a task passed: that verdict is the scorer's
 * workspace comparison, applied by the store's `run` pass.
 * @module @deepseek-ai/dsh-evolution-benchmark/run
 */

import { readKernelMetrics } from '@deepseek-ai/dsh-agent-kernel'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { HarvestedLog, InputScript } from '@deepseek-ai/dsh-session-snapshot'
import { contextPressureOf, CONTEXT_PRESSURE_INPUT } from './pressure.ts'
import type { BenchmarkTask } from './types.ts'

/**
 * The input script one task runs as: initialize, open a session, and send the
 * task text as the session's one prompt. A task definition carries no scripted
 * waits or permission answers, so this is the whole script a benchmark run
 * needs; a caller whose task requires either wraps its runner.
 * @param task - the task definition being executed.
 * @returns the recorded-shape input script the runner boots.
 */
export function taskScript(task: Pick<BenchmarkTask, 'task'>): InputScript {
  return {
    steps: [
      { op: 'initialize' },
      { op: 'newSession' },
      { op: 'prompt', text: task.task },
    ],
  }
}

/** What one run's harvested sessions record for the §13.5 axes. */
export interface RunFacts {
  /** Model steps the run started (`step/start`). */
  steps: number
  /** Verifications the run recorded. */
  verifications: number
  /** Verifications that passed. */
  verificationsPassed: number
  /** Tasks the run closed in any terminal status. */
  tasksClosed: number
  /** Tasks the run completed. */
  tasksCompleted: number
  /** Failures the run recorded. */
  failures: number
  /** Failures a recovery decision answered. */
  failuresAnswered: number
  /** Highest prompt-side context occupancy any of the run's requests reported; null when none reported usage. */
  contextTokens: number | null
  /** Context window the run's requests reported; null when none reported one. */
  contextWindow: number | null
}

/**
 * Fold one run's harvested sessions into the §13.5 axes. The kernel counters
 * come from `readKernelMetrics` over the same events, so a counter the kernel
 * owns is read rather than recomputed; a nested run bills every session it
 * harvested, parent first. A caller folding one attempt's logs gets one run's
 * facts, which is the scope every outcome field is documented with.
 * @param logs - the harvested session logs of the run being folded, parent first.
 * @returns the facts the run's own record implies.
 */
export function runFacts(logs: readonly HarvestedLog[]): RunFacts {
  let steps = 0
  let verifications = 0
  let verificationsPassed = 0
  let tasksClosed = 0
  let tasksCompleted = 0
  let failures = 0
  let failuresAnswered = 0
  let contextTokens: number | null = null
  let contextWindow: number | null = null
  for (const log of logs) {
    const events = parseSessionLog(log.content)
    const kernel = readKernelMetrics(events)
    steps += kernel.steps
    verifications += kernel.verifications
    verificationsPassed += kernel.verificationsPassed
    tasksClosed += Object.values(kernel.taskOutcomes).reduce((total, count) => total + count, 0)
    tasksCompleted += kernel.taskOutcomes.completed ?? 0
    const recorded = Object.values(kernel.failuresByKind).reduce((total, count) => total + count, 0)
    failures += recorded
    failuresAnswered += recorded - kernel.failuresWithoutRecovery
    const pressure = contextPressureOf(events)
    if (pressure === undefined) continue
    if (contextTokens === null || pressure.peakTokens > contextTokens) contextTokens = pressure.peakTokens
    if (pressure.contextWindow !== null) contextWindow = pressure.contextWindow
  }
  return {
    steps,
    verifications,
    verificationsPassed,
    tasksClosed,
    tasksCompleted,
    failures,
    failuresAnswered,
    contextTokens,
    contextWindow,
  }
}

/** The read paths the §13.5 facts come from, cited by the readings built on them. */
export const RUN_FACTS_INPUT: readonly string[] = [
  'ctx.evolutionBenchmark.outcomes(): BenchmarkOutcome.steps / tasksClosed / tasksCompleted / failures / failuresAnswered',
  CONTEXT_PRESSURE_INPUT,
]

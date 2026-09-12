/**
 * The process-level scoring runner: the snapshot harness's ACP `runScenario`,
 * which spawns one fresh agent subprocess per call and returns the captured
 * stdout, harvested session logs, and both workspace captures. Scoring never
 * boots it in record mode, so no fixture is ever written.
 * @module @deepseek-ai/dsh-evolution-scorer/runner
 */

import { runScenario } from '@deepseek-ai/dsh-session-snapshot'
import type { ScenarioRunner } from './types.ts'

/** Fresh-process scenario runner a composition passes to the scorer's `score`. */
export const processScenarioRunner: ScenarioRunner = runScenario

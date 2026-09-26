/**
 * The §5.3 baseline datasets: authorable task definitions a runner enumerates
 * and admits into the benchmark store. One JSON file per scenario family under
 * the package's `datasets/` directory, named by the family it holds, listing
 * the tasks of that family with the profile and step horizon each exercises.
 *
 * A fixture is a task definition, never a run: it carries no expected output,
 * so an outcome needs a live-model run, and the runner supplies the workspace a
 * coding task mutates and the case material a mentor/ICT task analyses. The
 * acceptance statement names the observable such a run is judged against.
 * @module @deepseek-ai/dsh-evolution-benchmark/src/dataset
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { TaskFamily } from '@deepseek-ai/dsh-evolution-curriculum'
import type { BenchmarkInput } from './types.ts'

/** Step horizons §13.5 requires the long-horizon dataset to span. */
export const HORIZON_TIERS = [10, 20, 50, 100] as const

/** One step horizon from {@link HORIZON_TIERS}; 100 is the open-ended 100+ tier. */
export type HorizonTier = (typeof HORIZON_TIERS)[number]

/** File-name suffix of one dataset file. */
const DATASET_SUFFIX = '.json'

/** One task definition inside a dataset file. */
const datasetTaskRow = z.object({
  profile: z.enum(['coding', 'research', 'mentor', 'ict']),
  stepSpan: z.number().int().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  acceptance: z.string().min(1),
})

/**
 * One dataset file's body. The family comes from the file name, so it is not
 * repeated inside the file: one declaration cannot disagree with itself.
 */
const datasetFileRow = z.object({
  runRequirement: z.literal('live-model'),
  tasks: z.array(datasetTaskRow).min(1),
})

/** The family vocabulary, read from the file name at the file boundary. */
const taskFamilyRow = z.enum(['coding', 'research', 'mentor-ict', 'long-horizon', 'loop-recovery'])

/** One task definition as a dataset file declares it. */
export type DatasetTask = z.infer<typeof datasetTaskRow>

/** One enumerable dataset. */
export interface BenchmarkDataset {
  /** §5.3 scenario family, from the file name. */
  family: TaskFamily
  /** How an outcome is obtained; every shipped dataset is definitions, so a run must call a model. */
  runRequirement: 'live-model'
  /** The family's task definitions, in file order. */
  tasks: readonly DatasetTask[]
}

/**
 * The highest horizon tier a step span satisfies, or undefined below the
 * lowest tier: a span of 30 satisfies the 20-step tier, and 100 or more
 * satisfies the 100+ tier. A tier is a floor rather than a bucket, so a task
 * bounded at 20 steps is not counted as needing 50.
 * @param stepSpan - minimum steps a run of the task should exercise.
 * @returns the tier reached, or undefined when the span reaches none.
 */
export function horizonTier(stepSpan: number): HorizonTier | undefined {
  const tiers: readonly HorizonTier[] = HORIZON_TIERS
  return [...tiers].reverse().find(tier => stepSpan >= tier)
}

/**
 * Enumerate every dataset under one root and validate it: each JSON file is
 * one family, named by that family, holding at least one complete task
 * definition. An unreadable file, an unknown family name, or a task missing a
 * field fails loudly, because a dataset backs evaluation decisions.
 * @param root - directory holding one JSON file per family.
 * @returns the datasets, ordered by family name.
 */
export async function loadDatasets(root: string): Promise<BenchmarkDataset[]> {
  const names = (await readdir(root)).sort()
  return Promise.all(names.map(async (name) => {
    const body = datasetFileRow.parse(JSON.parse(await readFile(join(root, name), 'utf8')))
    return { family: taskFamilyRow.parse(name.replace(DATASET_SUFFIX, '')), ...body }
  }))
}

/**
 * The admission inputs one or more datasets contribute, each task carrying the
 * family it was enumerated under. A fixture task cites no failure gists and no
 * source sessions, because a dataset task is authored rather than mined from
 * recorded evidence.
 * @param datasets - datasets from {@link loadDatasets}, in any order.
 * @returns the candidate tasks, dataset by dataset and in task order.
 */
export function datasetInputs(datasets: readonly BenchmarkDataset[]): BenchmarkInput[] {
  return datasets.flatMap(dataset => dataset.tasks.map(task => ({
    capability: task.capability,
    task: task.task,
    gists: [],
    sourceSessions: [],
    profile: task.profile,
    family: dataset.family,
    stepSpan: task.stepSpan,
    acceptance: task.acceptance,
  })))
}

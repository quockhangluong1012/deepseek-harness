/**
 * Counterfactual replay over a recorded trace (§16, §17): reconstruct the
 * context each step ran under, restore the artifact's recorded state, run the
 * baseline artifact and the candidate artifact over the same trace, and report
 * where they differ.
 *
 * The recorded tool results are the replay substrate. A tool whose external
 * state is nondeterministic is never re-invoked: the step reads the snapshot
 * the trace already carries, so the same trace always replays to the same
 * outcome with no model, no key, and no process. A call whose result the log
 * recorded no text for has no substrate, so its step is reported unreplayable
 * rather than guessed — and a step that could not be replayed is never
 * reported as unchanged.
 *
 * The artifact's observable effect is the retrieval surface: where the trace
 * recorded a retrieval naming the artifact and returning, the replayed output
 * is the restored artifact body instead of the recorded snapshot. So the
 * comparison answers §16's question at the fidelity the trace supports — which
 * steps the candidate changes, and which steps neither revision reaches.
 * @module @deepseek-ai/dsh-evolution-trace/src/replay
 */

import type {
  ReplayArtifact,
  ReplayCallOutcome,
  ReplayRequest,
  ReplayReport,
  ReplayStepReport,
  TraceStep,
  TraceTurn,
} from './types.ts'

/**
 * Call identities in one turn whose retrieval returned while naming `id`: the
 * calls the artifact's body stands in for.
 * @param turn - the turn being replayed.
 * @param id - artifact identity the retrieval targets.
 * @returns the matching call identities.
 */
function retrievedCalls(turn: TraceTurn, id: string): ReadonlySet<string> {
  return new Set(
    turn.retrievals
      .filter(retrieval => retrieval.ok && retrieval.target === id)
      .map(retrieval => retrieval.callId),
  )
}

/**
 * Resolve one step's calls under one artifact revision. The recorded snapshot
 * gates everything: a call the log recorded no output for resolves to nothing
 * under either revision, because an artifact body standing in for it would be
 * a guess about what the recorded run saw. Only a call that did record output
 * is replaced by the restored body.
 * @param step - the step being resolved.
 * @param retrieved - call identities the artifact's body replaces.
 * @param artifact - the revision to restore.
 * @returns one outcome per call, in call order.
 */
function outcomeOf(step: TraceStep, retrieved: ReadonlySet<string>, artifact: ReplayArtifact): ReplayCallOutcome[] {
  return step.calls.map((call) => {
    if (call.snapshot === null) return { tool: call.name, source: 'missing', output: null }
    if (retrieved.has(call.callId)) return { tool: call.name, source: 'artifact', output: artifact.body }
    return { tool: call.name, source: 'snapshot', output: call.snapshot }
  })
}

/**
 * Report one step's comparison under both artifact revisions.
 * @param turnNumber - owning turn number.
 * @param step - the step being compared.
 * @param baseline - calls the baseline revision's body replaces.
 * @param candidate - calls the candidate revision's body replaces.
 * @param request - the two artifact revisions.
 * @returns the step's report.
 */
function reportStep(
  turnNumber: number,
  step: TraceStep,
  baseline: ReadonlySet<string>,
  candidate: ReadonlySet<string>,
  request: ReplayRequest,
): ReplayStepReport {
  const baselineCalls = outcomeOf(step, baseline, request.baseline)
  const candidateCalls = outcomeOf(step, candidate, request.candidate)
  const unreplayableTools = baselineCalls.filter(call => call.source === 'missing').map(call => call.tool)
  const unreplayable = unreplayableTools.length > 0
  return {
    turn: turnNumber,
    step: step.step,
    context: step.context?.digest ?? null,
    status: unreplayable ? 'unreplayable' : 'replayed',
    unreplayableTools,
    baseline: baselineCalls,
    candidate: candidateCalls,
    differs: !unreplayable && baselineCalls.some((call, index) => call.output !== candidateCalls[index]?.output),
  }
}

/**
 * Replay one recorded trace under a baseline and a candidate artifact revision
 * and compare them step by step (§16, §17). Pure: it reads the trace and the
 * two revisions and writes nothing.
 * @param request - the trace to replay plus the two artifact revisions.
 * @returns the per-step comparison, in trace order.
 */
export function replayTrace(request: ReplayRequest): ReplayReport {
  const steps: ReplayStepReport[] = []
  for (const turn of request.trace.turns) {
    const baseline = retrievedCalls(turn, request.baseline.id)
    const candidate = retrievedCalls(turn, request.candidate.id)
    for (const step of turn.steps) {
      steps.push(reportStep(turn.turn, step, baseline, candidate, request))
    }
  }
  return {
    sessionId: request.trace.sessionId,
    artifact: request.baseline.id,
    baseline: request.baseline.version,
    candidate: request.candidate.version,
    steps,
    snapshotSteps: steps
      .filter(step => step.status === 'replayed' && step.baseline.every(call => call.source === 'snapshot'))
      .map(step => `${step.turn}.${step.step}`),
    changedSteps: steps.filter(step => step.differs).map(step => `${step.turn}.${step.step}`),
    unreplayableSteps: steps.filter(step => step.status === 'unreplayable').map(step => `${step.turn}.${step.step}`),
  }
}

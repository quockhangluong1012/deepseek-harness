/**
 * §10.5's coding lifecycle — UNDERSTAND → MAP → PLAN → CONTRACT → IMPLEMENT →
 * LOCAL VERIFY → REVIEW → REGRESSION → COMPLETE — as one recorded pipeline over
 * a coding task.
 *
 * The lifecycle drives, it does not execute. LOCAL VERIFY is the kernel's
 * completion gate, a failed check returns through the kernel's recovery path,
 * and REVIEW arrives through the {@link IndependentReviewer} port a deployment
 * registers (command-review supplies one). Each entry is appended to the
 * session log as `task/phase`, and the reviewer's structured report as
 * `task/review`, so the pipeline a task ran is reconstructable from its own
 * log and a replay sees the same phases.
 *
 * A deployment decides which phases run, what each phase may spend, and whether
 * the reviewer runs; the resolved configuration is validated once at load
 * ({@link resolveCodingLifecycle}). A phase left out is skipped — the pipeline
 * records its neighbours as adjacent steps and never enters it — and REVIEW is
 * skipped the same way while the reviewer is switched off, because a phase
 * whose implementer does not run is one the task does not traverse.
 *
 * @module @deepseek-ai/dsh-agent-kernel/coding-lifecycle
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { KernelEventData, KernelView, Predicate, TaskClass } from './types.ts'

/** One phase of the coding lifecycle, in the order §10.5 states it. */
export type CodingPhase =
  | 'understand'
  | 'map'
  | 'plan'
  | 'contract'
  | 'implement'
  | 'local-verify'
  | 'review'
  | 'regression'
  | 'complete'

/** Every phase, in the spec's order. */
export const CODING_PHASES: readonly CodingPhase[] = [
  'understand',
  'map',
  'plan',
  'contract',
  'implement',
  'local-verify',
  'review',
  'regression',
  'complete',
]

/** The pipeline's first phase; a deployment's list always starts here. */
const FIRST_PHASE: CodingPhase = 'understand'

/** The pipeline's terminal phase; a deployment's list always ends here. */
const COMPLETE_PHASE: CodingPhase = 'complete'

/** The phase a check that failed returns the task to (§17, §18). */
export const REPAIR_PHASE: CodingPhase = 'implement'

/** The class of work the coding lifecycle drives; every other class runs none. */
const LIFECYCLE_TASK_CLASSES: readonly TaskClass[] = ['coding']

/**
 * Every legal direct edge of the phase machine: the §10.5 chain, plus the
 * repair return a check phase takes when it fails. `complete` has no outgoing
 * edge, so a task that reached the end of the pipeline cannot be moved back
 * into work without a new task.
 */
const LEGAL_PHASE_EDGES: Readonly<Record<CodingPhase, readonly CodingPhase[]>> = {
  understand: ['map'],
  map: ['plan'],
  plan: ['contract'],
  contract: ['implement'],
  implement: ['local-verify'],
  'local-verify': ['review', REPAIR_PHASE],
  review: ['regression', REPAIR_PHASE],
  regression: [COMPLETE_PHASE, REPAIR_PHASE],
  complete: [],
}

/**
 * Whether one phase may follow another in a single step. This answers the
 * direct edge only: the pipeline records just the phases a deployment runs, so
 * two recorded neighbours may be joined by a multi-step path through skipped
 * phases, which {@link resolveCodingLifecycle} validates at load.
 * @param from - phase the task is in.
 * @param to - phase the task would enter.
 * @returns true when the edge is in the legal table.
 */
export function canAdvancePhase(from: CodingPhase, to: CodingPhase): boolean {
  return LEGAL_PHASE_EDGES[from].includes(to)
}

/**
 * Reject an illegal transition before anything is recorded.
 * @param from - phase the task is in.
 * @param to - phase the task would enter.
 * @throws When the edge is not in the legal table.
 */
export function assertPhaseTransition(from: CodingPhase, to: CodingPhase): void {
  if (!canAdvancePhase(from, to)) {
    throw new Error(`agent-kernel: illegal coding-lifecycle transition ${from} -> ${to}`)
  }
}

/** Why the lifecycle entered one phase. */
export type CodingPhaseTrigger =
  /** The first phase of a task's pipeline. */
  | 'lifecycle-started'
  /** The next phase in the chain. */
  | 'phase-advanced'
  /** The repair return a failed check takes. */
  | 'phase-repaired'

/** One lifecycle phase entry, as recorded in the session log. */
export interface CodingPhaseRecord {
  /** Phase the task entered. */
  readonly phase: CodingPhase
  /** Phase the task held before, absent for the task's first entry. */
  readonly from?: CodingPhase
  /** Class of work whose lifecycle the phase belongs to. */
  readonly taskClass: TaskClass
  /** Position of the phase in this deployment's phase list, 1-based. */
  readonly ordinal: number
  /** Why the phase was entered. */
  readonly trigger: CodingPhaseTrigger
  /** What drove the pipeline here: the caller's statement of the work at this seam. */
  readonly detail?: string
  /** Task revision the entry was made against. */
  readonly taskRevision: number
  /** Unix epoch milliseconds the phase was entered. */
  readonly at: number
}

/** One defect the independent reviewer reported. */
export interface CodeReviewFinding {
  /** Path of the file the finding is about, relative to the repository root. */
  readonly file: string
  /** Line number or range the finding is about, when the reviewer named one. */
  readonly line?: string
  /** How much the finding threatens the change. */
  readonly severity: 'high' | 'medium' | 'low'
  /** One sentence describing the defect. */
  readonly message: string
}

/** The independent reviewer's complete structured report. */
export interface CodeReviewReport {
  /** One or two sentences on what the change does and the reviewer's verdict. */
  readonly summary: string
  /** Every defect the reviewer found; empty is a passing review. */
  readonly findings: readonly CodeReviewFinding[]
}

/** The reviewer's report for one REVIEW entry, as recorded in the session log. */
export interface CodeReviewRecord {
  /** What was reviewed: a diff ref, or the empty string for the working tree. */
  readonly ref: string
  /** The reviewer's structured report. */
  readonly report: CodeReviewReport
  /** Task revision the review was made against. */
  readonly taskRevision: number
  /** Unix epoch milliseconds the report settled. */
  readonly at: number
}

/** Everything one independent review run reads. */
export interface CodeReviewRequest {
  /**
   * The agent whose task is reviewed. The reviewer runs as a fresh child of
   * this agent, so it never sees the implementing conversation.
   */
  readonly agent: Agent
  /** Diff ref to review; the empty string reviews the uncommitted working tree. */
  readonly ref: string
  /** The objective the change was supposed to accomplish. */
  readonly objective: string
  /** Cancellation for the review run. */
  readonly signal: AbortSignal
}

/**
 * The independent reviewer the REVIEW phase spawns (§10.6). A deployment
 * supplies one through {@link CodingLifecycle.registerReviewer}; the
 * implementation owns the backend and model, so the review can run on a
 * different route than the implementation it reviews.
 */
export interface IndependentReviewer {
  /**
   * Review one change in a fresh context.
   * @param request - what to review and the agent it belongs to.
   * @returns the reviewer's structured report.
   * @throws When the reviewer did not finish or returned no structured report.
   */
  review(request: CodeReviewRequest): Promise<CodeReviewReport>
}

/** Deployment choices for the coding lifecycle. */
export interface CodingLifecycleConfig {
  /**
   * Phases this deployment runs, in §10.5 order, starting at `understand` and
   * ending at `complete`. A phase left out is skipped. A mutable array here
   * because the configuration schema materializes one; the resolved lifecycle
   * keeps the immutable copy.
   */
  readonly phases?: CodingPhase[]
  /**
   * Step ceiling per phase, counted from that phase's latest entry. A phase
   * that reached its ceiling is not entered again: the task asks a human
   * instead of running the same phase a fourth time.
   */
  readonly budgets?: Readonly<Partial<Record<CodingPhase, number>>>
  /** Whether the REVIEW phase runs, and what it reviews. */
  readonly review?: {
    /**
     * Whether the independent reviewer runs when the pipeline reaches REVIEW.
     * Off by default: a review costs a model call on a fresh context, so a
     * deployment turns it on deliberately.
     */
    readonly enabled?: boolean
    /** Diff ref the reviewer inspects; the empty string reviews the working tree. */
    readonly ref?: string
  }
}

/** Validated lifecycle configuration: the phases, ceilings, and review step in force. */
export interface ResolvedCodingLifecycle {
  /** Phases this deployment runs, in pipeline order. */
  readonly phases: readonly CodingPhase[]
  /** Step ceiling per phase; a phase with no entry is unbounded. */
  readonly budgets: Readonly<Partial<Record<CodingPhase, number>>>
  /** The REVIEW step as this deployment configured it. */
  readonly review: { readonly enabled: boolean; readonly ref: string }
}

/** The default pipeline: every phase §10.5 names, with the reviewer switched off. */
const DEFAULT_PHASES: readonly CodingPhase[] = CODING_PHASES

/**
 * Whether a value is one of the nine phases.
 * @param value - the value to classify.
 * @returns true for a known phase.
 */
function isCodingPhase(value: unknown): value is CodingPhase {
  return typeof value === 'string' && (CODING_PHASES as readonly string[]).includes(value)
}

/**
 * Assert that one phase may follow another through the canonical chain, so a
 * deployment's phase list can skip phases but never reorder them.
 * @param from - the earlier phase in the list.
 * @param to - the later phase in the list.
 * @throws When the chain between them contains no legal edge.
 */
function assertPhasePath(from: CodingPhase, to: CodingPhase): void {
  const start = CODING_PHASES.indexOf(from)
  const end = CODING_PHASES.indexOf(to)
  if (end <= start) {
    throw new Error(`agent-kernel: the coding lifecycle reaches ${to} before ${from}`)
  }
  for (let index = start; index < end; index += 1) {
    const current = CODING_PHASES[index]
    const next = CODING_PHASES[index + 1]
    if (current === undefined || next === undefined) {
      throw new Error(`agent-kernel: the coding lifecycle does not reach ${to} from ${from}`)
    }
    assertPhaseTransition(current, next)
  }
}

/**
 * Validate and materialize a deployment's lifecycle configuration. Every defect
 * is self-contained, so it fails plugin load rather than surfacing as a run
 * that silently skipped a phase.
 * @param config - the configured lifecycle, when the deployment stated one.
 * @returns the lifecycle in force; the spec's complete pipeline when unconfigured.
 * @throws When the phases are empty, repeated, unknown, out of order, or do not
 *   run from `understand` to `complete`; when a budget names a phase the
 *   deployment does not run or is not a positive integer; when the review is
 *   enabled while the pipeline does not include the REVIEW phase; or when an
 *   unknown key is present.
 */
export function resolveCodingLifecycle(config: CodingLifecycleConfig | undefined): ResolvedCodingLifecycle {
  const unknownKeys = Object.keys(config ?? {}).filter(key => key !== 'phases' && key !== 'budgets' && key !== 'review')
  if (unknownKeys.length > 0) {
    throw new Error(`agent-kernel: CodingLifecycleConfig has unknown key(s) ${unknownKeys.join(', ')} — config is { phases, budgets, review }`)
  }
  const configured = config?.phases ?? DEFAULT_PHASES
  if (configured.length === 0) {
    throw new Error('agent-kernel: the coding lifecycle needs at least one phase')
  }
  const phases: CodingPhase[] = []
  for (const phase of configured) {
    if (!isCodingPhase(phase)) {
      throw new Error(`agent-kernel: "${String(phase)}" is not a coding lifecycle phase`)
    }
    if (phases.includes(phase)) {
      throw new Error(`agent-kernel: the coding lifecycle names ${phase} twice`)
    }
    phases.push(phase)
  }
  if (phases[0] !== FIRST_PHASE) {
    throw new Error(`agent-kernel: the coding lifecycle starts at ${FIRST_PHASE}, not ${String(phases[0])}`)
  }
  if (phases[phases.length - 1] !== COMPLETE_PHASE) {
    throw new Error(`agent-kernel: the coding lifecycle ends at ${COMPLETE_PHASE}, not ${String(phases[phases.length - 1])}`)
  }
  for (let index = 0; index < phases.length - 1; index += 1) {
    const from = phases[index]
    const to = phases[index + 1]
    if (from === undefined || to === undefined) continue
    assertPhasePath(from, to)
  }
  const budgets: Partial<Record<CodingPhase, number>> = {}
  for (const [phase, ceiling] of Object.entries(config?.budgets ?? {})) {
    if (!isCodingPhase(phase)) {
      throw new Error(`agent-kernel: "${phase}" is not a coding lifecycle phase`)
    }
    if (!phases.includes(phase)) {
      throw new Error(`agent-kernel: a step ceiling is configured for the ${phase} phase, which this deployment does not run`)
    }
    if (!Number.isInteger(ceiling) || ceiling < 1) {
      throw new Error(`agent-kernel: the ${phase} phase step ceiling must be a positive integer, got ${String(ceiling)}`)
    }
    budgets[phase] = ceiling
  }
  const reviewConfig = config?.review ?? {}
  const unknownReviewKeys = Object.keys(reviewConfig).filter(key => key !== 'enabled' && key !== 'ref')
  if (unknownReviewKeys.length > 0) {
    throw new Error(`agent-kernel: CodingLifecycleConfig.review has unknown key(s) ${unknownReviewKeys.join(', ')} — review is { enabled, ref }`)
  }
  const enabled = reviewConfig.enabled ?? false
  if (enabled && !phases.includes('review')) {
    throw new Error('agent-kernel: the coding lifecycle review is enabled while its phases do not include review')
  }
  if (!enabled && budgets.review !== undefined) {
    throw new Error('agent-kernel: a step ceiling is configured for the review phase while the review is switched off')
  }
  return {
    phases,
    budgets,
    review: { enabled, ref: reviewConfig.ref ?? '' },
  }
}

/** The kernel primitives the lifecycle drives; `AgentKernelService` supplies them. */
export interface CodingLifecycleHost {
  /**
   * The session's current task view.
   * @param session - the session whose task is read.
   * @returns the view, or undefined before task intake.
   */
  view(session: Session): KernelView | undefined
  /**
   * Append one phase entry with the kernel's audit metadata.
   * @param session - the session the entry belongs to.
   * @param record - the entry to append.
   */
  appendPhase(session: Session, record: CodingPhaseRecord): void
  /**
   * Append one reviewer report with the kernel's audit metadata.
   * @param session - the session the report belongs to.
   * @param record - the report to append.
   */
  appendReview(session: Session, record: CodeReviewRecord): void
}

/** One phase whose configured step ceiling is spent, so it is not entered again. */
export interface CodingPhaseBudget {
  /** The phase that reached its ceiling. */
  readonly phase: CodingPhase
  /** The configured step ceiling. */
  readonly budget: number
  /** Steps the phase already spent in its latest occupancy. */
  readonly spent: number
}

/** What driving the pipeline to one phase did. */
export interface PhaseAdvance {
  /** Phases entered, in order; empty when the target was already reached or is not run. */
  readonly entered: readonly CodingPhaseRecord[]
  /**
   * Set when a phase's step ceiling is spent, so the pipeline stopped short of
   * the target. The caller records the failure: refusing the entry and
   * classifying it are separate decisions.
   */
  readonly exhausted?: CodingPhaseBudget
}

/**
 * The coding lifecycle of one kernel deployment. It folds a session's own log
 * for the phase a task is in, records each entry it drives, enforces the
 * per-phase step ceilings, and runs the REVIEW phase's independent reviewer at
 * most once per entry.
 */
export class CodingLifecycle {
  /** The validated lifecycle configuration in force. */
  readonly config: ResolvedCodingLifecycle
  /**
   * The phases the pipeline actually runs: the configured list, less REVIEW when
   * the reviewer is switched off, because a phase whose implementer does not run
   * is one the task does not traverse.
   */
  private readonly pipeline: readonly CodingPhase[]
  private readonly host: CodingLifecycleHost
  private reviewer: IndependentReviewer | undefined

  /**
   * @param host - the kernel primitives the lifecycle drives.
   * @param config - validated lifecycle configuration from {@link resolveCodingLifecycle}.
   */
  constructor(host: CodingLifecycleHost, config: ResolvedCodingLifecycle) {
    this.host = host
    this.config = config
    this.pipeline = config.review.enabled ? config.phases : config.phases.filter(phase => phase !== 'review')
  }

  /**
   * Register the deployment's independent reviewer, the implementation the
   * REVIEW phase spawns.
   * @param reviewer - the reviewer to register.
   * @returns a disposer that removes this reviewer while it remains registered.
   * @throws When a reviewer is already registered.
   */
  registerReviewer(reviewer: IndependentReviewer): () => void {
    if (this.reviewer !== undefined) {
      throw new Error('agent-kernel: an independent reviewer is already registered')
    }
    this.reviewer = reviewer
    return () => {
      if (this.reviewer === reviewer) this.reviewer = undefined
    }
  }

  /**
   * The phases a task of one class runs. Every class but `coding` runs none:
   * a conversational task is not a change to code, so it has no pipeline.
   * @param taskClass - the class the task records, when it records one.
   * @returns the phase list, empty for a class without a lifecycle.
   */
  phasesFor(taskClass: TaskClass | undefined): readonly CodingPhase[] {
    return taskClass !== undefined && LIFECYCLE_TASK_CLASSES.includes(taskClass) ? this.pipeline : []
  }

  /**
   * The phase the task is in, folded from its own log. The latest entry wins,
   * so a repair return reads as the phase the task is working in now.
   * @param session - the session whose log is read.
   * @returns the latest entry, or undefined before the pipeline starts.
   */
  current(session: Session): CodingPhaseRecord | undefined {
    return phaseRecords(session).at(-1)
  }

  /**
   * Record every phase from the task's current one through `target`. A target
   * the task already reached, a target this deployment does not run, and a task
   * class with no lifecycle are no-ops, so a caller may drive the same seam
   * every step without repeating a decision.
   * @param session - the session whose task advances.
   * @param target - the phase the caller wants the task to be at or past.
   * @param detail - why the caller is driving the pipeline now.
   * @returns the entries appended, and the ceiling that stopped the advance when one did.
   */
  advance(session: Session, target: CodingPhase, detail?: string): PhaseAdvance {
    const task = this.host.view(session)?.task
    const taskClass = task?.taskClass
    if (task === undefined || taskClass === undefined) return { entered: [] }
    const phases = this.phasesFor(taskClass)
    if (phases.length === 0) return { entered: [] }
    // The phase the call runs: the first phase at or after `target` that this
    // deployment runs. `complete` is never reached as a side effect, because a
    // pipeline that skipped every phase between still records its completion
    // deliberately.
    const resolved = phases.find(phase =>
      phase === COMPLETE_PHASE
        ? target === COMPLETE_PHASE
        : CODING_PHASES.indexOf(phase) >= CODING_PHASES.indexOf(target),
    )
    if (resolved === undefined) return { entered: [] }
    const current = this.current(session)
    const currentIndex = current === undefined ? -1 : phases.indexOf(current.phase)
    const targetIndex = phases.indexOf(resolved)
    if (currentIndex >= targetIndex) return { entered: [] }
    return this.enter(session, taskClass, task.revision, phases.slice(currentIndex + 1, targetIndex + 1), current?.phase, detail, 'phase-advanced')
  }

  /**
   * Record the repair return a failed check takes: LOCAL VERIFY, REVIEW, or
   * REGRESSION hands the task back to IMPLEMENT. A task already in IMPLEMENT,
   * a class with no lifecycle, and a deployment that does not run IMPLEMENT are
   * no-ops; any other phase refuses, because the phase machine has no edge from
   * it to IMPLEMENT.
   * @param session - the session whose task returns to work.
   * @param detail - why the check failed.
   * @returns the entry appended, and the ceiling that stopped the return when one did.
   * @throws When the current phase has no repair edge to IMPLEMENT.
   */
  repair(session: Session, detail: string): PhaseAdvance {
    const task = this.host.view(session)?.task
    const taskClass = task?.taskClass
    if (task === undefined || taskClass === undefined) return { entered: [] }
    const phases = this.phasesFor(taskClass)
    if (phases.length === 0 || !phases.includes(REPAIR_PHASE)) return { entered: [] }
    const current = this.current(session)
    if (current === undefined || current.phase === REPAIR_PHASE) return { entered: [] }
    assertPhaseTransition(current.phase, REPAIR_PHASE)
    return this.enter(session, taskClass, task.revision, [REPAIR_PHASE], current.phase, detail, 'phase-repaired')
  }

  /**
   * Run the REVIEW phase's independent reviewer for the current entry. The
   * reviewer spawns once per entry: a second call while the task is still in
   * REVIEW answers with the report the log already holds, so a turn that
   * retries its completion attempt does not pay for a second review.
   * @param agent - the agent whose task is reviewed.
   * @param signal - cancellation for the review run.
   * @returns the reviewer's report, or undefined when this deployment does not run the phase.
   * @throws When the task is not in REVIEW, or when the review is enabled and
   *   no independent reviewer is registered.
   */
  async review(agent: Agent, signal: AbortSignal): Promise<CodeReviewReport | undefined> {
    const session = agent.session
    const task = this.host.view(session)?.task
    if (task === undefined) return undefined
    if (!this.config.review.enabled || !this.phasesFor(task.taskClass).includes('review')) return undefined
    if (this.current(session)?.phase !== 'review') {
      throw new Error('agent-kernel: the coding lifecycle REVIEW phase must be entered before it is run')
    }
    // The report belongs to the entry the task is in now: a `task/review`
    // before the latest REVIEW entry answers an earlier review.
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = session.snapshotEvents()
    const entry = events.findLastIndex(event => event.type === 'task/phase' && event.data.phase === 'review')
    const settled = entry < 0
      ? undefined
      : events.slice(entry + 1).filter(event => event.type === 'task/review').map(event => event.data).at(-1)
    if (settled !== undefined) return settled.report
    if (this.reviewer === undefined) {
      throw new Error('agent-kernel: the coding lifecycle review is enabled but no independent reviewer is registered')
    }
    const report = await this.reviewer.review({
      agent,
      ref: this.config.review.ref,
      objective: task.objective,
      signal,
    })
    this.host.appendReview(session, {
      ref: this.config.review.ref,
      report,
      taskRevision: task.revision,
      at: Date.now(),
    })
    return report
  }

  /**
   * The predicate a completion transition records for the lifecycle: whether
   * every phase this deployment runs is in the log.
   * @param session - the session whose task is completing.
   * @returns the precondition, satisfied when the pipeline is complete or the
   *   task's class runs no pipeline.
   */
  completionPredicate(session: Session): Predicate {
    const task = this.host.view(session)?.task
    const phases = this.phasesFor(task?.taskClass)
    if (phases.length === 0) {
      return {
        kind: 'lifecycle-phases',
        satisfied: true,
        detail: `a ${task?.taskClass ?? 'conversational'} task runs no coding lifecycle`,
      }
    }
    const recorded = phaseRecords(session).map(record => record.phase)
    const missing = phases.filter(phase => !recorded.includes(phase))
    return {
      kind: 'lifecycle-phases',
      satisfied: missing.length === 0,
      detail: missing.length === 0
        ? `every phase recorded: ${phases.join(' -> ')}`
        : `no entry recorded for ${missing.join(', ')}`,
    }
  }

  /**
   * Append one entry per phase in `phases`, refusing a phase whose configured
   * ceiling its latest occupancy already spent.
   * @param session - the session whose task advances.
   * @param taskClass - the class of work the pipeline belongs to.
   * @param taskRevision - the contract revision the entries are made against.
   * @param phases - the phases to enter, in pipeline order.
   * @param from - the phase the task held before the first entry, when one did.
   * @param detail - what the caller did to drive the pipeline, when it said.
   * @param trigger - why these phases are entered: the forward chain, or a repair return.
   * @returns the entries appended, and the ceiling that stopped the advance when one did.
   */
  private enter(
    session: Session,
    taskClass: TaskClass,
    taskRevision: number,
    phases: readonly CodingPhase[],
    from: CodingPhase | undefined,
    detail: string | undefined,
    trigger: Exclude<CodingPhaseTrigger, 'lifecycle-started'>,
  ): PhaseAdvance {
    const entered: CodingPhaseRecord[] = []
    let previous = from
    for (const phase of phases) {
      const budget = this.config.budgets[phase]
      if (budget !== undefined) {
        // Steps the phase already spent in its latest occupancy: the
        // `step/start` events its newest entry precedes.
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        const events = session.snapshotEvents()
        let inside = false
        let spent = 0
        for (const event of events) {
          if (event.type === 'task/phase') {
            inside = event.data.phase === phase
            continue
          }
          if (inside && event.type === 'step/start') spent += 1
        }
        if (spent >= budget) {
          // The caller records the ceiling as a failure; the lifecycle only
          // refuses to enter the phase, so one fact is one log record.
          return { entered, exhausted: { phase, budget, spent } }
        }
      }
      const record: CodingPhaseRecord = {
        phase,
        ...previous === undefined ? {} : { from: previous },
        taskClass,
        ordinal: this.pipeline.indexOf(phase) + 1,
        trigger: previous === undefined ? 'lifecycle-started' : trigger,
        ...detail === undefined ? {} : { detail },
        taskRevision,
        at: Date.now(),
      }
      this.host.appendPhase(session, record)
      entered.push(record)
      previous = phase
    }
    return { entered }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One phase entry of the coding lifecycle (§10.5). The fold of these
     * events over `task/created` is the pipeline the task ran, including the
     * repair returns a failed check took. Log-only: it never enters model
     * context.
     */
    'task/phase': KernelEventData<CodingPhaseRecord>
    /**
     * The independent reviewer's structured report for one REVIEW entry
     * (§10.6), recorded after the reviewer settled. Log-only.
     */
    'task/review': KernelEventData<CodeReviewRecord>
  }
}

/**
 * Every phase entry one session recorded, in log order.
 * @param session - the session whose log is read.
 * @returns the records.
 */
function phaseRecords(session: Session): readonly CodingPhaseRecord[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents()
    .filter(event => event.type === 'task/phase')
    .map(event => event.data)
}

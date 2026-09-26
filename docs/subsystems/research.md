# Research

English | [中文](research.zh.md)

The research quality-control loop owned by [`@deepseek-ai/dsh-research-controller`](../../packages/research/research-controller/README.md) (`ctx.research`). One run takes a question through ten ordered stages, keeps every stage's output durable, and settles only when the epistemic review accepts an answer stated in six epistemic buckets. The model states the stages it can state through the `research_advance` tool; search, source triage, and contradiction search are a registered provider's work, and a run that reaches one of them with no provider fails loud instead of skipping the stage. Observations and claims stay the [agent kernel](agent-kernel.md)'s own records — the loop holds their identities and never copies them — so a run's own state is all it stores, in the `research` [storage](storage.md) domain.

Source: [`packages/research/research-controller/src/types.ts`](../../packages/research/research-controller/src/types.ts) · [`packages/research/research-controller/src/stages.ts`](../../packages/research/research-controller/src/stages.ts) · [`packages/research/research-controller/src/pipeline.ts`](../../packages/research/research-controller/src/pipeline.ts)

## The stage loop

`ResearchStage` is the closed union of the loop's ten stages, and `RESEARCH_STAGES` fixes the order they run in. A run advances the first stage that has not produced, so no stage can run out of order or twice in place, and a stage that failed stays the next stage until it produces: a stage is retried by advancing it again, never skipped. A settled run refuses every further advance with `run-settled`, and an advance that names a later stage is refused with `stage-out-of-order`.

```ts type-equiv
/** One stage of the research quality-control loop. */
type ResearchStage =
  | 'question'
  | 'decompose'
  | 'research-plan'
  | 'search'
  | 'source-triage'
  | 'claim-extraction'
  | 'evidence'
  | 'contradiction-search'
  | 'synthesis'
  | 'epistemic-review'
```

`StageDefinition` states each stage's purpose and its `StageProducer`: the agent loop for the seven stages whose output the model states, a registered provider for the three mechanism stages (`PROVIDER_STAGES`: search, source-triage, contradiction-search). `AdvanceInput` carries the stage to advance and only that stage's input — `items` for question, decompose, and research-plan, `claims` for claim-extraction, `sections` for synthesis — and requires nothing from the caller for a provider's stage.

## Durable run record

The controller opens the `research` storage domain (`researchDomainSpec`: name `research`, version 1, layout `per-record`) with one `runs` table keyed by `ResearchRunId`, so runs are independent records rather than one growing document. A field a stage has not filled is stored as `null`, never omitted, so a stored run round-trips exactly; the zod schema shipped with the domain refuses an unreadable run at the durability boundary, because a consumer that read an unsettled answer as settled would trust an answer the review never accepted. A session's oldest settled runs are dropped once the configured retention cap is exceeded.

```ts type-equiv
/** What one stage of one run produced. */
interface StageRecord {
  /** The stage this record belongs to. */
  readonly stage: ResearchStage
  /** How far the stage has got. */
  readonly status: StageStatus
  /** Lines the stage produced, in order. */
  readonly output: readonly string[]
  /** Kernel evidence identities this stage recorded, in order. */
  readonly evidence: readonly string[]
  /** Kernel claim identities this stage asserted, in order. */
  readonly claims: readonly string[]
  /** Identity of the registered provider that performed the stage; `null` for the agent loop's stages. */
  readonly provider: string | null
  /** ISO-8601 instant the stage was first advanced. */
  readonly startedAt: string
  /** ISO-8601 instant the stage settled; `null` while it is pending. */
  readonly settledAt: string | null
  /** Why the stage failed; `null` unless the stage failed. */
  readonly failure: string | null
}
```

```ts type-equiv
/**
 * One research run: the question, every stage's durable state, and the answer
 * the epistemic review accepted.
 */
interface ResearchRunRecord {
  /** Identity of this run. */
  readonly runId: string
  /** Session that owns the run. */
  readonly sessionId: string
  /** Kernel task this run answers to. */
  readonly taskId: string
  /** Class of the kernel task; a research run only starts under a research task. */
  readonly taskClass: TaskClass
  /** The question the run answers. */
  readonly question: string
  /** Every stage of the loop, in order, from run start. */
  readonly stages: readonly StageRecord[]
  /** The answer, once synthesis produced one. */
  readonly answer: ResearchAnswer | null
  /** ISO-8601 instant the run started. */
  readonly startedAt: string
  /** ISO-8601 instant the epistemic review accepted the answer; `null` until then. */
  readonly settledAt: string | null
}
```

`StageStatus` is `pending | produced | failed`, and `failure` names what was missing when a stage settled without output. `answer` is `null` until synthesis states one, and `settledAt` is `null` until the review accepts it. The record's `evidence` and `claims` are kernel identities, so a reader resolves them through the [agent kernel](agent-kernel.md) rather than through this page.

## Stage-provider seam

A mechanism stage's work is a deployment's, so the run waits for the provider registered for it. `stage-provider-missing` is the refusal when the run's next stage is one of them and no provider is registered; a run cannot leave that stage, and it is not skipped.

```ts type-equiv
/**
 * One implementation of a mechanism stage. A provider registered for a stage
 * is the only one: registering a second provider for the same stage is refused.
 */
interface ResearchStageProvider {
  /** Stable identity recorded on every stage this provider performs. */
  readonly id: string
  /** Stages this provider performs. */
  readonly stages: readonly ResearchStage[]
  /**
   * Perform one stage.
   * @param request - the run's question, prior outputs, observations, and claims.
   * @param signal - cancellation of the call that is waiting for this stage.
   * @returns the stage's output and any observations it made.
   */
  run(request: StageRequest, signal: AbortSignal): Promise<StageOutcome>
}
```

`registerStageProvider` refuses a provider that declares no stage, one that claims an agent-loop stage, and one that claims a stage another provider already holds, so each mechanism stage has exactly one implementation. It returns the disposer that removes the provider while it remains registered. The provider receives a `StageRequest` — the run identity, the question, the sub-questions, the plan, and the evidence and claims this run recorded before the stage — and returns a `StageOutcome`: the stage's output lines and optional observations. The controller records every observation through the kernel's own `recordEvidence` and settles the stage with the provider's id.

## Six-bucket answer

`AnswerBucket` is the closed union `documented | observation | interpretation | inference | hypothesis | unresolved`, and `ResearchAnswer` holds one statement list per bucket, which is how the answer keeps documented facts, observations, interpretations, inferences, hypotheses, and unresolved uncertainty distinguishable. Synthesis states the answer through `SectionInput`s, each assigned to one bucket; citing a claim the run never recorded is refused with `claim-missing`.

```ts type-equiv
/** One statement of the final answer, with the claims it rests on. */
interface AnswerStatement {
  /** The statement itself. */
  readonly statement: string
  /** Kernel claim identities the statement rests on. */
  readonly claims: readonly string[]
}
```

```ts type-equiv
/** The final answer: one list per epistemic bucket. */
interface ResearchAnswer {
  /** What sources document, as opposed to what this run inferred. */
  readonly documented: readonly AnswerStatement[]
  /** What this run observed directly. */
  readonly observation: readonly AnswerStatement[]
  /** What an observer made of the observations. */
  readonly interpretation: readonly AnswerStatement[]
  /** What follows from observations and interpretations without being either. */
  readonly inference: readonly AnswerStatement[]
  /** What the run proposes and has not established. */
  readonly hypothesis: readonly AnswerStatement[]
  /** What the run could not settle. */
  readonly unresolved: readonly AnswerStatement[]
}
```

The epistemic review is the run's gate, and its contract is the answer's: an answer that states nothing is refused, a statement outside `unresolved` must rest on at least one claim, and every claim claim-extraction recorded must be stated in some bucket, so a contradicting or unsupported claim cannot disappear between extraction and the answer. A refusal names every violation, records them on the review stage, and fails with `review-rejected`, and advancing synthesis again is the revision that re-opens the review; an accepted answer sets `settledAt` and ends the run.

## ICT case artifact

The case store ([`@deepseek-ai/dsh-case-store`](../../packages/research/case-store/README.md), `ctx.caseStore`) owns the durable artifact of one chart or backtest review. The artifact is exactly the §21 field set, and the schema is strict, so a stored artifact carrying a field outside the list is refused at the durability boundary. Cases live in the `ict_case` [storage](storage.md) domain (name `ict_case`, version 1, layout `per-record`) with one `cases` table keyed by learner id plus case id, so a case is scoped to a learner and outlives the session that produced it.

```ts type-equiv
/** The §21 ICT case-study artifact: exactly the thirteen fields the spec lists, no more. */
interface CaseArtifact {
  /** Instrument the case reviews. */
  readonly symbol: string
  /** Timeframes the case reads, in the order the analysis reads them. */
  readonly timeframes: readonly string[]
  /** Facts read off the chart, separated from every interpretation of them. */
  readonly observations: readonly CaseObservation[]
  /** What the learner asserted. */
  readonly userThesis: readonly CaseThesis[]
  /** References to the evidence the case rests on. */
  readonly evidence: readonly CaseEvidence[]
  /** The agent's audit of the learner's analysis. */
  readonly agentAudit: readonly CaseInterpretation<'audit'>[]
  /** The devil's advocate's critique of the thesis. */
  readonly devilAdvocate: readonly CaseInterpretation<'devil-advocate'>[]
  /** Alternative scenarios the observations admit. */
  readonly alternativeScenarios: readonly CaseInterpretation<'scenario'>[]
  /** What happened, or `null` while the case is unresolved. */
  readonly outcome: CaseOutcome | null
  /** Mistakes the review found. */
  readonly mistakes: readonly CaseFinding[]
  /** Lessons the review drew. */
  readonly lessons: readonly CaseFinding[]
  /** Concepts the case tested. */
  readonly conceptsTested: readonly ConceptId[]
  /** How the case moved the learner per concept. */
  readonly learnerImpact: readonly CaseLearnerImpact[]
}
```

Observations and interpretations stay distinguishable by field and by structure, never by wording. An observation carries what the chart shows, the timeframe it was read from, and the evidence keys it was read from; an interpretation carries the observation identities it reads in `basis` and no timeframe at all. The strict schema refuses an observation that acquired interpretation structure, an interpretation that carries no `basis`, and an interpretation whose `kind` disagrees with the field it is written into, so a reading cannot be stored as an observation and a critique cannot land in `agentAudit`.

```ts type-equiv
/**
 * One directly perceived fact of the chart, with the timeframe it was read
 * from. An observation states what the chart shows; a reading of it is an
 * interpretation and belongs in `agentAudit`, `devilAdvocate`, or
 * `alternativeScenarios`.
 */
interface CaseObservation {
  /** Identity of the observation. */
  readonly observationId: ObservationId
  /** What the chart shows. */
  readonly statement: string
  /** Timeframe the observation was read from. */
  readonly timeframe: string
  /** Bar or session range read, when the observation is bounded to one. */
  readonly barRange?: string | undefined
  /** Evidence the observation was read from; empty when it was read without a recorded evidence item. */
  readonly evidence: readonly EvidenceKey[]
  /** How far the evidence behind the observation may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
  /** ISO-8601 instant the observation was made. */
  readonly observedAt: string
}
```

```ts type-equiv
/**
 * One interpretation of the observations. `kind` names whose reading it is,
 * and the field it is stored in must agree with that kind; `basis` cites the
 * observations it reads, and an empty basis marks an ungrounded reading rather
 * than an observation.
 */
interface CaseInterpretation<K extends InterpretationKind = InterpretationKind> {
  /** Identity of the interpretation. */
  readonly interpretationId: InterpretationId
  /** Whose reading this is. */
  readonly kind: K
  /** What the reading says. */
  readonly statement: string
  /** Observations this reading is drawn from. */
  readonly basis: readonly ObservationId[]
  /** How far the evidence behind the reading may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
  /** ISO-8601 instant of the reading. */
  readonly at: string
}
```

Evidence entries reference content instead of copying it: an item observed inside a session carries the kernel's [evidence](agent-kernel.md) id alone, and one read outside a session carries a locator plus the trust label of wherever that locator points. Every other entry carries its own `trust` label (RUNTIME-SPEC S11), so content derived from untrusted material stays labelled wherever the case is read.

Four read paths serve the consumers the spec names: `forLearnerMemory` returns the review summary a learner record keeps, `forMisconceptionDetection` returns what the learner asserted next to the audit, the critique, and the mistakes found, `forBenchmarkDataset` returns one row per case carrying the whole artifact, and `forMentorIntervention` returns the outcome, the concepts the case exercised, the learner-impact judgements, and the lessons to teach from.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcasestore--casestore"></a>

### `ctx.caseStore` — `CaseStore`

Durable case store over the `ict_case` domain: reads by learner scope and amendments that append one review's entries without touching its siblings. Opens the domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Open a case for one learner, minting its identity and starting every other
 * artifact field empty.
 * @param learnerId - the learner whose scope holds the case.
 * @param input - the symbol and timeframes the case opens with.
 * @returns the stored record, detached from the store.
 */
async createCase(learnerId: LearnerId, input: CaseOpenInput): Promise<CaseRecord>

/**
 * Apply one amendment to a case of this learner's scope, appending each
 * named field's entries by identity. A case id outside this learner's scope
 * is unknown here and rejects.
 * @param learnerId - the learner whose scope holds the case.
 * @param caseId - the case to amend.
 * @param amendment - the entries to apply.
 * @returns the amended record, detached from the store.
 */
async amend(learnerId: LearnerId, caseId: CaseId, amendment: CaseAmendment): Promise<CaseRecord>

/**
 * Read one case of this learner's scope.
 * @param learnerId - the learner whose scope holds the case.
 * @param caseId - the case to read.
 * @returns the record, or `undefined` when this learner holds no such case.
 */
get(learnerId: LearnerId, caseId: CaseId): CaseRecord | undefined

/**
 * Read every case of one learner's scope.
 * @param learnerId - the learner whose cases to read.
 * @returns the records, earliest case first.
 */
cases(learnerId: LearnerId): readonly CaseRecord[]

/**
 * Read one learner's cases as the learner model consumes them.
 * @param learnerId - the learner whose cases to read.
 * @returns one projection per case, earliest first.
 */
forLearnerMemory(learnerId: LearnerId): readonly LearnerMemoryProjection[]

/**
 * Read one learner's cases as a misconception detector consumes them: what
 * the learner claimed, what the agent and the devil's advocate answered, and
 * what the review found wrong.
 * @param learnerId - the learner whose cases to read.
 * @returns one projection per case, earliest first.
 */
forMisconceptionDetection(learnerId: LearnerId): readonly MisconceptionDetectionProjection[]

/**
 * Read cases as benchmark dataset rows. The whole artifact travels per row,
 * because a dataset built from these cases consumes the structured case
 * rather than a summary of it.
 * @param learnerId - one learner's scope, or omitted for every recorded case.
 * @returns one row per case, learner then case order.
 */
forBenchmarkDataset(learnerId?: LearnerId): readonly BenchmarkDatasetRow[]

/**
 * Read one learner's cases as the next mentor intervention consumes them:
 * what happened, which concepts it exercised, how the learner moved, and
 * what to teach from it.
 * @param learnerId - the learner whose cases to read.
 * @returns one projection per case, earliest first.
 */
forMentorIntervention(learnerId: LearnerId): readonly MentorInterventionProjection[]
```

Source: [`packages/research/case-store/src/index.ts`](../../packages/research/case-store/src/index.ts)

<a id="ctxlearnermodel--learnermodel"></a>

### `ctx.learnerModel` — `LearnerModel`

Durable learner model over the `learner_model` domain: synchronous reads of one learner's record and durable accumulating writes into it. Opens the domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Read one learner's record, detached from the store.
 * @param learnerId - the learner to read.
 * @returns the stored record, or an empty one whose `updatedAt` is `null` when the learner has nothing recorded.
 */
read(learnerId: LearnerId): LearnerRecord

/**
 * Read both knowledge axes of one concept side by side.
 * @param learnerId - the learner to read.
 * @param conceptId - the concept whose axes to read.
 * @returns the two axes, each `undefined` until recorded.
 */
axes(learnerId: LearnerId, conceptId: ConceptId): ConceptAxes

/**
 * Read the learner's detected misconceptions.
 * @param learnerId - the learner to read.
 * @returns the misconceptions, in first-detection order.
 */
misconceptions(learnerId: LearnerId): readonly Misconception[]

/**
 * Read the mistakes the learner repeats.
 * @param learnerId - the learner to read.
 * @returns the recurring mistakes, in first-recording order.
 */
mistakes(learnerId: LearnerId): readonly RecurringMistake[]

/**
 * Read what the learner should learn next.
 * @param learnerId - the learner to read.
 * @returns the objectives the last assessment decided.
 */
objectives(learnerId: LearnerId): readonly LearningObjective[]

/**
 * Record what the learner has shown about a concept by talking about it.
 * This write moves the stated axis only.
 * @param learnerId - the learner to write.
 * @param evidence - the familiarity shown, its exchange count, and its trust label.
 * @returns the updated record, detached from the store.
 */
recordConcept(learnerId: LearnerId, evidence: ConceptEvidence): Promise<LearnerRecord>

/**
 * Record one graded application. This write moves the applied axis only, and
 * it is the only write that can: nothing else in the store raises mastery.
 * @param learnerId - the learner to write.
 * @param evidence - the concept applied, whether it succeeded, and its trust label.
 * @returns the updated record, detached from the store.
 */
recordApplication(learnerId: LearnerId, evidence: ApplicationEvidence): Promise<LearnerRecord>

/**
 * Record what the learner says about their own grasp of a concept.
 * @param learnerId - the learner to write.
 * @param evidence - the stated confidence and its trust label.
 * @returns the updated record, detached from the store.
 */
recordConfidence(learnerId: LearnerId, evidence: ConfidenceEvidence): Promise<LearnerRecord>

/**
 * Record one detection of a misconception, counting its recurrences.
 * @param learnerId - the learner to write.
 * @param evidence - the detected belief, the case that surfaced it, and its trust label.
 * @returns the updated record, detached from the store.
 */
recordMisconception(learnerId: LearnerId, evidence: MisconceptionEvidence): Promise<LearnerRecord>

/**
 * Move a known misconception to a new status.
 * @param learnerId - the learner to write.
 * @param misconceptionId - the recorded belief to move.
 * @param status - where the belief now stands.
 * @returns the updated record, detached from the store.
 */
setMisconceptionStatus( learnerId: LearnerId, misconceptionId: string, status: MisconceptionStatus, ): Promise<LearnerRecord>

/**
 * Record one occurrence of a mistake the learner repeats.
 * @param learnerId - the learner to write.
 * @param evidence - the mistake, the concepts it bears on, the case that surfaced it, and its trust label.
 * @returns the updated record, detached from the store.
 */
recordMistake(learnerId: LearnerId, evidence: MistakeEvidence): Promise<LearnerRecord>

/**
 * Replace the learner's next objectives with what the last assessment decided.
 * @param learnerId - the learner to write.
 * @param objectives - the next objectives; one that survives keeps its original instant.
 * @returns the updated record, detached from the store.
 */
setObjectives(learnerId: LearnerId, objectives: readonly ObjectiveInput[]): Promise<LearnerRecord>

/**
 * Record one reviewed case in the learner's history. The case content stays
 * in the case store; this write keeps the review summary and the case
 * reference.
 * @param learnerId - the learner to write.
 * @param review - the reviewed case summary.
 * @returns the updated record, detached from the store.
 */
applyCase(learnerId: LearnerId, review: CaseReviewInput): Promise<LearnerRecord>
```

Source: [`packages/mentor/learner-model/src/index.ts`](../../packages/mentor/learner-model/src/index.ts)

<a id="ctxmentorloop--mentorloop"></a>

### `ctx.mentorLoop` — `MentorLoop`

The mentor quality loop. It reads its position from the session log, the kernel view, the misconception engine, and the learner record, and performs at most one durable action per step. The kernel is optional, as it is for the misconception engine: with no kernel mounted the loop waits at devil-advocate, because the session holds no claim or observation to act on.

```ts cordis-catalog
/**
 * Where one mentor session stands in the loop, derived from the seams. It
 * mutates nothing.
 * @param agent - the mentor agent whose session is read.
 * @returns the stage, the action the loop would take, and the named wait when nothing can advance.
 */
position(agent: Agent): MentorLoopPosition

/**
 * Perform the one action the position calls for — a detection or a stage
 * completion — and report the next position.
 * @param agent - the mentor agent whose session drives the loop.
 * @returns the position after the action; unchanged when the loop was waiting.
 * @throws when an owner refuses the write the action asks for.
 */
async step(agent: Agent): Promise<MentorLoopPosition>

/**
 * The message to inject when the position calls for delivery and the log
 * does not already carry that stage's directive.
 * @param agent - the mentor agent whose session receives the directive.
 * @returns the message to inject, or undefined when nothing is owed.
 */
directiveMessage(agent: Agent): UserMessage | undefined
```

Types: [Agent](core.md) · [UserMessage](session.md)

Source: [`packages/mentor/mentor-loop/src/index.ts`](../../packages/mentor/mentor-loop/src/index.ts)

<a id="ctxmisconception--misconceptionengine"></a>

### `ctx.misconception` — `MisconceptionEngine`

The misconception engine over the `mentor_misconception` domain. The domain opens at init and closes through `ctx.effect`; the learner record is a required dependency, because a finding nobody owns would leave a learner's recurrence count unwritten.

```ts cordis-catalog
/**
 * The catalogued pattern one stated thesis matches.
 * @param thesis - the learner's stated thesis.
 * @returns the matching pattern, or undefined when the catalogue does not recognize the thesis.
 */
match(thesis: string): MisconceptionPattern | undefined

/**
 * Judge one stated thesis, record the finding in the three places that own
 * it — the learner record's misconceptions and objectives, the pipeline
 * table, and the kernel's claim ledger — and announce it.
 * @param input - the thesis, the learner, the agent that asserts the finding, and the contradicting observations.
 * @returns the recorded detection, with the recurrence count read back from the learner record.
 * @throws when no catalogued pattern matches the thesis, or when no contradicting observation is cited.
 */
async detect(input: ThesisInput): Promise<MisconceptionDetection>

/**
 * One learner's pipeline for one misconception.
 * @param learnerId - the learner whose record carries the occurrence.
 * @param misconceptionId - the derived occurrence identity.
 * @returns the pipeline, or undefined when this learner never showed it.
 */
pipeline(learnerId: LearnerId, misconceptionId: MisconceptionId): MisconceptionPipeline | undefined

/**
 * Every pipeline one learner holds, most recently written first.
 * @param learnerId - the learner whose pipelines are read.
 * @returns the pipelines, detached from the store.
 */
pipelines(learnerId: LearnerId): readonly MisconceptionPipeline[]

/**
 * The instruction the mentor agent receives for a pipeline's current stage.
 * @param learnerId - the learner whose record carries the occurrence.
 * @param misconceptionId - the derived occurrence identity.
 * @param caseId - the case the learner works on, required from the new-case stage onward.
 * @returns the directive, or undefined when the cycle is complete and holds nothing to teach.
 * @throws when the learner holds no such pipeline, or when the pipeline reached the new-case stage without a case.
 */
directive( learnerId: LearnerId, misconceptionId: MisconceptionId, caseId?: CaseReference, ): MentorDirective | undefined

/**
 * Complete a pipeline's current stage with an observed fact and move to the
 * next. The learner record follows the transition: a repeated reassessment
 * counts the misconception's recurrence, and a resolved one leaves the
 * misconception resolved with its objective retired.
 * @param request - the occurrence and the fact that completes its current stage.
 * @returns the pipeline at its new stage.
 * @throws when the learner holds no such pipeline, or when the fact is not the kind the current stage accepts.
 */
async advance(request: AdvanceRequest): Promise<MisconceptionPipeline>
```

Source: [`packages/mentor/misconception/src/index.ts`](../../packages/mentor/misconception/src/index.ts)

<a id="ctxresearch--researchcontroller"></a>

### `ctx.research` — `ResearchController`

Durable research runs and the providers that perform their mechanism stages.

```ts cordis-catalog
/**
 * Register the provider that performs one or more mechanism stages. A stage
 * has exactly one provider, and only the stages whose work is a mechanism's
 * may be claimed.
 * @param provider - the provider to register.
 * @returns a disposer that removes the provider while it remains registered.
 * @throws When the provider declares no stage, an agent-loop stage, or a
 *   stage that already has a provider.
 */
registerStageProvider(provider: ResearchStageProvider): () => void

/**
 * Read the recorded research runs, newest first, for a reader that has no
 * live agent — an evaluation pass over what the loop recorded. The run
 * record is the whole durable state of a run; its evidence and claims are
 * kernel identities a caller resolves through the session log.
 * @param sessionId - restrict the read to one session's runs; every session's runs when omitted.
 * @returns the runs, newest first, each detached from the stored table.
 */
runs(sessionId?: string): readonly ResearchRunRecord[]

/**
 * Read the run a session is working on: the run named, else the session's
 * current run — its unsettled run, else its newest.
 * @param agent - the live agent whose session owns the run.
 * @param runId - identity of the run to read, when the caller names one.
 * @returns the run, or undefined when the session has none.
 * @throws ResearchError `run-not-found` when the named run does not exist or
 *   belongs to another session.
 */
state(agent: Agent, runId?: string): ResearchRunRecord | undefined

/**
 * Advance one run by exactly one stage, recording what the stage produced.
 * A stage that cannot run fails loud, naming the missing referent: a run
 * whose next stage is a provider's with no provider registered, or a stage
 * that requires an observation the session never recorded.
 * @param agent - the live agent whose session owns the run.
 * @param input - the stage to advance and the input only that stage takes.
 * @param signal - cancellation of the waiting call; it reaches a provider.
 * @returns the run after the stage settled or failed.
 * @throws ResearchError for every refusal, and the provider's own error when
 *   a provider fails.
 */
async advance(agent: Agent, input: AdvanceInput, signal?: AbortSignal): Promise<ResearchRunRecord>
```

Types: [Agent](core.md)

Source: [`packages/research/research-controller/src/index.ts`](../../packages/research/research-controller/src/index.ts)

<a id="mentor-events"></a>

### `mentor/*` events

<a id="mentorloop-position--emit"></a>

#### `mentor/loop-position` — emit

One learner's mentor loop position changed: the stage reached, the action taken, and what the loop waits for when nothing can advance.

```ts cordis-catalog
/**
 * One learner's mentor loop position changed: the stage reached, the
 * action taken, and what the loop waits for when nothing can advance.
 * @param report - the learner and the position the loop now stands at.
 * @mode emit
 */
'mentor/loop-position'(report: MentorLoopReport): void
```

Source: [`packages/mentor/mentor-loop/src/events.ts`](../../packages/mentor/mentor-loop/src/events.ts)

<a id="mentormisconception-detected--emit"></a>

#### `mentor/misconception-detected` — emit

One learner thesis was judged against the catalogue and matched, with the observations that contradict it. Emitted after the learner record, the pipeline row, and the kernel claim are written.

```ts cordis-catalog
/**
 * One learner thesis was judged against the catalogue and matched, with
 * the observations that contradict it. Emitted after the learner record,
 * the pipeline row, and the kernel claim are written.
 * @param detection - the thesis, the misconception, the design error, and the contradiction count.
 * @mode emit
 */
'mentor/misconception-detected'(detection: MisconceptionDetection): void
```

Source: [`packages/mentor/misconception/src/events.ts`](../../packages/mentor/misconception/src/events.ts)

<a id="mentormisconception-stage--emit"></a>

#### `mentor/misconception-stage` — emit

One pipeline stage completed and the next began. Emitted after the durable row moved.

```ts cordis-catalog
/**
 * One pipeline stage completed and the next began. Emitted after the
 * durable row moved.
 * @param change - the occurrence, the stages left and entered, the completing fact, and the new stage's wait.
 * @mode emit
 */
'mentor/misconception-stage'(change: MisconceptionStageChange): void
```

Source: [`packages/mentor/misconception/src/events.ts`](../../packages/mentor/misconception/src/events.ts)
<!-- END GENERATED cordis-surface -->

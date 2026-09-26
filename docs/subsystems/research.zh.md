# 研究

[English](research.md) | 中文

由 [`@deepseek-ai/dsh-research-controller`](../../packages/research/research-controller/README.zh.md)（`ctx.research`）拥有的研究质量控制循环。一次运行让一个提问经过十个有序阶段，持久保留每个阶段的输出，并且只有在认识论评审接受了六个认识论桶中的答案时才结束。模型可通过 `research_advance` 工具陈述它能够陈述的阶段；检索、来源分类与矛盾检索是已注册提供方的工作，而运行到达这些阶段却没有提供方时会显式失败，而不是跳过该阶段。观测与论断始终是 [agent kernel](agent-kernel.zh.md) 自己的记录——循环只持有它们的标识，从不复制——因此它只存储一次运行自身的状态，放在 `research` [存储](storage.zh.md)领域中。

Source: [`packages/research/research-controller/src/types.ts`](../../packages/research/research-controller/src/types.ts) · [`packages/research/research-controller/src/stages.ts`](../../packages/research/research-controller/src/stages.ts) · [`packages/research/research-controller/src/pipeline.ts`](../../packages/research/research-controller/src/pipeline.ts)

## 阶段循环

`ResearchStage` 是循环十个阶段的封闭联合，`RESEARCH_STAGES` 固定它们的运行顺序。一次运行总是推进第一个尚未产出的阶段，因此任何阶段都不会乱序执行或在原位执行两次；失败的阶段会一直作为下一个阶段，直到它产出为止：阶段靠再次推进来重试，而不会被跳过。已结束的运行会以 `run-settled` 拒绝任何后续推进，而推进一个更靠后的阶段会以 `stage-out-of-order` 被拒绝。

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

`StageDefinition` 说明每个阶段的目的及其 `StageProducer`：由模型陈述输出的七个阶段属于 agent loop，三个机制阶段（`PROVIDER_STAGES`：search、source-triage、contradiction-search）属于已注册的提供方。`AdvanceInput` 携带要推进的阶段以及仅该阶段需要的输入——question、decompose 与 research-plan 用 `items`，claim-extraction 用 `claims`，synthesis 用 `sections`——对提供方的阶段则不要求调用方提供任何东西。

## 持久运行记录

控制器打开 `research` 存储领域（`researchDomainSpec`：名称 `research`、版本 1、布局 `per-record`），其中一张以 `ResearchRunId` 为键的 `runs` 表，因此每次运行都是独立记录，而不是一份不断增长的单文档。阶段尚未填写的字段存为 `null`，绝不省略，因此存储的运行记录可以精确往返；随领域一起发布的 zod schema 在持久化边界上拒绝不可读的运行，因为把未结束的答案读成已结束的消费方会信任评审从未接受的答案。超过配置的保留上限后，会话中最旧的已结束运行会被丢弃。

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

`StageStatus` 是 `pending | produced | failed`，当阶段没有产出就结束时，`failure` 说明缺少什么。在 synthesis 给出答案之前 `answer` 为 `null`，在评审接受之前 `settledAt` 为 `null`。记录中的 `evidence` 与 `claims` 是 Kernel 标识，因此读者通过 [agent kernel](agent-kernel.zh.md) 解析它们，而不是通过本页。

## 阶段提供方 seam

机制阶段的工作属于部署，因此运行会等待为该阶段注册的提供方。当运行的下一个阶段是这类阶段却没有注册提供方时，拒绝码是 `stage-provider-missing`；运行无法离开该阶段，该阶段也不会被跳过。

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

`registerStageProvider` 会拒绝未声明任何阶段的提供方、声明 agent-loop 阶段的提供方，以及声明已被其他提供方占用的阶段的提供方，因此每个机制阶段恰好只有一个实现。它返回一个 disposer，在提供方仍处于注册状态时将其移除。提供方收到一个 `StageRequest`——运行标识、提问、子问题、计划，以及本次运行在该阶段之前记录的观测与论断——并返回 `StageOutcome`：该阶段的输出行与可选观测。控制器通过 Kernel 自己的 `recordEvidence` 记录每条观测，并以提供方的 id 结束该阶段。

## 六桶答案

`AnswerBucket` 是封闭联合 `documented | observation | interpretation | inference | hypothesis | unresolved`，`ResearchAnswer` 为每个桶保存一份陈述列表，答案正是靠它把有据可查的事实、观测、解释、推断、假设与未解决的不确定性区分开来。synthesis 通过 `SectionInput` 陈述答案，每条都归入一个桶；引用本次运行从未记录的论断会以 `claim-missing` 被拒绝。

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

认识论评审是运行的闸门，其约定也是答案的约定：什么都未陈述的答案会被拒绝，`unresolved` 之外的陈述必须至少依据一条论断，而 claim-extraction 记录的每条论断都必须出现在某个桶中，这样相互矛盾或缺乏支撑的论断就无法在提取与答案之间消失。一次拒绝会列出每一处违规、把它们记录在评审阶段上并以 `review-rejected` 失败，再次推进 synthesis 就是重新开启评审的修订；被接受的答案会设置 `settledAt` 并结束这次运行。

## ICT 案例产物

案例存储（[`@deepseek-ai/dsh-case-store`](../../packages/research/case-store/README.zh.md)，`ctx.caseStore`）拥有一次图表或回测评审的持久产物。该产物正是 §21 的字段集合，且 schema 是严格的，因此带有清单之外字段的已存产物会在持久化边界被拒绝。案例存放在 `ict_case` [存储](storage.zh.md)领域（名称 `ict_case`、版本 1、布局 `per-record`），其中一张以学习者标识加案例标识为键的 `cases` 表，因此一个案例限定于一位学习者，并比产生它的会话存续更久。

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

观测与解读靠字段与结构保持可区分，绝不靠措辞。一条观测携带图表呈现的内容、读取它的时间周期，以及读取它所用的证据键；一条解读在 `basis` 中携带它所读取的观测标识，且完全没有时间周期。严格 schema 会拒绝获得解读结构的观测、不携带 `basis` 的解读，以及 `kind` 与写入字段不一致的解读，因此一种读法不能作为观测存储，一次批评也不能落进 `agentAudit`。

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

证据条目引用内容而不复制内容：在会话内观测到的条目只携带内核的[证据](agent-kernel.zh.md)标识，在会话之外读取的条目携带定位符以及该定位符指向之处的信任标签。其余每个条目都携带自己的 `trust` 标签（RUNTIME-SPEC S11），因此派生自不可信材料的内容在案例被读取的任何地方都保持标注。

四条读路径服务于规范所指名的消费方：`forLearnerMemory` 返回学习者记录保留的评审摘要，`forMisconceptionDetection` 返回学习者所断言的内容并附上审计、批评与已发现的错误，`forBenchmarkDataset` 为每个案例返回一行并携带完整产物，`forMentorIntervention` 返回结果、案例演练过的概念、学习者影响判断以及用于教学的教训。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md) · [UserMessage](session.zh.md)

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

Types: [Agent](core.zh.md)

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

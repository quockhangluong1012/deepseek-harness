# DeepSeek Harness 2.0 — Agent OS Evolution Specification

**Status:** Draft / Implementation Roadmap  
**Target repository:** `quockhangluong1012/deepseek-harness`  
**Primary profiles:** Coding Agent, Research Agent, Mentor/Analyst Agent  
**Architecture goal:** Evolve DeepSeek Harness from a plugin-oriented LLM runtime into a production-grade Agent Operating System with governance, planning, verification, knowledge, and evolution planes.\
**Amendments:** §30–§32 — competitive gap analysis against Claude Code, Codex, MiniMax Code, OpenCode, Gemini CLI, and Aider, with the upgrade backlog and its milestone placement (2026-09-23).

---

## 1. Executive Summary

This specification defines the next evolution of the forked DeepSeek Harness.

The existing codebase already provides a strong execution substrate:

- Event-sourced sessions and durable state
- Agent loop and tool pipeline
- Plugin/Cordis architecture
- Goals and workflows
- Subagent backends including DSH, Codex, Claude Code, and ACP
- Guard/budget/timeout/repetition controls
- Workspace memory and evolution memory
- Hooks and self-modification mechanisms
- Session telemetry and usage accounting

The major remaining gap is **agent control intelligence**. The runtime currently contains many useful primitives, but those primitives need to be unified into a higher-level control plane capable of answering:

1. What state is the agent in?
2. Is the current action making measurable progress?
3. Is the agent stuck, repeating, oscillating, or drifting?
4. What evidence is required before declaring success?
5. How should failures change the next strategy?
6. What information should be retained, retrieved, promoted, or invalidated?
7. When should work be delegated to another agent/model?
8. How can the harness evaluate and improve its own policies over time?

The target architecture is therefore:

```text
                              USER
                               │
                               ▼
                       ┌───────────────┐
                       │  Task Router  │
                       └───────┬───────┘
                               │
               ┌───────────────┴────────────────┐
               │                                │
               ▼                                ▼
        CODING PROFILE                   RESEARCH / MENTOR
               │                                │
               └───────────────┬────────────────┘
                               ▼
                     ┌────────────────────┐
                     │  AGENT CONTROL     │
                     │      PLANE         │
                     ├────────────────────┤
                     │ Governor           │
                     │ Task Controller    │
                     │ Planner            │
                     │ Progress Monitor   │
                     │ Recovery           │
                     │ Delegation Policy  │
                     └─────────┬──────────┘
                               ▼
                     ┌────────────────────┐
                     │ EXECUTION PLANE    │
                     │ Models / Tools     │
                     │ Subagents / Hooks  │
                     └─────────┬──────────┘
                               ▼
                     ┌────────────────────┐
                     │ VERIFICATION PLANE │
                     │ Tests / Review     │
                     │ Evidence / Gates   │
                     └─────────┬──────────┘
                               ▼
                     ┌────────────────────┐
                     │ KNOWLEDGE PLANE    │
                     │ Context / Memory   │
                     │ Artifacts / Claims │
                     │ Research / Learner │
                     └─────────┬──────────┘
                               ▼
                     ┌────────────────────┐
                     │ EVOLUTION PLANE    │
                     │ Trace / Eval       │
                     │ Experiments        │
                     │ Policy Promotion   │
                     └────────────────────┘
```

---

# 2. Design Principles

## 2.1. Do not rewrite the core agent loop unless required

Keep the existing execution substrate and add control behavior through explicit extension points.

Preserve:

- `core/agent`
- `core/agent-loop`
- `core/session`
- `tools`
- Cordis plugin architecture
- Event-sourcing guarantees

The new architecture should primarily wrap and govern execution rather than duplicate it.

## 2.2. The model proposes; the harness governs

The model can propose:

- plans
- actions
- tool calls
- delegation
- completion

The harness is responsible for:

- budgets
- lifecycle/state
- tool permissions
- verification
- completion
- recovery
- evidence
- persistence
- policy evolution

## 2.3. Completion must be evidence-based

The final model message is not proof of success.

A successful task requires:

```text
Candidate Completion
        ↓
Evidence Collection
        ↓
Verification
        ↓
Completion Gate
        ↓
Certified Completion
```

## 2.4. Context is not memory

Separate:

- execution history
- working memory
- semantic memory
- artifacts
- current task state
- research evidence
- learner state

## 2.5. Evolution must be benchmarked

No automatic policy promotion without:

- a baseline
- a candidate
- a benchmark set
- measurable metrics
- regression protection
- rollback capability

## 2.6. Preserve event-sourcing integrity

Anything visible to the model that is part of deterministic execution state must remain reconstructable from durable state and/or explicitly registered projections.

---

# 3. Target Agent Profiles

## 3.1. Coding Profile

Primary loop:

```text
UNDERSTAND
  ↓
MAP
  ↓
PLAN
  ↓
CHANGE CONTRACT
  ↓
IMPLEMENT
  ↓
LOCAL VERIFY
  ↓
REVIEW
  ↓
REGRESSION
  ↓
COMPLETION
```

Core capabilities:

- repository intelligence
- working-set construction
- dependency/call graph retrieval
- structured planning
- bounded implementation
- local test loops
- independent review
- failure diagnosis
- repair/replan
- change-contract validation

## 3.2. Research Profile

Primary loop:

```text
QUESTION
  ↓
DECOMPOSE
  ↓
RESEARCH PLAN
  ↓
SEARCH
  ↓
SOURCE TRIAGE
  ↓
CLAIM EXTRACTION
  ↓
EVIDENCE
  ↓
CONTRADICTION SEARCH
  ↓
SYNTHESIS
  ↓
EPISTEMIC REVIEW
```

Core capabilities:

- source ranking
- claim ledger
- evidence graph
- contradiction search
- uncertainty handling
- citation/provenance
- research artifact persistence

## 3.3. Mentor / Analyst Profile

Primary loop:

```text
OBSERVE
  ↓
ANALYZE
  ↓
DEVIL ADVOCATE
  ↓
DIAGNOSE MISCONCEPTION
  ↓
TEACH
  ↓
ASSIGN EXERCISE
  ↓
REASSESS
  ↓
UPDATE LEARNER MODEL
```

Primary domain use case:

- ICT trading concept research
- chart/case-study analysis
- daily bias analysis
- top-down market analysis
- backtest review
- mistake diagnosis
- recurring misconception detection

---

# 4. Package / Module Target Structure

Proposed long-term structure:

```text
packages/

core/
  agent/
  agent-loop/
  session/
  tools/
  system-prompt/

-governance/
  agent-governor/
  budgets/
  progress-monitor/
  loop-detector/
  oscillation-detector/
  liveness/
  delegation-policy/

-task/
  task/
  task-graph/
  task-controller/
  plan-drift/

-verification/
  verifier/
  completion-gate/
  test-verifier/
  build-verifier/
  lint-verifier/
  typecheck-verifier/
  diff-verifier/
  security-verifier/
  review-verifier/

-recovery/
  failure-diagnoser/
  retry-policy/
  repair-loop/
  replanner/

-context/
  context-engine/
  context-retrieval/
  workspace-memory/
  evolution-memory/

-artifact/
  artifact-store/
  artifact-tools/

-repo/
  repo-intelligence/
  repo-map/
  working-set/
  change-contract/

-subagent/
  existing backends...
  agent-roles/
  delegation/

-research/
  research-controller/
  source-ranking/
  claims/
  evidence/
  contradiction/
  synthesis/
  critic/

-mentor/
  learner-model/
  misconception/
  assessment/
  teaching/

-evaluation/
  evaluator/
  trajectory/
  coding-bench/
  research-bench/
  mentor-bench/

-evolution/
  traces/
  failure-taxonomy/
  experiments/
  policies/
  promotion/
```

Note: naming may be adapted to existing repository conventions. Do not introduce parallel abstractions when an existing package already owns the lifecycle.

---

# 5. Phase 0 — Baseline & Architecture Freeze

## Objective

Create a measurable baseline before changing agent behavior.

## Deliverables

### 5.1. Agent Trace

Create a first-class execution trace model.

```ts
interface AgentTrace {
  runId: string
  sessionId: string
  taskId?: string
  profile: 'coding' | 'research' | 'mentor' | 'analyst'

  startedAt: number
  endedAt?: number

  steps: StepTrace[]
  toolCalls: ToolTrace[]
  subagents: SubagentTrace[]

  budget: BudgetTrace
  context: ContextTrace
  verification: VerificationTrace[]

  finalStatus:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'budget_exceeded'
    | 'loop_detected'
    | 'timeout'
}
```

### 5.2. Standard step telemetry

Track:

- input tokens
- output tokens
- estimated cost
- latency
- tool count
- tool failures
- context size
- state delta
- progress score
- verification results
- subagent usage

### 5.3. Baseline benchmarks

Create initial datasets for:

- coding
- research
- mentor/ICT analysis
- long-horizon execution
- loop/recovery scenarios

### 5.4. Baseline metrics

Minimum:

```text
Task Success Rate
Verified Success Rate
False Completion Rate
Human Intervention Rate
Average Cost
Average Tokens
Average Steps
Recovery Success Rate
Loop Rate
Tool Failure Rate
Subagent Waste
Context Utilization
```

Recommended:

```text
Verified Success / $1
Verified Success / 1M tokens
Verified Success / 10 minutes
```

## Exit Criteria

- baseline benchmark is reproducible
- every run produces a trace
- task outcome and process metrics can be compared across versions

---

# 6. Phase 1 — Agent Governance

## Objective

Prevent uncontrolled execution and unify existing guards into a single control plane.

## 6.1. Agent Governor

```ts
type GovernorDecision =
  | 'continue'
  | 'retry'
  | 'replan'
  | 'compact'
  | 'delegate'
  | 'ask_user'
  | 'stop_success'
  | 'stop_failure'
  | 'stop_budget'
  | 'stop_loop'
  | 'stop_timeout'
```

Governor inputs:

- budget state
- progress
- repetition
- oscillation
- failures
- context pressure
- task state
- verification state
- subagent health
- liveness

## 6.2. Budget semantics refactor

Separate:

### Context budget

```text
maxContextTokens
```

### Turn budget

```text
maxTurnInputTokens
maxTurnOutputTokens
maxTurnTotalTokens
```

### Session budget

```text
maxSessionTokens
maxSessionCost
maxSessionWallTime
```

### Run budget

```text
maxRunTokens
maxRunCost
maxRunWallTime
```

Do not conflate context pressure with actual spend.

## 6.3. Budget reservation

Required API:

```text
reserve()
commit()
release()
```

Use reservation accounting for:

- parallel workflow children
- subagents
- Codex workers
- Claude Code workers
- background execution

## 6.4. Progress Monitor

Each step produces:

```ts
interface StepDelta {
  toolNovelty: number
  stateDelta: number
  evidenceGain: number
  goalProgress: number
  errorReduction: number
  planProgress: number
}
```

Derive a normalized `progressScore`.

## 6.5. Loop detectors

Implement separate detectors:

- exact repeated tool call
- semantic duplicate action
- no-progress loop
- oscillation loop
- narration-only loop
- repeated failure loop

## 6.6. Liveness Monitor

Distinguish:

- tool timeout
- transport timeout
- stream timeout
- agent timeout
- child-agent timeout
- UI interaction timeout

Track:

```text
lastFrameAt
lastProgressAt
lastToolEventAt
```

## Exit Criteria

- no known unbounded execution paths
- no indefinite tool wait without explicit escalation
- budget accounting is deterministic
- all pathological loops can be terminated or escalated

---

# 7. Phase 2 — Task & Agent State

## Objective

Separate execution truth from conversation history.

## 7.1. Task Model

```ts
interface Task {
  id: string
  parentId?: string
  objective: string

  state:
    | 'pending'
    | 'ready'
    | 'running'
    | 'blocked'
    | 'failed'
    | 'verifying'
    | 'completed'

  dependencies: string[]
  acceptanceCriteria: Criterion[]
  constraints: Constraint[]
  evidence: EvidenceRef[]
}
```

## 7.2. Goal → Task Graph

Support:

```text
Goal
 ├── Task A
 ├── Task B
 │    ├── B1
 │    └── B2
 └── Verification
```

## 7.3. Acceptance Criteria

Each task should define:

- must satisfy
- must preserve
- must not do
- expected artifacts
- required verification

## 7.4. Plan Drift Detector

Compare intended plan with observed action sequence.

Escalate when drift exceeds configured tolerance.

## Exit Criteria

An interrupted task can resume from durable task state without reconstructing its execution solely from transcript text.

---

# 8. Phase 3 — Verification & Recovery

## Objective

Make correctness and recovery first-class runtime behavior.

## 8.1. Verifier Framework

```ts
interface Verifier {
  name: string
  verify(context: VerificationContext): Promise<VerificationResult>
}
```

Initial verifiers:

- build
- test
- lint
- typecheck
- diff
- security
- browser
- custom command
- independent reviewer

## 8.2. Completion Gate

```text
candidate_done
  ↓
evidence_collection
  ↓
verification
  ↓
review
  ↓
certified_done
```

## 8.3. Failure Diagnoser

```ts
interface FailureDiagnosis {
  category: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  evidence: EvidenceRef[]
  hypotheses: Hypothesis[]
  recommendedActions: Action[]
}
```

## 8.4. Recovery Policy

Do not blindly retry the same action.

Required flow:

```text
failure
 ↓
classify
 ↓
diagnose
 ↓
change strategy
 ↓
retry / repair / replan / escalate
```

## 8.5. Repair Loop

Targeted recovery:

```text
FAIL
 ↓
DIAGNOSE
 ↓
MINIMAL FIX
 ↓
TARGETED VERIFY
 ↓
REGRESSION VERIFY
```

## Exit Criteria

- final model claim is never sufficient for completion
- recoverable failures trigger diagnosis
- repeated failures cause strategy changes
- verification evidence is persisted

---

# 9. Phase 4 — Context & Artifact Intelligence

## Objective

Replace context flooding with tiered working memory and on-demand artifact retrieval.

## 9.1. Artifact Store

Store large or reusable outputs externally:

- build logs
- test logs
- diffs
- screenshots
- browser traces
- research documents
- source excerpts
- generated reports

## 9.2. Artifact APIs

```text
artifact.search
artifact.read
artifact.extract
artifact.diff
artifact.summarize
```

## 9.3. Context tiers

```text
L0 Policies / System
L1 Task State
L2 Working Memory
L3 Relevant Memory
L4 Recent History
L5 Artifact References
L6 Cold Storage
```

Only inject large lower tiers on demand.

## 9.4. Memory lifecycle

```text
observation
 → candidate
 → validated
 → promoted
 → stable
 → stale
 → invalidated
```

## 9.5. Memory validation

A memory promotion requires evidence or a policy-defined confidence threshold.

Validate:

- source
- scope
- confidence
- contradictions
- recency

## 9.6. Memory conflict resolution

Resolution should consider:

- scope
- recency
- source quality
- evidence count
- confidence
- explicit supersession

## 9.7. Memory projection

Separate:

```text
Memory Ledger
```

from:

```text
Current Memory Projection
```

The projection is the model-facing representation.

## Exit Criteria

- large artifacts do not pollute hot context
- memory can be invalidated or superseded
- relevant memory can be retrieved without injecting the entire store

---

# 10. Phase 5 — Coding Intelligence

## Objective

Improve code quality by giving the agent structural understanding of a repository.

## 10.1. Repository Intelligence

Build indexes for:

- file tree
- symbols
- imports/exports
- call graph
- test graph
- config graph
- package/dependency graph

## 10.2. Repository Map

Expose a compact semantic graph to the model.

Example:

```text
AuthController
  → AuthService
      → AuthRepository
```

## 10.3. Working Set

For each task derive:

- primary files
- dependency files
- test files
- config files
- related documentation

## 10.4. Change Contract

Before modification:

```json
{
  "goal": "...",
  "expectedFiles": [],
  "allowedFiles": [],
  "mustPreserve": [],
  "forbiddenChanges": [],
  "expectedTests": []
}
```

After modification compare actual diff against the contract.

## 10.5. Coding lifecycle

```text
UNDERSTAND
 ↓
MAP
 ↓
PLAN
 ↓
CONTRACT
 ↓
IMPLEMENT
 ↓
LOCAL VERIFY
 ↓
REVIEW
 ↓
REGRESSION
 ↓
COMPLETE
```

## 10.6. Independent reviewer

Use a fresh context and, where budget permits, an independent backend/model.

Possible topology:

```text
DeepSeek → implementation
Claude Code → review
Codex → alternate review
DeepSeek → judge / integrate
```

## Exit Criteria

- reduced unnecessary repository exploration
- reduced regression rate
- improved review finding rate
- higher verified success on multi-file tasks

---

# 11. Phase 6 — Agent Orchestration

## Objective

Turn subagents into governed typed workers rather than unconstrained child sessions.

## 11.1. Typed Worker Roles

Examples:

- Explorer
- Planner
- Coder
- Tester
- Reviewer
- Debugger
- Security Auditor
- Researcher
- Source Auditor
- Critic
- Mentor

Each worker must declare:

- role
- model
- tools
- permissions
- memory scope
- budget
- max turns
- output schema

## 11.2. Delegation Policy

```ts
interface DelegationPolicy {
  maxDepth: number
  maxChildren: number
  maxConcurrent: number
  maxCost: number
  maxTokens: number
  allowedRoles: string[]
  duplicateTaskDetection: boolean
  resultSchemaRequired: boolean
}
```

## 11.3. Task overlap detection

Before spawning a child, compare task semantics against active child tasks and recent completed tasks.

If overlap is high:

- reuse result
- merge tasks
- narrow scope
- avoid spawn

## 11.4. Agent result contract

```ts
interface AgentResult {
  status: string
  findings: Finding[]
  evidence: EvidenceRef[]
  artifacts: ArtifactRef[]
  recommendedActions: Action[]
  confidence?: number
}
```

## 11.5. Result quality gate

Possible statuses:

```text
accepted
needs_more_evidence
invalid
contradictory
timeout
```

## Exit Criteria

- child execution is bounded
- overlapping work is minimized
- parent agents consume structured results
- multi-agent execution has deterministic cost ceilings

---

# 12. Phase 7 — Research & Mentor Engine

## Objective

Build a research-grade knowledge and learning system for ICT study and other deep research tasks.

## 12.1. Research Controller

```text
QUESTION
 ↓
DECOMPOSE
 ↓
RESEARCH PLAN
 ↓
SEARCH
 ↓
SOURCE TRIAGE
 ↓
CLAIM EXTRACTION
 ↓
EVIDENCE
 ↓
CONTRADICTION SEARCH
 ↓
SYNTHESIS
 ↓
EPISTEMIC REVIEW
```

## 12.2. Claim Ledger

```ts
interface Claim {
  id: string
  statement: string

  type:
    | 'documented'
    | 'observation'
    | 'interpretation'
    | 'inference'
    | 'hypothesis'
    | 'disputed'

  sources: SourceRef[]
  evidence: EvidenceRef[]
  supportingClaims: string[]
  contradictingClaims: string[]
  confidence: number
}
```

Critical requirement: documented claims, interpretations, observations, and inferences must remain distinguishable.

## 12.3. Source ranking

Suggested classes:

```text
Primary
Secondary
Tertiary
Community
Inference
Unknown
```

## 12.4. Contradiction search

For important claims ask:

> What evidence would make this claim false?

Then actively search:

- counterexamples
- alternative interpretations
- contradictory sources
- failure conditions

## 12.5. Evidence graph

```text
Claim
 ├── Source A
 │    └── Evidence
 ├── Source B
 │    └── Evidence
 └── Source C
      └── Contradiction
```

## 12.6. ICT Analyst Profile

For chart/case-study tasks use:

```text
OBSERVATIONS
STRUCTURE
LIQUIDITY
PD ARRAY
BIAS
SCENARIOS
CONFIRMATION
INVALIDATION
CONFIDENCE
MISSING EVIDENCE
```

## 12.7. Devil Advocate Profile

Required output:

```text
Thesis
Assumptions
Supporting Evidence
Weaknesses
Counterarguments
Alternative Explanations
Falsifiers
Missing Evidence
Confidence
```

## 12.8. Learner Model

```text
Learner
├── Concept Knowledge
├── Application Ability
├── Misconceptions
├── Recurring Mistakes
├── Confidence
├── Case History
└── Next Learning Objectives
```

Do not equate conceptual familiarity with application mastery.

## 12.9. Misconception Engine

Example:

```text
User thesis:
"MSS happened, therefore the entry is valid."

Detected misconception:
MSS treated as a standalone entry criterion.
```

Then:

```text
Explain
 ↓
Counterexample
 ↓
Exercise
 ↓
New case
 ↓
Reassess
```

## Exit Criteria

- research outputs are source/evidence aware
- contradictions are actively searched
- chart analysis separates observation from interpretation
- recurring learner mistakes are tracked and acted upon

---

# 13. Phase 8 — Agent Evaluation Platform

## Objective

Measure agent behavior and outcomes, not merely software correctness.

## 13.1. Evaluation layers

### Layer 1 — Software correctness

- unit
- integration
- e2e
- snapshots

### Layer 2 — Agent behavior

- planning
- verification
- recovery
- loop avoidance
- delegation discipline

### Layer 3 — Outcome

- actual task success
- regression
- research correctness
- learning improvement

## 13.2. Coding metrics

```text
Verified Success
False Completion
Regression Rate
Recovery Efficiency
Planning Fidelity
Verification Coverage
Human Intervention
Cost
Latency
```

## 13.3. Research metrics

```text
Claim Accuracy
Source Quality
Evidence Coverage
Contradiction Recall
Uncertainty Calibration
Citation Correctness
Unsupported Claim Rate
```

## 13.4. Mentor metrics

```text
Misconception Detection
Explanation Quality
Exercise Relevance
Learning Improvement
Retention
Repeated Mistake Reduction
```

## 13.5. Long-horizon benchmark

Create tasks spanning:

- 10 steps
- 20 steps
- 50 steps
- 100+ steps

with measurement of:

- success
- process discipline
- recoveries
- context pressure
- budget usage

## Exit Criteria

A harness policy change can be evaluated quantitatively before promotion.

---

# 14. Phase 9 — Evolution Engine

## Objective

Enable controlled, benchmarked evolution of prompts, policies, routing, context, memory, verification, and orchestration.

## 14.1. Trace mining

```text
Run
 ↓
Trace
 ↓
Failure Taxonomy
 ↓
Recurring Pattern
```

## 14.2. Hypothesis generation

Example:

```text
Observed:
Agents frequently modify code before understanding the repository.

Hypothesis:
Require a MAP phase before first write.
```

## 14.3. Candidate policy

Every experiment has:

- baseline policy
- variant policy
- benchmark
- metrics
- promotion threshold

## 14.4. Experiment Registry

```ts
interface Experiment {
  id: string
  hypothesis: string
  baseline: string
  variant: string
  benchmark: string
  metrics: Metric[]
  status:
    | 'draft'
    | 'running'
    | 'passed'
    | 'rejected'
    | 'promoted'
}
```

## 14.5. Policy versioning

Policies must be:

- versioned
- diffable
- reproducible
- reversible
- benchmarked

## 14.6. Promotion gate

```text
Baseline
   vs
Candidate
   ↓
Same benchmark
Same model
Same budget
Same task set
   ↓
Evaluation
   ↓
Promote / Reject
```

## Exit Criteria

The harness can demonstrate a measurable improvement without requiring a stronger underlying model.

---

# 15. Session & Event Architecture

## 15.1. Event domains

Recommended namespaces:

```text
agent/task/*
agent/governance/*
agent/progress/*
agent/verification/*
agent/recovery/*
memory/*
research/*
evaluation/*
evolution/*
```

## 15.2. Event Registry

Introduce an explicit registry with semantics:

```text
required
optional
ignorable
projection-critical
```

Requirements:

- unknown optional events must not break future session loading
- projection-critical events must be validated strictly
- event schemas must be versioned
- migration paths must be defined

## 15.3. Data separation

Do not use the session log as the universal database.

Separate:

```text
Session Event Log  → execution history
Task Store         → current task state
Memory Store       → semantic knowledge
Artifact Store     → large blobs
Evaluation Store   → benchmark results
Experiment Store   → policy evolution
```

---

# 16. Security / Reliability Workstream

This workstream runs in parallel with all phases.

## Requirements

- explicit sandbox policy
- approval enforcement
- child-agent permission boundaries
- process-tree termination
- filesystem allow/deny semantics
- network policy
- tool capability declaration
- audit trail for privileged actions
- deterministic redaction rules
- safe self-modification policy

## Self-modification constraints

Self-modification must distinguish:

```text
Observe
Propose
Validate
Apply
Rollback
```

Never allow arbitrary self-modification to bypass:

- version control
- tests
- benchmark gates
- permissions
- rollback mechanisms

---

# 17. Default Control Loop

The default agent runtime should eventually implement the following state machine:

```text
                    ┌──────────────┐
                    │ UNDERSTAND   │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │    PLAN      │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │   EXECUTE    │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │   OBSERVE    │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │   VERIFY     │
                    └──────┬───────┘
                           │
                ┌──────────┼──────────┐
                ▼          ▼          ▼
             PASS       REPAIR      REPLAN
                │          │          │
                ▼          └────┬─────┘
             COMPLETE          │
                               └──────→ EXECUTE
```

Governor can interrupt this loop at any point:

```text
budget
loop
stall
liveness
permission
context pressure
user intervention
```

---

# 18. Coding Quality Control Loop

```text
TASK
 ↓
UNDERSTAND
 ↓
REPO MAP
 ↓
PLAN
 ↓
CHANGE CONTRACT
 ↓
EDIT
 ↓
LOCAL CHECK
 ↓
TEST
 ↓
INDEPENDENT REVIEW
 ↓
REGRESSION
 ↓
COMPLETION GATE
```

Failure:

```text
FAIL
 ↓
DIAGNOSE
 ↓
HYPOTHESIS
 ↓
MINIMAL REPAIR
 ↓
TARGETED TEST
 ↓
REGRESSION
```

---

# 19. Research Quality Control Loop

```text
QUESTION
 ↓
DECOMPOSE
 ↓
SEARCH
 ↓
SOURCE TRIAGE
 ↓
CLAIM EXTRACTION
 ↓
EVIDENCE GRAPH
 ↓
CONTRADICTION SEARCH
 ↓
SYNTHESIS
 ↓
EPISTEMIC REVIEW
 ↓
ANSWER
```

The final answer should distinguish:

- documented fact
- observation
- interpretation
- inference
- hypothesis
- unresolved uncertainty

---

# 20. Mentor Quality Control Loop

```text
USER ANALYSIS
 ↓
OBSERVE
 ↓
EVALUATE
 ↓
DEVIL ADVOCATE
 ↓
MISCONCEPTION DETECTION
 ↓
TEACH
 ↓
EXERCISE
 ↓
REASSESS
 ↓
LEARNER MODEL UPDATE
```

---

# 21. ICT Case Study Artifact

For chart/backtest review, persist a structured case artifact:

```json
{
  "symbol": "EURUSD",
  "timeframes": ["D1", "H1", "M5"],
  "observations": [],
  "userThesis": [],
  "evidence": [],
  "agentAudit": [],
  "devilAdvocate": [],
  "alternativeScenarios": [],
  "outcome": null,
  "mistakes": [],
  "lessons": [],
  "conceptsTested": [],
  "learnerImpact": []
}
```

This case artifact should feed:

- learner memory
- misconception detection
- benchmark datasets
- future mentor interventions

---

# 22. Recommended Milestone Order

## M0 — Baseline

```text
Agent Trace
Benchmark Runner
Core Metrics
```

## M1 — Safe Agent

```text
Budget Semantics
Budget Reservation
Governor
Progress Monitor
Semantic Loop Detection
Oscillation Detection
Liveness
```

## M2 — Stateful Agent

```text
Task Model
Task Graph
Acceptance Criteria
Plan Drift
Task Persistence
```

## M3 — Reliable Agent

```text
Verifier Framework
Completion Gate
Failure Diagnoser
Recovery
Repair Loop
```

## M4 — Context-Aware Agent

```text
Artifact Store
Context Tiers
Retrieval
Memory Lifecycle
Memory Validation
Memory Conflicts
```

## M5 — High-Quality Coding Agent

```text
Repo Intelligence
Repo Map
Working Set
Change Contract
Independent Reviewer
Regression Engine
```

## M6 — Multi-Agent System

```text
Typed Workers
Delegation Policy
Overlap Detection
Budget Coordination
Result Contracts
```

## M7 — Research / Mentor

```text
Research Controller
Claim Ledger
Evidence Graph
Contradiction Search
Devil Advocate
Learner Model
Misconception Engine
```

## M8 — Evaluation Platform

```text
Trajectory Evaluation
Coding Benchmark
Research Benchmark
Mentor Benchmark
Long-Horizon Benchmark
```

## M9 — Evolution

```text
Trace Mining
Failure Taxonomy
Experiments
Policy Variants
A/B Evaluation
Promotion
Rollback
```

---

# 23. Priority Matrix

| Priority | Mechanism | Target value |
|---|---|---|
| P0 | Agent Governor | Prevent pathological execution |
| P0 | Progress Monitor | Detect stagnation |
| P0 | Budget semantics split | Correct resource governance |
| P0 | Verifier Framework | Increase correctness |
| P0 | Completion Gate | Eliminate false completion |
| P0 | Failure Diagnoser | Improve recovery |
| P0 | Artifact Store | Reduce context pollution |
| P0 | Task Controller | Make execution state explicit |
| P1 | Context Retrieval | Improve long-context performance |
| P1 | Repo Intelligence | Improve code understanding |
| P1 | Change Contract | Reduce unintended changes |
| P1 | Independent Reviewer | Increase defect discovery |
| P1 | Delegation Governance | Control multi-agent waste |
| P1 | Claim/Evidence Engine | Improve research reliability |
| P1 | Learner Model | Improve mentoring |
| P2 | Model Router | Improve cost/quality trade-off |
| P2 | Experiment Registry | Enable systematic evolution |
| P2 | Harness Policy Evolution | Self-improving runtime |

---

# 24. Non-Goals

Do not optimize for:

- maximizing number of subagents
- maximizing prompt size
- maximizing context utilization
- automatically writing more memory
- blindly retrying failures
- automatically changing policies without evaluation
- replacing deterministic verification with LLM confidence

---

# 25. Golden Invariants

## Invariant 1 — No unverified completion

`DONE` requires evidence.

## Invariant 2 — No uncontrolled execution

Every action is subject to budget and liveness policy.

## Invariant 3 — No invisible execution state

Model-visible state must be reconstructable from durable state or explicitly registered projections.

## Invariant 4 — No untyped inter-agent contract

Agents exchange structured artifacts, not arbitrary prose-only contracts.

## Invariant 5 — No autonomous policy promotion without benchmark evidence

Evolution requires controlled evaluation and rollback.

---

# 26. Quality Gates for the Whole Project

Every new subsystem must provide:

1. unit tests
2. integration tests
3. persistence/replay tests where stateful
4. failure-path tests
5. cancellation/timeout tests where applicable
6. benchmark impact measurement
7. documentation
8. compatibility review

For changes affecting agent behavior, add at least one benchmark scenario demonstrating the intended behavioral improvement.

---

# 27. Success Criteria for DeepSeek Harness 2.0

The project is considered to have reached the next-generation target when:

### Reliability

- runaway loops are bounded
- indefinite tool waits are controlled
- child-agent spawning is governed
- failures transition through explicit recovery policies

### Coding

- completion is evidence-based
- regressions are detected automatically
- repository structure is understood before broad modification
- reviewers operate with independent context
- unnecessary exploration is reduced

### Research

- claims have provenance
- contradictions are actively searched
- uncertainty is explicit
- source quality influences synthesis

### Mentoring

- learner state persists across sessions
- recurring misconceptions are detected
- exercises target specific weaknesses
- future performance is used to evaluate mentor effectiveness

### Evolution

- traces are evaluable
- failure patterns become hypotheses
- policy variants are benchmarked
- promotion is reversible
- the harness can improve without changing the underlying model

---

# 28. Immediate Next Implementation Sprint

Recommended order for the first concrete implementation cycle:

```text
01. Refactor budget semantics
02. Add budget reservation ledger
03. Implement Agent Governor
04. Implement Progress Monitor
05. Extend repeat detector into semantic loop detection
06. Add oscillation detector
07. Add liveness monitor
08. Introduce Task/TaskState model
09. Introduce Completion Gate skeleton
10. Introduce Verifier interface + Test/Build/Typecheck verifiers
11. Introduce FailureDiagnosis model
12. Add benchmark runner for Coding Profile
```

Do not start Repository Intelligence, multi-agent expansion, or autonomous evolution until items 1–12 are stable.

---

# 29. Long-Term Vision

The desired end-state is not a larger prompt wrapper.

It is:

```text
               MODEL
                 │
            proposes actions
                 │
                 ▼
        ┌──────────────────┐
        │   AGENT OS       │
        ├──────────────────┤
        │ Govern           │
        │ Plan             │
        │ Execute          │
        │ Observe          │
        │ Verify           │
        │ Recover          │
        │ Remember         │
        │ Evaluate         │
        │ Evolve           │
        └────────┬─────────┘
                 │
                 ▼
             OUTCOME
                 │
                 ▼
             FEEDBACK
                 │
                 └────────→ POLICY EVOLUTION
```

Core principle:

> **The model proposes; the harness observes, constrains, verifies, diagnoses, remembers, and learns.**

That principle should remain the architectural north star for the fork.

---

# 30. Competitive Gap Analysis (2026-09-23)

## 30.1. Scope, sources, and status vocabulary

This section compares DeepSeek Harness with the agentic coding harnesses it competes with:

| Abbreviation | Harness |
|---|---|
| CC | Anthropic Claude Code (CLI, desktop app, IDE extensions, Agent SDK) |
| CX | OpenAI Codex (CLI, Codex app, Codex cloud, `codex exec`) |
| MM | MiniMax Code (`mcode`, npm `@minimax-ai/code`; the terminal agent was open-sourced around 2026-09-18, the desktop app is closed source) |
| OC | OpenCode |
| GM | Google Gemini CLI |
| AD | Aider (reference for repo map and git-commit workflow; in maintenance mode) |

**Where the facts come from**

- **External facts** come from public documentation and search results as of 2026-09-23. They are linked in §30.5.
- Some Codex details come from a third-party reference site (codex.danielvaughan.com), not from OpenAI's own documentation.
- A cell marked `[UNCONFIRMED]` could not be confirmed from a search result.
- **Facts about this repository** were checked against `main` at `556c0dc2e6` plus the working tree of 2026-09-23.

**Status words used in the `dsh` column**

| Status | Meaning |
|---|---|
| `mounted` | Loaded by at least one shipped profile in `packages/bundle/*/cordis.patch.yml` |
| `unmounted` | The package exists, but no shipped profile loads it |
| `partial` | Part of the mechanism exists |
| `absent` | Not implemented |

An `unmounted` mechanism counts as a gap: a user does not get it.

Cell marks: `✓` present, `partial`, `–` absent, `?` unknown.

## 30.2. Where DeepSeek Harness is at or above parity

Keep these; the backlog in §31 builds on them.

- **Session durability**: event-sourced sessions with fail-closed crash-recovery checkpoints before model requests and effectful tools (`packages/session/session-checkpoint-policy`).
- **Composition**: every capability is a replaceable Cordis plugin, composed into profiles.
- **Surfaces**: five ship today — Web, Desktop (Electron), ACP, TypeScript and Python SDKs over JSON-RPC, and headless.
- **OS sandbox on three platforms**: bwrap/Landlock on Linux, Seatbelt on macOS, and a Windows restricted token. It supports per-call escalation with a justification (`packages/sandbox/*`).
- **Parallel tool execution**: calls declared concurrency-safe run in parallel, and edits are serialized per path.
- **Context management**: proactive and reactive compaction, tool-result pruning, image offload, and a context meter UI.
- **Background jobs**: completion notices are injected into the session, and the Web header shows a jobs roster.
- **Subagents**: spawn and fork, `output_schema`, background runs that can be continued, and model selection per child.
- **Delegation to external agents** (Claude Code, Codex, ACP, dsh-sdk providers): **no benchmarked harness offers this.**
- **Other capabilities**:
  - `/goal` continuation;
  - skills with progressive disclosure and security scanning of project skills;
  - evolution memory and skill curation beyond CC auto memory;
  - JS workflow orchestration of subagents;
  - branching a conversation at any turn;
  - multi-provider routing through the pi-ai gateway;
  - reasoning-effort control;
  - English and Chinese UI.

## 30.3. Gap matrix

### A. Desktop and interaction

| Mechanism | CC | CX | MM | OC | GM | dsh |
|---|---|---|---|---|---|---|
| Terminal TUI | ✓ | ✓ | ✓ | ✓ | ✓ | absent: removed in `10bb9cbf4a`; Desktop and Web are the interactive surfaces (decision: upgrade Desktop, §32.4) |
| Desktop app | ✓ | ✓ | ✓ closed source | – | – | mounted (`apps/desktop`) |
| Headless machine output | ✓ `json`, `stream-json` | ✓ `exec --json`, `--output-schema` | ✓ `exec --output-format stream-json` | ✓ `run`, HTTP server | ✓ `json`, `stream-json` | partial: `--json` NDJSON, one event per committed step; only `--json` and `--session-id` flags (`packages/bundle/headless/src/startup.ts:43-51`) |
| Continue, resume, fork | ✓ | ✓ | ✓ plus export | ✓ plus share | ✓ | partial: Web resume and fork; headless exact `--session-id` only; ACP cannot fork |
| Rewind code and conversation | ✓ `/rewind` | partial `/undo` `[UNCONFIRMED]` | ✓ `/rewind`, `/edit` | ✓ `/undo`, `/redo` | ✓ checkpoints, `/restore` | absent: "Branch" at a turn only; `workspace-changes` snapshots feed the diff card, not a revert |
| Steer or queue mid-turn | ✓ | ✓ | ✓ Enter steers, Alt+Enter queues | ? | ? | mounted (Web queue and steer) |
| Built-in slash commands | ✓ | ✓ about 45 | ✓ | ✓ | ✓ | partial: commands dispatch only from the Web composer; no `/help`, `/clear`, `/init`, `/rewind`, `/mcp`, `/agents`, `/hooks` |
| OS notifications | ✓ | ? | ? | ? | ? | absent: `Notification` is used only for mandatory updates (`apps/desktop/src/update-attention.ts:42-44`) |
| Tray, global shortcut | ? | ? | ? | – | – | absent |
| Statusline | ✓ scriptable | ✓ | ? | ? | partial | partial: context meter, not scriptable |
| Output styles | ✓ | – | – | partial | – | absent |
| Voice input | ✓ | ? | ? | ? | ? | unmounted (optional bundle, off) |
| Remote control from a phone | ✓ | – | ✓ (desktop) | – | – | absent |
| Browser the agent can drive | ✓ Chrome extension | ? | ✓ built-in (desktop) | – | – | partial: the Desktop sidebar browser serves the user only (`apps/desktop/src/browser-guests.ts`); browser-use providers unmounted |
| Scheduled tasks | ✓ Routines | ✓ Automations | ✓ (desktop) | – | ✓ via Action | unmounted: `packages/schedule` delivers only inside a live session |

### B. Safety and autonomy

| Mechanism | CC | CX | MM | OC | GM | dsh |
|---|---|---|---|---|---|---|
| Permission modes | default, acceptEdits, plan, dontAsk, bypass, auto | on-request, never, guardian review | Ask, Auto, Full access | allow/ask/deny per tool | policy engine plus approval modes | mounted: `read-only`, `workspace-write`, `danger-full-access`; no accept-edits mode; plan mode is prompt-only |
| Remembered approvals and rules | ✓ | ✓ prefix rules learned from approvals | ? | ✓ globs, last match wins | ✓ priority-ranked | absent: outcomes are allowed-once only; the kernel `PolicyDocument` is unmounted |
| Classifier auto-approval | ✓ auto mode | ✓ guardian | – | – | – | unmounted: `experimental/auto-review` uses the same model and runs full-access |
| OS sandbox | Seatbelt, bubblewrap | Seatbelt, bwrap+seccomp, Windows restricted tokens | ? | – `[UNCONFIRMED]` | Seatbelt, Docker/Podman | mounted: bwrap/Landlock, Seatbelt, Windows restricted token (file writes only; reads unconfined) |
| Network egress control | ✓ default-deny proxy | ✓ SOCKS proxy, `allowed_domains` | ? | – | ✓ proxied profiles | absent for shell; `web_fetch` allows public addresses only |
| Managed, non-overridable policy | ✓ managed settings | ✓ `requirements.toml` | ? | ? | ✓ policy engine, trusted folders | absent: every layer is user-writable |
| Prompt-injection defense | ✓ classifier | ✓ guardian | ? | doom-loop guard | trusted folders | unmounted: `guard/prompt-injection` (shadow) |
| Secret handling | deny rules | env vars matching KEY/SECRET/TOKEN excluded | ? | `.env` reads denied | ? | partial: child-process env scrub by name |

### C. Extensibility

| Mechanism | CC | CX | MM | OC | GM | dsh |
|---|---|---|---|---|---|---|
| Hooks | ✓ about 30 events; exit 2 or JSON blocks | ✓ 10 events | ✓ 12 events in plugins | ✓ 32+ plugin events | ✓ incl. BeforeModel, BeforeToolSelection | unmounted: CC bridge (7 events), Codex bridge (5); command hooks only; `continue:false` is recorded but not applied (`packages/hooks/hook-protocol/README.md:41,141`) |
| Skills (SKILL.md) | ✓ | ✓ | ✓ | ✓ reads `.claude/skills` | ✓ | mounted; project skills load only from `trustedProjectDirs`, default `[]` (`packages/skill/skill-filesystem/src/index.ts:88`); `.claude/skills` not scanned |
| Custom commands from files | ✓ | partial | ✓ skills as ACP commands | ✓ | ✓ TOML | absent (user-invocable skills are the substitute) |
| Custom agents from files | ✓ markdown | ✓ TOML | partial | ✓ markdown | ✓ | absent: agents are YAML presets; the Desktop/Web picker is hidden behind Developer tools |
| Plugins and marketplace | ✓ | ✓ private marketplaces | ✓ official, local, GitHub | ✓ npm | ✓ extensions | partial: `dsh plugin` (pnpm) and a Plugins page; no marketplace or catalog |
| MCP client | ✓ stdio/HTTP/SSE, OAuth | ✓ | ✓ | ✓ | ✓ | unmounted outside ACP; stdio and streamable HTTP only; no OAuth, no prompt templates, no management UI |
| Acting as an MCP server | ✓ | – (app-server) | ? | partial | – | absent |
| Memory files | CLAUDE.md chain, `@` imports, rules, auto memory | AGENTS.md chain, Memories | AGENTS.md via `init` | AGENTS.md | GEMINI.md, `/memory add` | mounted: AGENTS.md/CLAUDE.md chain plus global file; no `@path` imports, no rules directory, no quick-add, no `/init` |
| SDK | ✓ TS, Python | ✓ | ? | ✓ OpenAPI | ? | mounted: TS and Python over JSON-RPC |
| ACP | via adapter | via adapter | ✓ native | ✓ native | ✓ native | mounted: no command list, no fork, no file or terminal delegation to the client |
| IDE extensions | VS Code, JetBrains | VS Code, JetBrains | ACP editors | ACP editors | VS Code companion | absent (ACP only) |

### D. Coding quality

| Mechanism | CC | CX | MM | OC | GM | AD | dsh |
|---|---|---|---|---|---|---|---|
| Edit format | str_replace, write | `apply_patch` (V4A grammar) | ? | edit, write, apply_patch | replace, write | diff/whole/udiff | mounted: `edit` (literal old/new, `replace_all`) and `write`; no multi-edit, no `apply_patch` |
| Repo map | – | – | ? | – | – | ✓ tree-sitter + PageRank | absent |
| LSP diagnostics after edits | ✓ LSP tool | – | ? | ✓ after every edit | – | – | unmounted: 4 read operations only, no diagnostics (`packages/lsp/*`) |
| Code review mode | ✓ `/review`, `/security-review` | ✓ `/review` presets, separate `review_model` | ✓ | ? | via Action | – | absent |
| Test/lint loop | hooks | hooks | ✓ | LSP | hooks | ✓ `--auto-test`, `--auto-lint` | absent: kernel verifiers are unmounted |
| Git integration | PRs via `gh` | auto-worktrees (app) | ? | snapshots | checkpoints | ✓ commit per edit | partial: per-turn diff card only; no commit, branch, PR, or worktree tools |
| Background shell | ✓ plus Monitor | ? | ? | ? | ? | – | mounted: jobs with completion notices; no pattern-based wait |
| Goal with token budget | – | ✓ `/goal` | ✓ `/goal budget=…` | – | – | – | partial: `/goal` capped at 256 rounds, no token budget |
| Delegation to external agents | – | – | – | – | – | – | providers exist but ship disabled or unmounted (dsh-only capability) |

### E. Integration and operations

| Mechanism | CC | CX | MM | OC | GM | dsh |
|---|---|---|---|---|---|---|
| GitHub Action, `@mention` app | ✓ | ✓ | – | ✓ | ✓ | absent (only an example webhook overlay, `apps/cli/config/examples/github-review/`) |
| Cloud or background agents | ✓ web sessions, teleport | ✓ Codex cloud | ✓ remote control | – | – | absent: `packages/ssh/*` providers unmounted |
| Cost and telemetry | ✓ `/cost`, per-agent cost, OTel | ✓ `[otel]` | ? | ? | ? | partial: token and cache ledger without money amounts; session OTel exports only after explicit feedback |
| Diagnostics command | ✓ `/doctor` | ? | ? | ? | ? | absent (startup diagnostic files only) |
| Auto-update | ✓ | ✓ | ? | ? | ? | partial: Desktop only |
| Multi-provider | Anthropic, Bedrock, Vertex, Foundry | OpenAI plus custom | MiniMax plus custom endpoints | 75+ providers | Gemini | mounted: DeepSeek native plus pi-ai gateway (dormant until configured) |
| Agent teams | ✓ experimental | parallel threads | ✓ General/Coder/Verifier (desktop) | – | – | unmounted optional bundle (`experimental/agent-team`) |

## 30.4. Defects found during the inventory

| # | Defect | Location |
|---|---|---|
| 1 | `DEFAULT_APPROVAL_TOOLS` lists `terminal_spawn` and `terminal_kill`, which no longer exist. As a result `terminal_open`, `terminal_signal`, and `terminal_close` are never gated. `subagent_fork` is not gated either, because the list matches exact names. | `packages/interaction/permission-presets/src/index.ts:160-179` |
| 2 | Launcher help advertises `dsh tui --patch`, `dsh tui --resume`, and `dsh plugin --profile tui`, although the TUI package was removed | `apps/cli/src/args.ts:96-99`; commit `10bb9cbf4a` |
| 3 | A hook's `continue:false` is folded into a sticky stop and then not applied anywhere | `packages/hooks/hook-protocol/README.md:41,128,141` |
| 4 | The command registry is mounted in every base profile, but only the Web composer can dispatch commands; headless, SDK, and ACP cannot | `packages/interaction/commands`; `packages/acp/acp/src` |
| 5 | Project skills are skipped silently: `trustedProjectDirs` defaults to `[]`, and nothing asks the user to trust the folder | `packages/skill/skill-filesystem/src/index.ts:88` |
| 6 | Headless has no approval answerer and no permission flag. Every gated tool is refused unless the whole process runs with `DSH_PERMISSION_MODE=danger-full-access`. | `packages/bundle/base/cordis.patch.yml:231,247`; `packages/interaction/permission-presets/src/index.ts:344-357` |

## 30.5. Sources

- Claude Code: [checkpointing](https://code.claude.com/docs/en/checkpointing), [statusline](https://code.claude.com/docs/en/statusline), [memory](https://code.claude.com/docs/en/memory), [plugins](https://code.claude.com/docs/en/plugins), [sandboxing](https://code.claude.com/docs/en/sandboxing), [GitHub Actions](https://code.claude.com/docs/en/github-actions), [agent teams](https://code.claude.com/docs/en/agent-teams), [Remote Control](https://code.claude.com/docs/en/remote-control), [Chrome](https://code.claude.com/docs/en/chrome), [third-party integrations](https://code.claude.com/docs/en/third-party-integrations).
- Codex: [non-interactive](https://developers.openai.com/codex/noninteractive), [sandboxing](https://developers.openai.com/codex/concepts/sandboxing), [subagents](https://developers.openai.com/codex/subagents), [cloud](https://developers.openai.com/codex/cloud), [automations](https://developers.openai.com/codex/app/automations), [Windows](https://developers.openai.com/codex/windows), [auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review). Third-party reference: [slash commands](https://codex.danielvaughan.com/2026/05/19/codex-cli-slash-commands-complete-reference-v0131-45-commands/), [/goal](https://codex.danielvaughan.com/2026/05/07/codex-cli-goal-command-persisted-long-horizon-workflows-pause-resume-budget/), [hooks](https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/), [apply_patch V4A](https://codex.danielvaughan.com/2026/03/31/codex-cli-apply-patch-v4a-diff-format/), [review](https://codex.danielvaughan.com/2026/03/27/codex-cli-code-review-pr-integration/), [requirements.toml](https://codex.danielvaughan.com/2026/03/31/codex-cli-network-security-requirements-toml/).
- MiniMax Code: [repository](https://github.com/MiniMax-AI/minimax-code/), [features](https://agent.minimax.io/docs/cli/features), [plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins), [open-source announcement](https://technode.com/2026/09/21/minimax-open-sources-minimax-code-terminal-coding-agent/).
- OpenCode: [permissions](https://opencode.ai/docs/permissions/), [LSP](https://opencode.ai/docs/lsp/), [skills](https://opencode.ai/docs/skills/), [ACP](https://opencode.ai/docs/acp/), [GitHub](https://opencode.ai/docs/github/), [providers](https://opencode.ai/docs/providers/).
- Gemini CLI: [checkpointing](https://geminicli.com/docs/cli/checkpointing/), [headless](https://geminicli.com/docs/cli/headless/), [hooks](https://geminicli.com/docs/hooks/reference/), [policy engine](https://geminicli.com/docs/reference/policy-engine/), [sandbox](https://geminicli.com/docs/cli/sandbox/), [IDE integration](https://geminicli.com/docs/ide-integration/).
- Aider: [repo map](https://aider.chat/2023/10/22/repomap.html), [lint and test](https://aider.chat/docs/usage/lint-test.html).

---

# 31. Upgrade Backlog vs Leading Harnesses

**How to read the tables**

- Priority follows §23: P0 is Wave 1, P1 is Wave 2, P2 is Wave 3 (§32.1).
- Effort: S ≤ 3 person-days, M ≤ 10, L > 10.
- "Anchor" names the existing package to extend or reuse. Following §2.1, no item creates a parallel owner.
- "Runtime spec" refers to `specs/SPEC-EVOLUTIONARY-AGENT-RUNTIME.md` §32–§35.

## 31.1. Track D — Desktop product

The Desktop app is the interactive surface; there will be no terminal TUI (§32.4).

| ID | Mechanism | Reference | Anchor | Priority | Effort |
|---|---|---|---|---|---|
| D1 | OS notifications for: turn finished, approval needed, question asked, job finished. Clicking a notification focuses the session. | CC, MM desktop | `apps/desktop/src/update-attention.ts` (same pattern); agent status from the Host remote | P0 | S |
| D2 | Tray icon; global shortcut that opens a quick prompt; closing the window keeps agents running | MM desktop, CC | `apps/desktop/src/main.ts`, `single-instance.ts` | P1 | S–M |
| D3 | **Rewind** to a turn with a mode choice: code only, conversation only, or both. Includes edit-and-resend of the user message. | CC `/rewind`, GM checkpoints, OC snapshots, MM `/rewind` + `/edit` | turn snapshots of `packages/deliverables/workspace-changes`; the "Branch" action (`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx`); session fork | P0 | M |
| D4 | Hunk-level diff review of agent edits (accept or reject each hunk), with an optional "show diff before apply" | CC IDE diff, GM companion | `workspace-changes` diff card, `packages/client/ui-deliverables` | P1 | M |
| D5 | Parallel sessions, each isolated in its own git worktree, with a merge-back view | CX app auto-worktrees, CC `--worktree` | workspace entities (`packages/workspace/workspace`), session fork | P1 | M–L |
| D6 | Management screens: MCP servers, hooks, agents, commands, permission rules (including remembered grants), plugin marketplace browser | CC `/mcp` `/agents` `/hooks`, MM plugins | `packages/client/ui-settings-*`, `ui-plugin-manager` | P1 | M |
| D7 | The agent can drive the embedded browser through CDP (`webContents.debugger`). Each workspace keeps its own partition, and navigation or input actions need approval. | MM desktop browser, CC Chrome | `apps/desktop/src/browser-guests.ts`, `packages/experimental/browser-use-runtime` | P1 | M |
| D8 | Phone companion or remote control: authenticated pairing with the local Host; view sessions, answer approvals and questions | CC Remote Control, MM | `packages/api` remotes (RPC/SSE), `packages/host/webserver` trusted hosts | P2 | L |
| D9 | Scheduled routines that start new sessions while the Desktop app (or its tray) is running | MM scheduled tasks, CC Routines, CX Automations | `packages/schedule` (in-session today); Workspace Session creation in `packages/webhook/webhook` | P1 | M |
| D10 | Command palette, configurable keybindings, and a standard command set (`/help`, `/clear`, `/init`, `/rewind`, `/mcp`, `/agents`, `/hooks`, `/cost`, `/doctor`, `/review`) | CC, CX | `packages/client/ui-commands`, `ui-conversation` keymap | P1 | S |
| D11 | Full-text session search on by default in Desktop (`openAt: first-search` with a durable path) | CC resume picker | `packages/bundle/base/cordis.patch.yml:148-153`, `packages/bundle/web-app/cordis.patch.yml:27-30` (runtime spec W4) | P0 | S |
| D12 | Settings toggles for the voice-input and Agent Teams bundles | CC voice, CC teams, MM team roles | `packages/experimental/voice-input-bundle`, `client-ui-agent-team` | P2 | S |
| D13 | Cost in money, attributed per agent and per subagent | CC `/cost` | `packages/session/usage-ledger`; pricing data from `packages/llm/llm-pi-ai` | P1 | S |
| D14 | Doctor panel: sandbox availability, provider keys, MCP health, LSP servers, disk space | CC `/doctor` | `apps/cli/src/startup-diagnostics.ts` | P2 | S |

## 31.2. Safety and autonomy (SA)

| ID | Mechanism | Reference | Anchor | Priority | Effort |
|---|---|---|---|---|---|
| SA1 | Approval choices: once, for this session, or always. "Always" is stored as a workspace rule. Prefix rules are learned from approvals. This removes most repeated prompts. | CC rules, CX learned prefix rules | `packages/interaction/user-approval` outcomes; `permission-presets` `approvalTools`; kernel `PolicyDocument` | P0 | M |
| SA2 | Auto mode: a cheaper model classifies routine actions inside the sandbox and approves them; risky actions go to the user | CC auto mode, CX guardian | `packages/experimental/auto-review` (today: same model, full-access) | P1 | M |
| SA3 | Network egress control for shell: a default-deny proxy with a domain allowlist; the user is asked for a new domain | CC, CX, GM | `packages/sandbox/sandbox-local` (bwrap `--unshare-net` + proxy, Seatbelt network rules; Windows partial) | P1 | L |
| SA4 | Managed policy: an administrator-owned patch layer, applied last, that user layers cannot override. It covers the permission floor, allowed plugins and marketplaces, and telemetry. | CX `requirements.toml`, CC managed settings, GM policy engine | layering in `packages/boot/app-boot` | P2 | M |
| SA5 | Mount the kernel policy and the prompt-injection guard in Desktop | CC, CX | runtime spec §35 B0 | P0 | via runtime spec |
| SA6 | An `accept-edits` preset: file edits inside the workspace are approved automatically, shell commands still ask. Plan mode is enforced by policy. | CC acceptEdits and plan, MM Ask/Auto/Full | `packages/interaction/permission-presets`; runtime spec §35 B1 | P0 | S |
| SA7 | Deny reads of `.env*` and credential files by default; redact secrets in tool output | OC, CX env scrub | `packages/guard/prompt-injection` enforce mode | P1 | S |
| SA8 | Windows sandbox hardening: confine reads, optionally through AppContainer/LPAC | CX Windows | `packages/sandbox/sandbox-windows-acl` | P2 | L |
| SA9 | Fix the approval tool list (§30.4 #1) | — | `packages/interaction/permission-presets/src/index.ts:160-179` | P0 | S |

## 31.3. Extensibility ecosystem (EX)

| ID | Mechanism | Reference | Anchor | Priority | Effort |
|---|---|---|---|---|---|
| EX1 | Hooks mounted by default, see details below | CC (about 30 events), MM (12), GM (model-level hooks) | `packages/hooks/hook-protocol`, `hooks-claude-code`, `hooks-codex` | P0 | M |
| EX2 | Commands defined in files, see details below | CC, OC, GM TOML, MM skills as ACP commands | `packages/interaction/commands` | P0 | S–M |
| EX3 | Agents defined in files, see details below | CC, OC, CX TOML | `packages/preset/agent-preset-registry`, `packages/subagent/tool-subagent` | P0 | M |
| EX4 | Skills interop: scan `.claude/skills` and `~/.claude/skills`; replace the silent project-skill skip with a "Trust this folder?" prompt | CC and GM trusted folders; OC reads `.claude/skills` | `packages/skill/skill-filesystem` | P0 | S |
| EX5 | Plugin marketplace, see details below | CC, CX private marketplaces, MM, OC npm | `packages/boot/plugin-manager`, `dsh plugin` | P1 | L |
| EX6 | MCP completeness in three steps, see details below | CC, CX, MM, OC, GM | `packages/mcp/mcp-client`, `mcp-resources` | P0 / P1 / P2 | M |
| EX7 | Memory files: `@path` imports; path-scoped `.dsh/rules/*.md`; quick-add "remember this" into staged memory; `/init` generates AGENTS.md | CC, MM `mcode init`, GM `/memory add` | `packages/context/agent-instructions` | P1 | S |
| EX8 | Output styles (Explanatory, Learning, Concise, or user-defined in files) | CC | `packages/preset/persona` | P2 | S |
| EX9 | ACP completeness: available commands, fork, file and terminal delegation to the client | OC, GM, MM native ACP | `packages/acp/acp` | P1 | M |
| EX10 | Headless for CI, see details below | CC `-p`, CX `exec`, MM `exec` | `packages/bundle/headless/src/startup.ts` | P0 | M |

**EX1 details**

- Mount the hook bridges by default and discover hook configuration automatically from `.dsh/`, `~/.claude/settings.json`, `.claude/settings.json`, and `.codex/`.
- Add the missing events: SessionEnd, PreCompact, Notification, PermissionRequest, PermissionDenied, PostToolUseFailure.
- Add model-level hooks (BeforeModel, BeforeToolSelection) on the existing `agent/request` and `ctx.tools.restrict()` seams.
- Apply `continue:false`, which needs a run-level halt primitive.
- Support `http` hooks.

**EX2 details**

- Load commands from `.dsh/commands`, `.claude/commands`, and `~/.dsh/commands`. Frontmatter fields: `description`, `argument-hint`, `allowed-tools`, `model`.
- Dispatch commands from headless, SDK, and ACP, not only from the Web composer.

**EX3 details**

- Load agents from `.dsh/agents`, `.claude/agents`, and `.opencode/agents`. Frontmatter fields: name, description, tools, model, permission.
- Compile each agent into a preset or a subagent row.
- Show the preset picker in Desktop without Developer tools.
- Add an `agent` parameter to `subagent`.
- These are declarative presets, not a change to multi-agent concurrency, so they do not conflict with §28.

**EX5 details**

- A marketplace is a git repository or a JSON index.
- A plugin bundles skills, commands, agents, hooks, MCP servers, and Cordis rows.
- Installation uses the existing pnpm path.
- Administrators can allow or block plugins (SA4).
- Import the Claude Code plugin format where possible.

**EX6 details**

| Step | Priority | Scope |
|---|---|---|
| (a) | P0 | Mount by default; project `.mcp.json` and a user config; Desktop UI |
| (b) | P1 | OAuth 2.1, legacy SSE, prompt templates as slash commands, per-server trust |
| (c) | P2 | `dsh mcp serve`, exposing sessions and tools as an MCP server |

**EX10 details**

- Stream JSON per token.
- `--output-schema` for schema-constrained final output.
- Flags: `--model`, `--permission-mode`, `--max-turns`, `--system-prompt`, `--allowed-tools`, `--continue`, `--resume`.
- A permission flag that replaces the all-or-nothing environment override (§30.4 #6).

## 31.4. Coding quality (CQ)

| ID | Mechanism | Reference | Anchor | Priority | Effort |
|---|---|---|---|---|---|
| CQ1 | Append compact LSP diagnostics to every `edit`/`write` result. Auto-detect tsserver, pyright, gopls, and rust-analyzer; mount LSP. This cuts build-and-fix round trips. | OC, CC LSP tool | `packages/lsp/lsp-stdio` (add `publishDiagnostics`), `packages/lsp/tool-lsp` | P0 | M |
| CQ2 | `multi_edit` (several atomic edits in one file) and an optional `apply_patch` (V4A) selected per model route | CX, OC | `packages/fs/tool-fs` | P1 | M |
| CQ3 | Repo map (tree-sitter symbols ranked with PageRank), injected as a stable-core context source so the prompt cache stays stable. This reduces exploratory grep calls. | AD | runtime spec S2 (`ContextSourceRegistry`); §10.2 Repository Map | P1 | M–L |
| CQ4 | `/review` (diff against a branch, uncommitted changes, or a commit) run by an independent reviewer subagent with its own model; `/security-review`; a Desktop review panel | CX `/review` + `review_model`, CC | `packages/subagent/tool-subagent` with `output_schema`; `workspace-changes` diff; §10.6 Independent reviewer | P0 | M |
| CQ5 | Automatic test and lint loop after edits | AD `--auto-test`, CC and GM hooks | runtime spec S5/S6 and §35 B1; §8.1 Verifier Framework | P0 | via runtime spec |
| CQ6 | Git tools: commit with a generated message (optional commit per turn for trivial undo), branch, PR through `gh`, worktrees (D5) | AD auto-commit, CC | new tools over `packages/shell` and `packages/subprocess` | P1 | M |
| CQ7 | `monitor`: wait until a background job's output matches a pattern, instead of polling it | CC Monitor | `packages/jobs` | P2 | S |
| CQ8 | Architect/editor split (plan on `deepseek-v4-pro`, edit on `deepseek-flash`); a `consult` tool that asks a stronger model for a second opinion | AD architect mode, Amp Oracle | runtime spec §14.2 model router | P2 | M |
| CQ9 | `/goal` with a token budget and a status of achieved, blocked, or budget-exhausted | CX `/goal`, MM `budget=50K` | `packages/goal/goal`, `goal-round-driver` | P1 | S |

## 31.5. Integration and operations (IO)

| ID | Mechanism | Reference | Anchor | Priority | Effort |
|---|---|---|---|---|---|
| IO1 | A `dsh-action` GitHub Action (headless, stream-JSON) and an `@dsh` app for pull requests and issues | CC action, CX action, GM, OC | `packages/webhook/webhook-github`, EX10 | P1 | M |
| IO2 | Cloud or background agents: run sessions on a remote host over SSH or in a container, and hand a session over between Desktop and the remote host | CX cloud, CC web sessions and teleport | `packages/ssh/*` (`fs-ssh`, `subprocess-ssh`) | P2 | L |
| IO3 | Opt-in OTel metrics: tokens, cost, tool latency, approvals | CC, CX `[otel]` | `packages/host/product-telemetry-otel` (unmounted) | P2 | S |
| IO4 | Documented enterprise providers (Bedrock, Vertex, Azure) and proxy configuration | CC enterprise | `packages/llm/llm-pi-ai`, `packages/util/http-proxy` | P2 | S |
| IO5 | CLI auto-update (Desktop already has one) | CC, CX | `apps/cli` | P2 | S |

---

# 32. Integration with Milestones and Priorities

## 32.1. Waves

**Wave 1 (P0, about 4–5 weeks)**

Most of this wave is mounting, configuration, and wiring of code that already exists:

- Desktop: D1, D3, D11
- Safety: SA1, SA6, SA9
- Extensibility: EX1, EX2, EX3, EX4, EX6 (a), EX10
- Coding: CQ1, CQ4

SA5 and CQ5 are delivered through the runtime spec (§35 B0 and B1).

**Wave 2 (P1)**

- Desktop: D2, D4, D5, D6, D7, D9, D10, D13
- Safety: SA2, SA3, SA7
- Extensibility: EX5, EX6 (b), EX7, EX9
- Coding: CQ2, CQ3, CQ6, CQ9
- Integration: IO1

**Wave 3 (P2)**

- Desktop: D8, D12, D14
- Safety: SA4, SA8
- Extensibility: EX6 (c), EX8
- Coding: CQ7, CQ8
- Integration: IO2, IO3, IO4, IO5

## 32.2. Milestone placement

Two tracks run alongside M0–M9 (§22).

**Track D — Desktop product**

| Milestone | Items |
|---|---|
| D-M1 | D1, D3, D11 |
| D-M2 | D2, D4, D6, D10, D13 |
| D-M3 | D5, D7, D9 |
| D-M4 | D8, D12, D14 |

**Track X — Ecosystem and integration**

| Milestone | Items |
|---|---|
| X-M1 | EX1, EX2, EX3, EX4, EX6 (a), EX10 |
| X-M2 | EX5, EX6 (b), EX7, EX9, IO1 |
| X-M3 | EX6 (c), EX8, IO2–IO5 |

**Items that land inside existing milestones**

| Milestone | Items |
|---|---|
| M1 Safe Agent | SA1, SA2, SA3, SA5, SA6, SA7, SA9 |
| M3 Reliable Agent | CQ5 |
| M4 Context-Aware Agent | CQ3 (with EX7) |
| M5 High-Quality Coding Agent | CQ1, CQ2, CQ4, CQ6, D4, D5 |
| M6 Multi-Agent System | EX3 (roles), CQ8 |

**Ordering constraint.** §28 says repository intelligence and multi-agent expansion wait until sprint items 1–12 are stable. That still holds for CQ3 and CQ8. The Wave 1 items do not add new control logic to the loop, so they may proceed in parallel with §28.

## 32.3. Priority matrix additions (extends §23)

| Priority | Mechanism | Target value |
|---|---|---|
| P0 | Remembered approvals and the accept-edits mode (SA1, SA6) | Fewer interruptions without widening authority |
| P0 | Rewind code and conversation (D3) | Cheap recovery from wrong turns |
| P0 | Hooks, file commands, file agents, skills interop (EX1–EX4) | Compatibility with the CC/Codex ecosystems |
| P0 | MCP mounted with configuration and UI (EX6 a) | Access to external tools |
| P0 | LSP diagnostics after edits (CQ1) | Fewer build-and-fix loops |
| P0 | Review mode (CQ4) | Higher defect discovery (§10.6) |
| P0 | Headless CI flags and stream-JSON (EX10) | Reliable automation |
| P1 | Classifier auto mode and network egress control (SA2, SA3) | Safe unattended runs |
| P1 | Plugin marketplace (EX5) | Distribution of extensions |
| P1 | Worktree-isolated parallel sessions (D5) | Parallel work without conflicts |
| P1 | GitHub Action (IO1) | CI and pull-request integration |
| P2 | Remote control, cloud agents (D8, IO2) | Work continues away from the desk |

## 32.4. Non-goal additions (extends §24)

- A terminal TUI. Decision of 2026-09-23: the Desktop app is the interactive product, headless covers scripts, and ACP covers editors.
- A hosted marketplace service in the first iteration. A marketplace is a git repository or a JSON index.
- Copying another harness's permission model by tool name alone. Rules compile into the kernel capability policy of the runtime spec.

## 32.5. Success criteria additions (extends §27)

### Parity

- A user can rewind code and conversation to any turn from Desktop.
- An approval answered "always" is not asked again within its scope.
- Claude Code hooks, commands, agents, and skills in a repository work without conversion.
- MCP servers configured in `.mcp.json` are available in Desktop, headless, SDK, and ACP.
- An edit that introduces a type error returns the diagnostic in the same tool result.
- `/review` produces findings from an independent context.
- Headless supports stream-JSON, a schema-constrained final output, and the CI flags of §31.3 EX10.
- Desktop notifies the user when a turn finishes or needs approval.

## 32.6. Relationship to SPEC-EVOLUTIONARY-AGENT-RUNTIME.md

| Item in this spec | Relationship to the runtime spec |
|---|---|
| SA5, SA6 | Kernel mounting (§35 B0) and plan mode as a policy profile (§35 B1) |
| CQ5 | Task classes, verifiers, gate, and repair budget (S5, S6, §35 B1) |
| D3 | Moves file rewind from Wave C (§35.2) to P0 |
| D11 | Same change as W4 (§34.2) |
| CQ3 | Uses the S2 context source registry, so the repo map does not break prompt caching (S1) |
| CQ8 | Uses the §14.2 model router |

When the two specifications overlap, the runtime spec owns the control-plane contract, and this section owns the product surface.

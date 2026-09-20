# DeepSeek Harness Evolutionary Agent Runtime

## Implementation Specification

**Status:** proposed implementation baseline  
**Repository audited:** `https://github.com/quockhangluong1012/deepseek-harness`  
**Audited revision:** `85d814676cb06eb723487e09313d7178ffad970a` (`feat(memory): implement episodic notes retention and management`, 2026-09-16)  
**Scope:** runtime evolution, not a second agent loop  
**Normative labels:** `[CONFIRMED]`, `[PROPOSED]`, `[REFACTOR]`, `[REMOVE]`, `[EXTERNAL BENCHMARK]`

This document is deliberately source-grounded. A statement labelled `[CONFIRMED]` is an observation of the audited checkout, including its path and public symbol. A statement labelled `[PROPOSED]` is a target contract. `[REFACTOR]` means an existing mechanism remains the owner but its seam or representation changes. `[REMOVE]` means delete, merge, or demote an abstraction after migration. `[EXTERNAL BENCHMARK]` records a useful mechanism from Codex, Claude Code, OpenCode, or MiniMax Code; it is not evidence that the fork already implements it.

## 1. Executive summary

DeepSeek Harness already has a substantially more mature substrate than a generic “LLM plus tools” wrapper. It has an all-plugin Cordis composition model, a durable Session event log, a real agent registry and factory, an event-driven `ReactLoopAgent`, scoped tool registration, model adapters, sandbox and approval services, compaction, memory, skills, hooks, workflows, subagents, and an evolutionary package family.

The central architectural problem is not missing features. It is missing semantic ownership across those features. The loop owns execution, the Session owns durable facts, individual packages own local policy, and evolution packages own learning artifacts, but there is no single runtime contract that answers all of these questions:

1. What is the current task state and who may change it?
2. When does a model proposal become an authorized action?
3. Which capability grant, policy decision, approval, and sandbox boundary were used?
4. What evidence is sufficient to verify completion?
5. How are a failure, a stalled run, a budget ceiling, or a process restart classified and resumed?
6. Which trajectory facts are safe to promote into memory, skills, policies, or model-routing rules?

The target is therefore a thin **Agent Kernel / Governor plane** wrapped around the existing execution substrate:

```text
User / CLI / Web / SDK / ACP
              |
              v
        Task Contract
              |
              v
      Agent Kernel (new)
  state + policy + capability
  budget + verification + recovery
              |
       proposal / decision
              |
  +-----------+-------------+
  |                         |
  v                         v
Existing Agent Loop     Knowledge Plane
ReactLoopAgent          context / memory / evidence
  |                         |
  v                         v
Existing tools, LLM,     verifier / completion gate
FS, shell, sandbox, MCP        |
              +---------------+
              v
    Session events + traces + evaluation
              |
              v
       Evolution promotion
```

The invariant is: **do not replace `packages/core/agent-loop`; intercept and observe it through its existing event and service seams.** Existing lifecycle ownership remains authoritative.

## 2. Repository audit and architecture baseline

### 2.1 Composition model [CONFIRMED]

- `README.md` describes an “everything-is-a-plugin” architecture powered by Cordis and identifies the project as a developer preview.
- `docs/architecture.md` states that model adapters, tool registry, session log, and agent loop are plugins. Profiles are ordered bundle layers (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`) resolved by `dsh`.
- `packages/boot/app-boot` composes profile and patch layers; `packages/bundle/*` provide product compositions. Application launch is intentionally centralized at the `dsh` CLI.
- A plugin contributes services, typed events, prompt sections, capability providers, and reversible Cordis effects. This is the correct extension model for the target runtime.

### 2.2 Product API spine [CONFIRMED]

The repository explicitly identifies these packages as the spine in `docs/architecture.md`:

| Existing owner | Path | Confirmed responsibility | Evolution decision |
|---|---|---|---|
| Session | `packages/core/session` | Append-only event log, replay, surface derivation, persistence seam | `[KEEP]`; add kernel events through `SessionEventMap` |
| System prompt | `packages/core/system-prompt` | Prompt sections, variables, tool-schema assembly | `[REFACTOR]` behind a Context Compiler adapter |
| Tools | `packages/core/tools` | Scoped registry, schema, pre/execute/post waterfalls | `[KEEP]`; add capability and provenance metadata |
| Agent | `packages/core/agent` | `Agent`, `AgentRegistry`, `AgentFactory`, ownership and lifecycle | `[KEEP]`; expose kernel attachment |
| Agent loop | `packages/core/agent-loop` | `ReactLoopAgent`, turn/step flow, request preparation, tool concurrency, cancellation | `[KEEP]`; do not fork |
| LLM | `packages/llm/llm` | `LlmAdapter`, message vocabulary, retries, stream protocol | `[KEEP]`; model router selects adapters above it |

### 2.3 Durable Session model [CONFIRMED]

`packages/core/session/src/types.ts` defines branded `SessionId`, `SessionSeq`, `SessionLogOffset`, `SessionHeader`, cancellation and turn-end reason types, and `SESSION_FORMAT_VERSION = 3`. The event map is open for package augmentation. Session persistence and adjacent migrations live under `packages/session/session-format-*`, `packages/session/session-persistence`, and `packages/session/session-persistence-jsonl`.

`docs/architecture.md` makes a strong invariant explicit: anything model-visible must be reconstructable from the Session log. `deriveMessages()` is the model-history projection; session projections provide typed read models without replacing the log. This is the correct basis for checkpointing, audit, replay, and deterministic evolution experiments.

### 2.4 Agent lifecycle [CONFIRMED]

`packages/core/agent/src/types.ts` exposes `Agent` as a Session-backed identity. `packages/core/agent/src/index.ts` provides:

- `CreateAgentOptions` and `ResumeAgentOptions` with parent lineage, `cwd`, fork seed, `delegationDepth`, `agentPreset`, and setup transactions;
- `AgentHandle.dispose()` as the lifecycle capability;
- `AgentFactory.createAgent()` and `.resume()`;
- unpublished setup followed by an exact publication boundary;
- rollback on setup/commit/owner-disposal failure.

This is already a strong transactional creation seam. The target must attach kernel state after setup and before first model request, not create a parallel “runtime agent” identity.

`packages/core/agent-loop/src/agent.ts` implements `ReactLoopAgent`. It owns inbox insertion, follow-up and steer messages, injection, cancellation, maintenance, phase/status transitions, idle completion, and loop wake-up. `packages/core/agent-loop/src/index.ts` validates `maxParallelToolCalls`, `maxSteps`, `maxRequestRetries`, token limits, publication, disposal, and turn-boundary projection.

### 2.5 Existing turn and tool flow [CONFIRMED]

The documented flow in `docs/architecture.md` is:

```text
turn/start
  claim next-step input and queued message
  assemble system sections + tool schemas + runtime context
  agent/pre-step        (rewrite/reject/enter)
  step/start
  agent/request         (prepare route/call)
  request/header + request/context
  derive and freeze model history
  llm stream
  assistant/message or assistant/attempt
  tools/pre-execute
  tools/execute
  tools/post-execute
  tool/result
  step/end
  next step or agent/turn-stopping
turn/end
```

`packages/core/tools` exposes a scoped `ToolDefinition`, JSON-value schema DSL, restrictions, and the waterfalls `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `tools/result`, and `tools/ptc-dispatch-log`. Tool execution is therefore already interceptable without changing the loop.

### 2.6 Model and context assembly [CONFIRMED]

`packages/llm/llm/src/index.ts` exports message/content types, `PreparedLlmCall`, `PreparedAdapterCall`, `LlmAdapter`, `LlmError`, retry policy, and stream primitives. `packages/core/system-prompt` assembles prompt sections and tool schemas. Runtime context is projected into the request and logged when model-visible.

The repository already has a basic compiler pipeline spread across:

- `packages/context/agent-instructions`, `time-context`, `session-reference`, `file-reference`, `tmux-context`, and `workspace-memory-context`;
- `packages/context/active-memory-context` and `evolution-memory-context`;
- `packages/core/system-prompt`;
- `packages/compaction/compaction` and `compaction-basic`;
- `packages/compaction/compaction-tool-result-pruner`.

This is capability-rich but semantically fragmented. It needs a single ranked input/output contract, not a replacement implementation.

### 2.7 Filesystem, sandbox, permissions, and approvals [CONFIRMED]

- `packages/fs/fs/src/index.ts` defines the `FileSystem` service seam (`resolve`, `stat`, `readText`, `readBytes`, `listDir`, write/edit methods, and containment helpers).
- `packages/fs/fs-local` provides the local backend.
- `packages/fs/fs-sandbox` provides `SandboxedFileSystem`, injected with `sandboxPolicy`, and checks write/edit targets.
- `packages/fs/fs-observation-policy` tracks observed versions and emits write/edit intents, preventing stale writes.
- `packages/sandbox/sandbox-policy/src/index.ts` defines `SandboxPolicyService`, deployment modes `read-only`, `workspace-write`, and `danger-full-access`, session override projection, absolute workspace roots, and runtime-context rendering. It is the single owner of the file policy, while enforcing backends remain separate.
- `packages/interaction/user-approval/src/index.ts` defines `ApprovalService`, policies `ask` and `never`, request/outcome audit events, fail-closed behavior, open-turn enclosure, and user-facing runtime context.
- `packages/interaction/permission-presets/src/index.ts` defines permission presets, settings, sandbox/approval knobs, and `requiresApproval()` for tool classes.

The distinction between technical sandbox and governance approval is already present and must be preserved. What is missing is a common action/capability decision record joining them.

### 2.8 Hooks and prompt-injection boundary [CONFIRMED]

`packages/hooks/hook-protocol` owns matcher, codec, runner, timeout, output merge, detached-run, and hook audit helpers. `packages/hooks/hooks-codex` and `packages/hooks/hooks-claude-code` attach to `agent/session-start`, `agent/pre-step`, `tools/pre-execute`, and `tools/post-execute`, with configured timeouts and bounded stderr summaries.

The hook boundary is powerful but output is still just a merged decision/context contribution. A target security plane must assign provenance/trust and prevent hook output or tool output from silently becoming trusted user policy.

### 2.9 Skills, plugins, MCP, and profiles [CONFIRMED]

- `packages/skill/skill` defines `SkillSource`, `SkillSummary`, `SkillCandidate`, `SkillBlueprint`, `SkillDefinition`, invocation policy, lookup, and registration interfaces.
- `packages/skill/skill-filesystem` discovers local and project skills, scans files, records findings, and marks untrusted project content.
- `packages/skill/tool-skill`, `skill-badge`, `evolution-skill-manage`, and `evolution-skill-telemetry` provide model/user invocation and evolutionary management.
- `packages/mcp/mcp-client` supplies an MCP client integration boundary.
- `packages/llm/plugin-package-inventory-deepseek` and profile/bundle packages supply plugin inventory and composition.

Skills and plugins are not merely prompt files: they have provider, source, invocation policy, discovery, and telemetry. The target should formalize admission and capability grants rather than add another loader.

### 2.10 Subagents and workflows [CONFIRMED]

`packages/subagent/subagent/src/index.ts` exports `SubagentRuntime`, provider registration, continuable start, child listing, run settlement, max-depth checks, delegated policy overrides, and child-agent composition. Providers include in-process fork/spawn, ACP, Codex, Claude Code, and DSH SDK adapters.

`packages/experimental/agent-team` is a durable opt-in coordination seam. `TeamService` owns roster, mailbox, task board, compare-and-set task revisions, lifecycle, recovery, and Team session events. This is more robust than an unstructured “spawn N agents” helper.

`packages/workflow/workflow/src/index.ts` defines the abstract `WorkflowEngine`, `WorkflowRun`, `WorkflowStartRequest`, workflow event names, error codes, and fatality classification. Worker-thread and tool adapters live in `packages/workflow/workflow-worker-thread` and `tool-workflow`.

### 2.11 Compaction, budgets, recovery primitives [CONFIRMED]

- `packages/compaction/compaction` defines `CompactionEngine`, `CompactionResult`, triggers `pressure` and `context-overflow`, compact checkpoints, and maintenance context.
- `packages/compaction/compaction-basic` implements `BasicCompactionEngine` with LLM summarization, token-meter integration, automatic compaction, and overflow retry handling.
- `packages/compaction/compaction-tool-result-pruner` reduces tool-result retention.
- `packages/guard/budgets` observes Session events and `agent/pre-step`, enforcing total tokens, tool calls, wall time, and cost ceilings.
- `packages/llm/llm-retry` owns provider retry policy; `packages/guard/timeout-policy` owns timeout behavior; `packages/core/agent-loop` owns request retries and cancellation.

These are useful owners, but retry, budget, timeout, and failure taxonomy are not yet represented as one runtime decision ledger.

### 2.12 Memory and evolution [CONFIRMED]

The repository has an unusually complete evolution surface:

| Package | Confirmed role |
|---|---|
| `packages/workspace/workspace-memory` | bounded description, instructions, memory, context items, outputs, storage domain |
| `packages/workspace/workspace-memory-llm` | LLM extraction/rebuild of workspace memory |
| `packages/evolution/evolution-memory` | scoped artifacts/lessons, digests, merge, maintenance, storage domain |
| `packages/context/active-memory-context` | periodic graph/relevance recall into model context |
| `packages/context/evolution-memory-context` | memory/skill nudges and digest-based injection |
| `packages/evolution/evolution-trajectory` | ShareGPT/trajectory export |
| `packages/evolution/evolution-scorer` | scenario/session scoring, statistics, trigger and runner |
| `packages/evolution/evolution-reviewer` | post-turn review, extraction, recall, artifact writing |
| `packages/evolution/evolution-curator` | lesson/skill admission and curation |
| `packages/evolution/evolution-optimizer` | mutation operators, candidates, holdouts, budgets, Pareto/survivor selection |
| `packages/evolution/evolution-graph` | graph-shaped retrieval and relationships |
| `packages/evolution/evolution-dreaming` / `heartbeat` | background maintenance/scheduling |
| `packages/evolution/evolution-feedback` | feedback capture and signals |
| `packages/evolution/evolution-controller` | evolutionary control plane |

The gap is not “add memory”. The gap is connecting immutable trajectory facts, evidence, verification outcome, and promotion gates into an explicit causal lineage.

## 3. Current control and data flow

```text
Profile + Cordis patches
        |
        v
Plugin tree / services / scoped agent context
        |
        +--> AgentRegistry + AgentFactory
        |       |
        |       +--> ReactLoopAgent
        |               |
        |               +--> Session append-only log
        |               +--> agent/* waterfalls/events
        |               +--> SystemPrompt + context injections
        |               +--> LlmAdapter stream
        |               +--> ToolRuntime waterfalls
        |                       |
        |                       +--> FS / shell / subprocess / terminal / web / MCP
        |                       +--> sandboxPolicy + approval + observation policy
        |               +--> Compaction + token meter + retry + budgets
        |
        +--> Session projections --> UI/API/remote readers
        +--> Evolution reviewers/scorers/memory/optimizer
        +--> SubagentRuntime / TeamService / WorkflowEngine
```

### Current strengths

- durable facts are separated from transient stream frames;
- lifecycle ownership and rollback are explicit;
- capability providers are swappable through Cordis;
- tool execution and request assembly are interceptable;
- sandbox and approval already fail closed in important paths;
- session format migration is adjacent and monotonic;
- evolutionary work has real storage, scoring, optimization, and telemetry packages.

### Current control gaps

1. **No canonical task contract.** Goals, plans, todo items, workflow runs, and Team tasks coexist without one runtime-owned objective/acceptance representation.
2. **No canonical state machine.** Turn/step state is formal, but task-level planning, verification, recovery, and completion state is distributed among prompts, goals, plans, workflows, and evolution packages.
3. **No universal proposal ledger.** Model actions are visible as tool calls, but a typed record does not consistently capture proposal, risk, capability grant, policy result, approval, execution, observation, and commit.
4. **Policy is split by family.** `sandboxPolicy`, `ApprovalService`, `PermissionPresetService`, tool restrictions, FS observation, and provider-specific checks all decide different parts of authority.
5. **Context is assembled by many contributors.** System prompt, runtime context, injections, active memory, evolution memory, file references, and compaction are individually sound but lack one ranking/conflict/trust budget contract.
6. **Verification is not a universal completion gate.** Some tools/tests/workflows verify locally, but the harness has no required `VerificationPlan`/`CompletionDecision` for all task classes.
7. **Failure taxonomy is fragmented.** LLM errors, tool results, workflow errors, timeout policy, budget ceilings, and subagent settlement have different vocabulary.
8. **Research semantics are absent.** Web/search/fetch capabilities exist, and evolution graph exists, but there is no canonical Evidence → Claim → Hypothesis → Verification graph.
9. **Evolution promotion needs stronger causality.** Optimizer and curator have useful mechanisms, but promotion must be tied to replayable trajectories, holdouts, policy review, and rollback preimages.

## 4. Keep / refactor / remove decisions

| Decision | Existing component | Action |
|---|---|---|
| `[KEEP]` | Cordis plugin composition and profile layering | Make kernel a plugin family; do not introduce a privileged monolith |
| `[KEEP]` | `core/session` and session projections | Add kernel/evidence events; preserve log and projection ownership |
| `[KEEP]` | `core/agent` + `core/agent-loop` | Attach kernel via events and per-agent scope; no second driver |
| `[KEEP]` | `core/tools` waterfalls | Make them the execution seam for action authorization and provenance |
| `[KEEP]` | `llm/llm` adapter protocol | Add routing hints and cost metadata at adapter boundary |
| `[KEEP]` | `sandbox/sandbox-policy` | Reuse as technical boundary resolver |
| `[KEEP]` | `interaction/user-approval` | Reuse as human governance resolver; add policy decision linkage |
| `[REFACTOR]` | `interaction/permission-presets` | Compile presets into a common capability policy DSL |
| `[REFACTOR]` | `system-prompt` + context packages | Add `ContextCompiler` facade and ranked source envelopes |
| `[REFACTOR]` | `guard/budgets`, retry, timeout | Emit common `BudgetDecision` and `FailureRecord`; retain local enforcement |
| `[REFACTOR]` | compaction | Make compaction produce a checkpoint with retained facts and lineage |
| `[REFACTOR]` | skills/filesystem | Add trust, admission, capability requirements, version, and rollback metadata |
| `[REFACTOR]` | subagent providers | Require child policy intersection and explicit delegation receipt |
| `[REFACTOR]` | evolution reviewer/curator/optimizer | Gate promotion on evidence, holdouts, provenance, and reversible artifacts |
| `[KEEP]` | experimental Agent Teams | Promote only after kernel delegation contracts are adopted; no rewrite now |
| `[KEEP]` | workflow engine | Adapt to task contracts and checkpoint/resume; retain worker-thread provider |
| `[REMOVE]` | any new parallel `AgentLoop` or `RuntimeAgent` identity | Delete design proposals that fork `ReactLoopAgent` lifecycle |
| `[REMOVE]` | duplicate retry/timeout/budget counters | Merge into common ledger; retain provider-local mechanics only |
| `[REMOVE]` | prompt-only permissions | Convert security-relevant authority to runtime policy; prompts remain explanatory |
| `[REMOVE]` | generic “memory note” with no source/utility/expiry | Migrate to typed artifact/evidence records or discard |
| `[DEMOTE]` | fixed memory capacities, fixed dreaming schedules, one optimizer (for example GEPA) | Keep as configurable strategies, not architecture invariants |
| `[DEMOTE]` | graph/vector/QMD as mandatory storage | Keep behind retrieval provider seam; do not force one index |

## 5. Target architecture

### 5.1 Planes and ownership [PROPOSED]

```text
Control plane
  AgentKernel
  TaskContractStore
  StateMachine
  PolicyEngine
  CapabilityRegistry
  BudgetGovernor
  VerificationGate
  RecoveryEngine

Execution plane (existing owners)
  AgentRegistry / ReactLoopAgent
  LlmAdapter
  ToolRuntime
  FS / shell / subprocess / terminal / web / MCP
  SubagentRuntime / WorkflowEngine

Knowledge plane (existing + new contracts)
  ContextCompiler
  WorkspaceMemoryStore
  EvolutionMemoryStore
  EvidenceStore / ClaimStore / HypothesisStore
  Artifact and repository references
  Compaction checkpoints

Governance plane
  SandboxPolicyService
  ApprovalService
  PromptInjectionGuard
  HookEngine
  Skill admission
  Audit and redaction

Observation plane
  Session events / projections
  Trace spans
  usage ledger / token meter / cost
  trajectory export / evaluation

Evolution plane
  Reviewer / scorer / curator / optimizer / graph / dreaming / heartbeat
  replay / holdout / shadow / promotion / rollback
```

### 5.2 Existing-ownership invariant [PROPOSED]

The following owners are normative:

```text
Agent lifecycle       -> core/agent + core/agent-loop
Durability            -> core/session + session persistence
Tool execution        -> core/tools
Model calls           -> llm/llm
File policy           -> sandbox/sandbox-policy
Human approval        -> interaction/user-approval
Prompt sections       -> core/system-prompt
Subagent lifecycle    -> subagent/subagent
Workflow lifecycle    -> workflow/workflow
```

`AgentKernel` may observe, veto, annotate, and request transitions. It may not create a second owner for any row above.

## 6. Agent Kernel and state machine

### 6.1 Task contract [PROPOSED]

```ts
type TaskId = Branded<'TaskId'>
type RunId = Branded<'RunId'>

interface TaskContract {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly objective: string
  readonly constraints: readonly Constraint[]
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly workspace?: WorkspaceRef
  readonly parentTaskId?: TaskId
  readonly agentProfile: string
  readonly policyProfile: string
  readonly budget: ResourceBudget
  readonly status: TaskStatus
  readonly revision: number
}

type TaskStatus =
  | 'intake' | 'understanding' | 'retrieving' | 'planning' | 'ready'
  | 'executing' | 'observing' | 'verifying' | 'recovering'
  | 'awaiting-approval' | 'awaiting-user' | 'paused'
  | 'completed' | 'failed' | 'cancelled'
```

The task contract is a projection-backed record. The source of truth is new `task/*` Session events, not a mutable in-memory singleton.

### 6.2 Formal transition [PROPOSED]

```ts
interface StateTransition {
  readonly transitionId: string
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly trigger: TransitionTrigger
  readonly preconditions: readonly Predicate[]
  readonly effects: readonly StateEffect[]
  readonly evidence: readonly EvidenceRef[]
  readonly policyDecisionId?: string
  readonly actor: 'user' | 'model' | 'kernel' | 'tool' | 'system'
}
```

Allowed high-level transitions:

```text
intake -> understanding -> retrieving -> planning -> ready
ready -> executing -> observing -> executing
observing -> verifying
observing -> recovering
recovering -> executing | planning | awaiting-user | failed
verifying -> completed | recovering | awaiting-user
any active state -> awaiting-approval | paused | cancelled
```

The kernel rejects transitions that do not satisfy the current task revision, budget, policy, or acceptance prerequisites. Recovery may amend the plan only by emitting a new plan revision with a failure reference.

### 6.3 Kernel API [PROPOSED]

```ts
interface AgentKernel {
  snapshot(agent: Agent): Promise<AgentSnapshot>
  intake(input: TaskInput): Promise<TaskContract>
  propose(proposal: AgentProposal): Promise<KernelDecision>
  authorize(action: ActionProposal): Promise<AuthorizationDecision>
  commit(action: AuthorizedAction, result: ActionResult): Promise<Observation>
  verify(request: VerificationRequest): Promise<VerificationResult>
  recover(failure: FailureRecord): Promise<RecoveryDecision>
  checkpoint(reason: CheckpointReason): Promise<CheckpointRef>
  resume(checkpoint: CheckpointRef): Promise<ResumeDecision>
}
```

`propose()` is not a second model call. It is the semantic boundary around the existing `agent/pre-step`, `agent/request`, and `tools/pre-execute` hooks.

## 7. Agent loop integration

### 7.1 Integration map [REFACTOR]

| Kernel concern | Existing seam |
|---|---|
| begin/resume task | `agent/session-start`, `AgentRegistry.create/resume` |
| intake and plan injection | `agent.inject()`, `agent/pre-step` |
| request authorization | `agent/request`, `agent/request-error` |
| action proposal | `tools/pre-execute` |
| execution outcome | `tools/post-execute`, `tools/result`, `session/event` |
| cancellation | `Agent.cancel`, `turn/end` reason |
| turn boundary | `turnBoundaryProjectionDefinition` |
| maintenance | `Agent.runMaintenance()` and compaction/evolution services |

### 7.2 Loop adapter [PROPOSED]

```ts
class KernelAgentObserver {
  static inject = ['agents', 'sessions', 'tools', 'systemPrompt']

  onSessionStart(event: AgentSessionStart): void
  onPreStep(event: AgentPreStep, next: Next): Promise<PreStepDecision>
  onRequest(event: AgentRequest, next: Next): Promise<RequestDecision>
  onToolPreExecute(event: ToolExecution, next: Next): Promise<PreToolDecision>
  onToolPostExecute(event: ToolExecution, result: ToolResult, next: Next): Promise<PostToolDecision>
  onTurnStopping(event: TurnStopping): Promise<void>
}
```

The adapter must preserve waterfall ordering and call `next()` exactly once unless it rejects/terminates. All kernel decisions are append-only audit events before or at the existing commit boundary.

### 7.3 Action proposal and commit [PROPOSED]

```ts
interface ActionProposal {
  readonly actionId: string
  readonly agentId: SessionId
  readonly toolName: string
  readonly arguments: JsonValue
  readonly source: 'model' | 'workflow' | 'subagent' | 'user'
  readonly taskRevision: number
  readonly trust: TrustLabel
}

interface AuthorizationDecision {
  readonly effect: 'allow' | 'ask' | 'deny'
  readonly capabilityGrantIds: readonly string[]
  readonly sandbox: SandboxExecutionPolicy
  readonly approvalRequestId?: ApprovalRequestId
  readonly reasons: readonly string[]
  readonly expiresAt?: string
}
```

Execution is committed only after the existing tool runtime returns a result and the kernel emits an observation. A denied action must not be disguised as a tool failure.

## 8. Context Compiler and compaction

### 8.1 Compiler contract [PROPOSED]

```ts
interface ContextCompiler {
  compile(input: ContextInput): Promise<CompiledContext>
}

interface ContextInput {
  readonly task: TaskContract
  readonly agent: AgentSnapshot
  readonly plan?: PlanRevision
  readonly session: SessionContext
  readonly sources: readonly ContextSource[]
  readonly budget: ContextBudget
  readonly route: LlmRoute
}

interface ContextSource {
  readonly id: string
  readonly kind: 'policy' | 'task' | 'plan' | 'memory' | 'evidence' | 'artifact' | 'history' | 'tool'
  readonly content: string
  readonly trust: TrustLabel
  readonly provenance: Provenance
  readonly relevance: RelevanceScore
  readonly expiresAt?: string
}

interface CompiledContext {
  readonly messages: readonly ModelMessage[]
  readonly included: readonly ContextSource[]
  readonly omitted: readonly ContextOmission[]
  readonly tokenEstimate: number
  readonly digest: string
  readonly compilerVersion: string
}
```

Pipeline:

```text
collect -> classify trust -> retrieve -> rank
       -> conflict check -> deduplicate -> compress
       -> fit token budget -> order stable prefix -> compile
       -> log digest and selected provenance
```

Policy and task contract sources outrank tool output. Untrusted repo/web/MCP content is data, never an instruction authority. The compiler must retain a short conflict report when two high-ranked sources disagree.

### 8.2 Compaction [REFACTOR]

`BasicCompactionEngine` remains the provider. It must return a `CompactionCheckpoint` containing:

```ts
interface CompactionCheckpoint {
  readonly checkpointId: string
  readonly sourceSeqRange: { readonly start: number; readonly end: number }
  readonly retainedFacts: readonly RetainedFact[]
  readonly droppedToolResultIds: readonly string[]
  readonly openWork: readonly OpenWorkItem[]
  readonly unresolvedFailures: readonly FailureRef[]
  readonly contextDigest: string
  readonly summarizer: ModelIdentity
}
```

Compaction may remove verbose tool output from the next request, but it may not remove policy, task acceptance, pending approval, active plan revision, unresolved failure, or evidence references. The Session log remains complete.

## 9. Memory, workspace, and task state

### 9.1 State layers [PROPOSED]

```text
Durable task state       -> task/* events in Session
Durable execution trace  -> turn/step/tool/assistant events
Workspace state          -> workspace/workspace + workspace-memory
Evolution memory         -> evolution-memory artifacts/lessons
Ephemeral working set    -> ContextCompiler input, never source of truth
Cold artifacts           -> storage-domain media/KV records
```

`WorkspaceMemoryStore` remains bounded by configured bytes/items. `EvolutionMemoryStore` remains scoped by profile/workspace. New task state references these stores but does not duplicate their bodies.

### 9.2 Memory admission [PROPOSED]

Every promoted memory artifact must carry:

```ts
interface MemoryArtifact {
  readonly artifactId: string
  readonly scope: EvolutionScopeId | WorkspaceId
  readonly statement: string
  readonly sourceRefs: readonly EvidenceRef[]
  readonly trajectoryRefs: readonly RunId[]
  readonly confidence: number
  readonly utility: UtilityEstimate
  readonly createdAt: string
  readonly lastValidatedAt?: string
  readonly expiresAt?: string
  readonly lineage: ArtifactLineage
  readonly rollbackPreimage?: string
}
```

Generic transcript summaries without source refs, observed utility, or expiry are not admissible as durable learning.

## 10. Tool runtime, capability system, and policy

### 10.1 Capability vocabulary [PROPOSED]

```ts
type Capability =
  | 'fs.read' | 'fs.write' | 'fs.edit'
  | 'process.exec' | 'terminal.interactive'
  | 'network.read' | 'network.write'
  | 'git.read' | 'git.write'
  | 'browser.read' | 'mcp.call'
  | 'memory.read' | 'memory.write'
  | 'subagent.spawn' | 'workflow.start'
  | 'approval.request' | 'policy.propose'
```

Capabilities are grants, not tool names. A tool declares required capabilities and a resource selector. The kernel intersects role, task, parent delegation, policy, and approval before execution.

### 10.2 Permission DSL [PROPOSED]

```yaml
policy:
  defaults:
    effect: ask
  rules:
    - action: read
      resource: "workspace/**"
      effect: allow
    - action: write
      resource: "workspace/**"
      effect: allow
    - action: read
      resource: "**/.env*"
      effect: deny
    - action: shell
      resource: "git status *"
      effect: allow
    - action: shell
      resource: "git push *"
      effect: deny
    - action: network
      resource: "github.com"
      effect: ask
```

Evaluation order is broad-to-specific with last matching rule winning. The result must still be intersected with `SandboxPolicyService`; an approval cannot grant outside the configured technical sandbox unless the deployment explicitly allows that mode.

### 10.3 Policy engine contract [PROPOSED]

```ts
interface PolicyEngine {
  evaluate(input: PolicyContext): Promise<PolicyDecision>
}

interface PolicyContext {
  readonly action: ActionProposal
  readonly agentProfile: AgentProfile
  readonly task: TaskContract
  readonly parentGrant?: DelegationReceipt
  readonly sandbox: SandboxExecutionPolicy
  readonly approvalPolicy: ApprovalPolicy
}
```

`ApprovalService` stays the only interactive answerer. `SandboxPolicyService` stays the only shared mode/root resolver. The policy engine composes their answers and writes a `policy/decision` audit event.

## 11. Approval, sandbox, and security

### 11.1 Sandbox/approval separation [KEEP + REFACTOR]

The current `sandboxPolicy.resolve()` and `ApprovalService.request()` semantics are retained. Add a linking record:

```ts
interface GovernanceReceipt {
  readonly actionId: string
  readonly policyDecisionId: string
  readonly sandboxMode: SandboxMode
  readonly workspaceRoot: string
  readonly approvalOutcome?: ApprovalOutcome
  readonly approver?: 'user' | 'policy' | 'none'
  readonly timestamp: string
}
```

### 11.2 Prompt-injection defense [PROPOSED]

Add `packages/guard/prompt-injection` (name may change after package review) as a policy observer, not as a new prompt builder. It must:

1. wrap external content in a `ContentEnvelope` with source, trust, provenance, and taint;
2. scan tool/MCP/web/repo output before context admission;
3. scan model tool proposals before policy evaluation;
4. redact secrets and credentials from logs and model context;
5. preserve the original artifact hash for audit;
6. never allow text in untrusted content to change policy or approval state.

```ts
interface ContentEnvelope {
  readonly content: string
  readonly source: 'user' | 'repo' | 'tool' | 'web' | 'mcp' | 'subagent'
  readonly trust: 'trusted' | 'untrusted' | 'unknown'
  readonly tainted: boolean
  readonly provenance: Provenance
  readonly findings: readonly SecurityFinding[]
}
```

### 11.3 Hooks [REFACTOR]

Retain `hook-protocol`, `hooks-codex`, and `hooks-claude-code`. Require hook outputs to be typed as one of:

```text
observe | annotate | inject-untrusted-context | request-policy-change | veto
```

Only a kernel/policy owner may turn a hook result into a capability grant. Hook timeouts, stderr, merged output, and detached runs remain auditable through existing helpers.

## 12. Skills, plugins, and MCP

### 12.1 Skill admission [PROPOSED]

Extend `SkillDefinition` with:

```ts
interface GovernedSkillDefinition extends SkillDefinition {
  readonly requiredCapabilities: readonly Capability[]
  readonly trust: TrustLabel
  readonly sourceDigest: string
  readonly version: string
  readonly testScenarios: readonly string[]
  readonly admission: 'bundled' | 'project-reviewed' | 'user-approved' | 'quarantined'
  readonly rollbackArtifact?: string
}
```

Project skill files remain untrusted until scanned and admitted. A skill can narrow permissions but cannot widen the parent task's grant without approval.

### 12.2 MCP [REFACTOR]

`packages/mcp/mcp-client` remains the transport. Every MCP server/tool receives a namespace, origin, server digest, capability declaration, and default `ask` policy. MCP output is tainted external content. Server installation is separate from server invocation approval.

### 12.3 Plugin lifecycle [KEEP]

Cordis plugin mount/unmount remains the lifecycle. Add a plugin manifest validation gate for declared capabilities, config schema, data migrations, and cleanup guarantees. Do not add a second plugin registry outside Cordis.

## 13. Workflows, subagents, and delegation

### 13.1 Agent profile [PROPOSED]

```ts
interface AgentProfile {
  readonly id: string
  readonly role: string
  readonly modelPolicy: ModelPolicy
  readonly capabilities: readonly Capability[]
  readonly policy: PolicyReference
  readonly contextPolicy: ContextPolicy
  readonly budget: ResourceBudget
  readonly termination: TerminationPolicy
}
```

An agent is not just `prompt + tools`; it is a role, capability boundary, context policy, budget, and termination contract.

### 13.2 Delegation receipt [PROPOSED]

```ts
interface DelegationReceipt {
  readonly parentRunId: RunId
  readonly childRunId: RunId
  readonly allowedCapabilities: readonly Capability[]
  readonly resourceLimits: ResourceBudget
  readonly writableScopes: readonly string[]
  readonly inheritedPolicyDigest: string
  readonly depth: number
  readonly expiresAt: string
}
```

Child authority is the intersection of parent grant, child profile, deployment policy, and child sandbox. A child may not widen permissions by choosing another provider or by emitting a policy-like message.

`SubagentRuntime` remains responsible for providers and settlement. The kernel attaches receipts to start, action, and end events. `experimental/agent-team` may use the same receipt for roster members and Team task write scopes.

### 13.3 Workflow checkpointing [REFACTOR]

`WorkflowEngine` remains abstract. A workflow run must expose:

```ts
interface WorkflowRun {
  readonly id: WorkflowRunId
  readonly taskId: TaskId
  readonly status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  checkpoint(): Promise<CheckpointRef>
  resume(checkpoint: CheckpointRef): Promise<void>
  cancel(reason: string): Promise<void>
}
```

## 14. Agent registry and model router

### 14.1 Registry [KEEP + REFACTOR]

`ctx.agents` remains the live registry. Add a kernel registry projection keyed by `SessionId` containing task/run/profile/policy/checkpoint references. Never duplicate `Agent` identity or disposal.

### 14.2 Model router [PROPOSED]

```ts
interface ModelRouter {
  select(input: ModelRouteRequest): Promise<LlmRoute>
}

interface ModelRouteRequest {
  readonly taskClass: string
  readonly phase: TaskStatus
  readonly contextTokens: number
  readonly requiredCapabilities: readonly string[]
  readonly latencyBudgetMs?: number
  readonly costBudgetUsd?: number
  readonly reliabilityTarget?: number
  readonly providerPreference?: string
}
```

The router selects an existing `LlmAdapter` provider/model. It must log route rationale, price metadata, fallback chain, and actual usage. It may route planning, tool-heavy execution, compaction, review, and evolution scoring differently.

## 15. Research, evidence, claims, hypotheses, and verification

### 15.1 Evidence model [PROPOSED]

```ts
type EvidenceId = Branded<'EvidenceId'>
type ClaimId = Branded<'ClaimId'>
type HypothesisId = Branded<'HypothesisId'>

interface Evidence {
  readonly id: EvidenceId
  readonly kind: 'file' | 'tool-result' | 'web' | 'mcp' | 'test' | 'user' | 'model'
  readonly contentRef: string
  readonly digest: string
  readonly provenance: Provenance
  readonly trust: TrustLabel
  readonly observedAt: string
}

interface Claim {
  readonly id: ClaimId
  readonly statement: string
  readonly evidence: readonly EvidenceId[]
  readonly confidence: number
  readonly status: 'proposed' | 'supported' | 'contradicted' | 'stale' | 'rejected'
}

interface Hypothesis {
  readonly id: HypothesisId
  readonly question: string
  readonly claims: readonly ClaimId[]
  readonly tests: readonly VerificationRequest[]
  readonly status: 'open' | 'supported' | 'refuted' | 'inconclusive'
}
```

### 15.2 Verification gate [PROPOSED]

```ts
interface AcceptanceCriterion {
  readonly id: string
  readonly description: string
  readonly verifier: 'test' | 'build' | 'diff' | 'assertion' | 'human' | 'research'
  readonly required: boolean
}

interface VerificationRequest {
  readonly taskId: TaskId
  readonly criteria: readonly AcceptanceCriterion[]
  readonly evidence: readonly EvidenceRef[]
  readonly changedScopes: readonly string[]
}

interface VerificationResult {
  readonly status: 'pass' | 'fail' | 'unknown'
  readonly criterionResults: readonly CriterionResult[]
  readonly evidence: readonly EvidenceRef[]
  readonly commands?: readonly string[]
  readonly verifierVersion: string
}
```

Completion is allowed only when all required criteria pass, no unresolved fatal failure exists, the task budget is settled, and all required artifacts are persisted. A model statement “done” is evidence at most, never a completion decision.

## 16. Failure classification and recovery

### 16.1 Failure taxonomy [PROPOSED]

```ts
type FailureKind =
  | 'model-auth' | 'model-rate-limit' | 'model-context-overflow'
  | 'tool-invalid-input' | 'tool-policy-denied' | 'tool-transient'
  | 'sandbox-denied' | 'approval-rejected' | 'timeout'
  | 'budget-exhausted' | 'stale-write' | 'verification-failed'
  | 'subagent-failed' | 'workflow-failed' | 'persistence-failed'
  | 'prompt-injection' | 'unknown'
```

### 16.2 Recovery policy [PROPOSED]

```text
transient provider/tool       -> bounded retry with same action id
context overflow              -> compact, checkpoint, retry request
stale write                   -> reread observation, replan edit
policy denied                 -> ask user or replan; never retry blindly
approval rejected             -> record and replan/await user
verification failed           -> diagnose, repair, reverify
budget exhausted              -> checkpoint and pause
subagent failure              -> settle child, inspect partial evidence, reassign
prompt injection              -> quarantine source, invalidate derived proposal
persistence failure           -> fail closed; do not claim completion
```

Retries must not duplicate durable user messages or tool side effects. Idempotency keys and action receipts are required for retryable actions.

## 17. Checkpoints, resume, and long-running execution

### 17.1 Checkpoint contents [PROPOSED]

```ts
interface Checkpoint {
  readonly id: CheckpointRef
  readonly task: TaskContract
  readonly agentSessionId: SessionId
  readonly sessionSeq: number
  readonly planRevision?: PlanRevision
  readonly contextCheckpoint?: CompactionCheckpoint
  readonly openActions: readonly ActionReceipt[]
  readonly budgets: BudgetSnapshot
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly childRuns: readonly RunId[]
  readonly repositoryDigest?: string
  readonly createdAt: string
}
```

Checkpoint creation is triggered at turn boundaries, before compaction, before pause, after a verification failure, and before long-running workflow/subagent suspension. Resume rehydrates the existing Session through `AgentRegistry.resume()` and reconstructs kernel state from events/checkpoint; it does not create a fork unless explicitly requested.

### 17.2 Crash recovery [PROPOSED]

On boot, a recovery scanner lists persisted sessions, checks the highest canonical generation, identifies open turns, reads checkpoint policy, and classifies each run as resumable, repairable, or blocked. It must not silently infer completion from a missing tail.

## 18. Resource budgets, observability, and audit

### 18.1 Unified budget [REFACTOR]

```ts
interface ResourceBudget {
  readonly maxSteps?: number
  readonly maxToolCalls?: number
  readonly maxTokens?: number
  readonly maxWallMs?: number
  readonly maxCostUsd?: number
  readonly maxSubagentDepth?: number
  readonly maxConcurrentActions?: number
}

interface BudgetSnapshot {
  readonly steps: number
  readonly toolCalls: number
  readonly tokens: number
  readonly wallMs: number
  readonly costUsd?: number
  readonly remaining: Partial<ResourceBudget>
}
```

`guard/budgets` remains the fast enforcement listener; the kernel consumes its normalized facts. Token meter, usage ledger, and session telemetry remain existing providers.

### 18.2 Trace and audit events [PROPOSED]

Add versioned session event families (exact names subject to catalog generation):

```text
task/created, task/transitioned, task/plan
action/proposed, action/authorized, action/denied, action/committed
policy/decision, capability/grant, capability/revoke
verification/requested, verification/result
failure/recorded, recovery/started, recovery/decided
checkpoint/created, checkpoint/resumed
evidence/recorded, claim/updated, hypothesis/updated
evolution/candidate, evolution/evaluated, evolution/promoted, evolution/rolled-back
```

Every event carries `version`, `runId`, optional `taskId`, actor, timestamp, and provenance. Sensitive arguments are hashed/redacted. Event schemas are added to the generated persistence/session catalogs and covered by migration tests.

### 18.3 Metrics [PROPOSED]

Minimum metrics:

```text
task.success_rate, task.verification_pass_rate
run.steps, run.tool_calls, run.wall_ms, run.cost_usd
policy.denied, approval.rejected, sandbox.denied
context.compactions, context.omitted_bytes, context.conflicts
recovery.by_kind, checkpoint.resume_success
subagent.success_rate, workflow.resume_success
memory.recall_utility, skill.utility, evolution.capability_gain_per_compute
```

## 19. Storage and data model

Use current storage seams rather than a new database abstraction.

| Record | Authoritative store | Projection/index |
|---|---|---|
| task/run/action/verification | Session log | `session-projection` kernel projection |
| checkpoint | session checkpoint policy + storage domain | checkpoint index |
| workspace memory | `workspace-memory` storage domain | digest/usage readers |
| evolution artifact/lesson | `evolution-memory` storage domain | graph/retrieval/telemetry |
| evidence body | attachment/storage domain | evidence index |
| trajectory | Session + `evolution-trajectory` export | scorer/replay |
| cost/usage | `usage-ledger` / session telemetry | dashboards |

No kernel state may be stored only in process memory if it affects completion, authority, or recovery.

## 20. TypeScript contract summary

The first implementation should add a small package, for example `packages/runtime/agent-kernel`, with no direct ownership of the loop. Its public surface should include:

```ts
export interface AgentKernelService {
  readonly state: KernelStateReader
  readonly policy: PolicyEngine
  readonly capabilities: CapabilityRegistry
  readonly context: ContextCompiler
  readonly verification: VerificationGate
  readonly recovery: RecoveryEngine
  readonly budgets: BudgetGovernor
  attach(agent: Agent): Promise<KernelAttachment>
}

export interface KernelAttachment {
  readonly taskId: TaskId
  readonly runId: RunId
  snapshot(): Promise<AgentSnapshot>
  dispose(): Promise<void>
}
```

Package boundaries must be interface-first and use type-only imports to avoid dependency cycles. Kernel may depend on core type packages and event seams, but `core/agent-loop` must not import the kernel implementation.

## 21. Configuration schema [PROPOSED]

Profile configuration should be declarative and patchable:

```yaml
agentKernel:
  enabled: true
  state:
    persist: session
    maxPlanRevisions: 32
  policy:
    defaultEffect: ask
    untrustedContent: quarantine
  context:
    maxTokens: 64000
    retainRequiredCriteria: true
    retainFailures: true
  verification:
    requireAcceptanceCriteria: true
    allowHumanOnlyCompletion: false
  recovery:
    maxAttemptsPerAction: 2
    checkpointBeforeRetry: true
  budgets:
    maxSteps: 100
    maxToolCalls: 200
    maxWallMs: 1800000
  evolution:
    promotion: holdout-required
    requireRollbackPreimage: true
```

All config is validated through the repository's existing `static Config`/Schemastery catalog conventions. New defaults are fail-closed for policy, verification, and promotion.

## 22. CLI, TUI, API, and profile integration

### CLI [REFACTOR]

Extend `apps/cli` and `packages/boot/cmdline` with:

```text
dsh run --task <text> --profile <name>
dsh task show <session-id>
dsh task verify <session-id>
dsh task pause <session-id>
dsh task resume <session-id>
dsh task checkpoint <session-id>
dsh policy explain <session-id> <action-id>
dsh evolution replay <run-id>
```

These are commands over existing services, not alternate launchers. They must continue to start through `dsh` profiles.

### Web/desktop [REFACTOR]

Use Session projections and generated remotes. Add views for task status, plan revision, pending approval, budget, verification criteria, checkpoint, and evidence lineage. Do not make the UI a source of truth.

### SDK/ACP [KEEP + REFACTOR]

Expose task contract, streamed kernel events, approval requests, checkpoint/resume, and verification result through existing Typert/RPC/ACP bridges. Preserve session identity and cancellation semantics.

## 23. Security model

Security invariants:

1. User authorization outranks model text, tool output, skill text, and MCP content.
2. Sandbox is a technical boundary; approval is a governance decision; neither is inferred from the other.
3. Child/subagent authority is an intersection, never a union, of parent grant and child policy.
4. Untrusted content is tainted until scanned and remains non-authoritative even if selected by retrieval.
5. Secrets are unavailable to model context by default and redacted from traces.
6. Policy-denied and approval-rejected actions are distinct from execution failures.
7. A missing answerer or persistence failure fails closed.
8. A completion result requires verifiable evidence, not self-report.
9. Evolution promotion requires replayable evidence, holdout protection, and rollback preimage.
10. Plugin unload must stop/drain owned agents and background jobs before removing capability providers.

## 24. Testing and benchmark architecture

### 24.1 Unit and contract tests [PROPOSED]

Add focused suites next to the owning package:

- `agent-kernel/tests/state-machine.spec.ts`: legal/illegal transitions and revision conflicts;
- `agent-kernel/tests/action-ledger.spec.ts`: proposal → authorization → commit invariants;
- `agent-kernel/tests/policy.spec.ts`: rule precedence, sandbox/approval intersection, deny dominance;
- `agent-kernel/tests/delegation.spec.ts`: child capability intersection and depth;
- `agent-kernel/tests/context-compiler.spec.ts`: ranking, trust, conflict, budget, deterministic digest;
- `agent-kernel/tests/verification.spec.ts`: required criteria and completion gate;
- `agent-kernel/tests/recovery.spec.ts`: retry/idempotency/checkpoint classification;
- `agent-kernel/tests/replay.spec.ts`: event replay and projection rebuild;
- existing `core/agent-loop/tests/*`, `core/session/tests/*`, `core/tools/tests/*`, `subagent/*`, and `agent-team/*` remain regression suites.

### 24.2 Security tests

Cover prompt injection in repository files, tool output, web/MCP responses, hook output, skill files, and child-agent messages. Assert that no case changes policy or capability without a runtime decision.

### 24.3 Evaluation benchmarks

Each benchmark stores task contract, repository fixture digest, model route, policy profile, trajectory, verifier output, cost, and outcome. Required benchmark families:

```text
coding: edit/test/fix/review/refactor
research: source retrieval/claim support/contradiction/uncertainty
operations: long-running workflow/checkpoint/resume
security: injection/secret/path/network/approval
multi-agent: delegation/parallelism/conflict/write scopes
evolution: replay/holdout/promotion/rollback
```

Primary metric: **verified capability gain per unit of compute**, with safety and cost constraints. Do not optimize raw success claims without verification.

## 25. Incremental migration plan

### Phase 0 — Contract inventory and observability (P0)

Files/packages: new kernel contracts; `packages/core/session` event map; `packages/session` catalogs; existing telemetry/usage ledger.

Deliverables:

- add `TaskContract`/`RunId` types and read-only kernel attachment;
- emit action proposal/decision/observation in shadow mode;
- no behavior change to execution;
- add replay/projection tests.

Exit: every tool call in focused runs has a correlation id and a reconstructable observation.

### Phase 1 — Governed action seam (P0)

Files/packages: kernel; `core/tools`; `sandbox/sandbox-policy`; `interaction/user-approval`; `interaction/permission-presets`.

Deliverables:

- capability declarations for built-in tools;
- policy DSL compiler;
- policy decision linking sandbox and approval receipts;
- deny/ask/allow behavior in shadow then enforcing mode;
- child delegation intersection.

Exit: no model tool call can bypass policy; existing tool and approval tests remain green.

### Phase 2 — Context compiler and durable task state (P0/P1)

Files/packages: `core/system-prompt`; `context/*`; `compaction/*`; `workspace/*`; `core/session`.

Deliverables:

- facade over existing prompt/context contributors;
- source envelopes, trust, rank, token budget, digest;
- task/plan/verification events;
- compaction checkpoints that preserve required facts.

Exit: replay produces the same compiled-context digest for deterministic fixtures.

### Phase 3 — Verification and recovery (P0/P1)

Files/packages: kernel verification/recovery; `guard/budgets`; `llm/llm-retry`; `guard/timeout-policy`; `workflow/*`; CLI/API adapters.

Deliverables:

- universal acceptance criteria and completion gate;
- failure taxonomy adapters;
- idempotent retry and checkpoint/resume;
- task pause/resume commands and remote events.

Exit: the harness never reports completed when required verification is missing or failed.

### Phase 4 — Research/evidence substrate (P1)

Files/packages: kernel evidence contracts; `web/*`, `mcp/*`, `evolution-graph`, `evolution-memory`, trajectory exporter.

Deliverables:

- Evidence/Claim/Hypothesis records;
- provenance/trust and contradiction edges;
- evidence-backed research verifier;
- memory admission requires evidence/trajectory refs.

Exit: a research answer can be replayed to its source artifacts and verifier decisions.

### Phase 5 — Governed skills, subagents, and workflows (P1)

Files/packages: `skill/*`, `subagent/*`, `experimental/agent-team`, `workflow/*`, profile bundles.

Deliverables:

- skill admission and required capabilities;
- delegation receipts and policy intersection;
- workflow checkpoint contract;
- Team write-scope enforcement.

Exit: child actions are attributable to parent grant and cannot widen authority.

### Phase 6 — Evolution promotion (P2)

Files/packages: `evolution/reviewer`, `curator`, `optimizer`, `scorer`, `feedback`, `dreaming`, `heartbeat`.

Deliverables:

- causal artifact lineage;
- replay, protected holdout, shadow deployment;
- promotion confidence and rollback preimage;
- utility/staleness/novelty and resource-aware selection.

Exit: no skill, memory, policy, or routing update is promoted without evidence, holdout result, audit record, and rollback.

## 26. Deprecation and removal plan

1. Mark any new duplicate runtime-loop/task-controller package as forbidden in architecture review.
2. During Phase 1, emit both old local policy decisions and normalized kernel decisions; compare in telemetry.
3. During Phase 2, keep existing context contributors and route them through the compiler facade; delete only after digest parity tests.
4. During Phase 3, replace ad hoc completion claims with the verification gate; retain local verifiers as criterion providers.
5. During Phase 5, migrate child providers to delegation receipts; reject providers that do not expose policy/capability metadata.
6. During Phase 6, demote fixed schedules/capacities and single optimizer assumptions to config/strategy plugins.
7. Remove unreachable duplicate counters and obsolete prompt-only enforcement only after a repository-wide `rg` audit and migration telemetry show zero consumers.

## 27. P0 / P1 / P2 roadmap

| Priority | Scope | Definition of value |
|---|---|---|
| P0 | Kernel contracts, action ledger, policy/capability, task events, completion gate, checkpoint | correctness, safety, replayability |
| P1 | Context compiler, evidence graph, delegation receipts, workflow resume, governed skills | reliability and capability breadth |
| P2 | Replay/holdout evolution, shadow promotion, routing optimization, novelty/staleness, meta-evolution | measurable verified improvement per compute |

The first shippable slice is P0 shadow → P0 enforcing. P2 must not block the safe runtime.

## 28. Acceptance criteria and Definition of Done

### Runtime correctness

- Every active task has a durable `TaskContract`, run id, status, revision, and acceptance criteria.
- Every model/tool action has proposal, policy, capability, execution, observation, and outcome linkage.
- State transitions reject stale revisions and illegal edges.
- Resume from a checkpoint reconstructs the same task state without duplicate side effects.

### Security

- Sandbox and approval are separate, composable decisions.
- Child authority is an intersection and is auditable.
- Untrusted content cannot mutate policy, approvals, or capabilities.
- Secrets and sensitive arguments are redacted in context and telemetry.

### Context and memory

- Compiler output is budgeted, ranked, provenance-labelled, and digestible.
- Compaction preserves acceptance, policy, open work, failures, and evidence refs.
- Memory promotion requires source refs, confidence, utility, lineage, and expiry/validation policy.

### Verification

- Completion requires all required criteria to pass.
- Failed/unknown verification cannot be reported as success.
- Research claims link to evidence and contradiction status.

### Operations

- CLI, Web, SDK, and ACP can inspect status, policy, budgets, verification, checkpoint, and resume.
- Plugin unload drains kernel attachments, child agents, workflows, hooks, and background evolution jobs.
- Existing targeted tests for agent loop, session, tools, sandbox, approval, skills, subagents, workflow, compaction, and evolution remain green.

### Evolution

- Candidate changes are replayable and evaluated on protected holdouts.
- Promotion records evidence, score, cost, confidence, and rollback preimage.
- A promoted change can be rolled back without rewriting released Session generations.

## 29. External benchmark appendix

### Codex [EXTERNAL BENCHMARK]

Useful mechanisms to adapt:

- sandbox and approval are separate layers;
- permission requests can ask for narrowly scoped additional filesystem/network access;
- external/untrusted messages preserve tool-level authority rather than becoming user authorization;
- multi-agent permission propagation needs explicit ownership and visibility.

Do not copy provider-specific sandbox implementation or assume a single coding-only task model. DeepSeek Harness already has `SandboxPolicyService`, `ApprovalService`, and multiple capability providers; integrate them instead.

References: [Codex sandbox docs](https://github.com/openai/codex/blob/main/docs/sandbox.md), [Codex permission request guidance](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request_rule_request_permission.md), [Codex SDK external-message guidance](https://github.com/openai/codex/blob/main/sdk/python/docs/getting-started.md).

### Claude Code [EXTERNAL BENCHMARK]

Useful mechanisms to adapt:

- explicit permission modes and allowed/disallowed tool lists;
- hooks at session, pre-tool, and post-tool boundaries;
- session continue/resume and headless JSON/stream output;
- conservative project write boundaries and explicit MCP project-server approval;
- subagent use with guardrails against unnecessary delegation.

Do not copy prompt-only permission semantics or inherit child authority implicitly. Use the kernel receipt/intersection model and existing Cordis lifecycle.

References: [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [Claude Code security](https://docs.anthropic.com/en/docs/claude-code/security), [Anthropic MCP documentation](https://docs.anthropic.com/en/docs/mcp).

### OpenCode [EXTERNAL BENCHMARK]

Useful mechanisms to adapt:

- agent profiles with role, model, prompt, mode, and permissions;
- fine-grained resource/pattern permissions with specific rules overriding broad rules;
- permission keys covering edit, bash, external directories, tasks, skills, web, and MCP-like tools;
- project/global skill discovery with per-agent skill permissions.

Do not copy a tool-key-only permission model. DeepSeek Harness needs capability grants, sandbox intersection, approval receipts, and evidence-aware completion.

References: [OpenCode agents and permissions](https://opencode.ai/docs/agents), [OpenCode skills](https://opencode.ai/docs/skills).

### MiniMax Code [EXTERNAL BENCHMARK]

Useful mechanisms to adapt:

- explicit interactive, headless, and ACP entry points;
- session continuation and session picker;
- plan mode, permission modes, subagents, plugins, and built-in skills in one terminal workflow;
- bring-your-own-model/provider selection and multimodal/MCP extensions.

Do not copy the product-specific CLI or assume a terminal is the primary client. DeepSeek Harness already supports Web, desktop, SDK, ACP, and headless profiles; expose one task/kernel contract across them.

Reference: [MiniMax Code repository](https://github.com/MiniMax-AI/minimax-code).

## 30. What not to build

The following are explicitly out of scope for this evolution specification:

- a second model/tool loop alongside `ReactLoopAgent`;
- a second session database that competes with `core/session`;
- a single mandatory vector/graph/QMD backend;
- autonomous policy mutation without holdout, approval, and rollback;
- memory that is only a transcript summary;
- an optimizer that promotes based on model self-score alone;
- child agents that inherit unrestricted parent tools;
- UI-owned task state;
- an “all features enabled” profile that bypasses the existing `dsh` launch and bundle model.

## 31. Final implementation rule

The evolution succeeds when the repository can truthfully answer:

> The model proposes. The Harness records, classifies, constrains, authorizes, executes, observes, verifies, recovers, remembers, and learns — while every step remains attributable to an existing lifecycle owner and replayable from durable evidence.

That is an incremental extension of the audited DeepSeek Harness, not a rewrite disguised as a feature list.

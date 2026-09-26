# Evolutionary Harness v11 — Deep Research & Mechanism Upgrade

## Executive conclusion

The highest-value upgrade is to treat Evolutionary Harness as a governed optimization system rather than a collection of memory and automation features.

The central loop should be:

Experience → Trace → Credit Assignment → Failure/Pattern Mining → Hypothesis → Candidate Generation → Evaluation → Selection → Promotion → Monitoring → Regression/Rollback → New Evidence

The key insight from current agent systems and evolutionary research is that capability growth is driven by five interacting factors:

1. **Learning-signal quality** — detailed traces, external feedback, verifier results, failures and counterexamples.
2. **Search quality** — diversity, mutation operators, population management, Pareto selection and exploration/exploitation balance.
3. **Skill/memory quality** — retrieval, consolidation, compositionality, source tracking and anti-patterns.
4. **Evaluation quality** — robust benchmarks, multi-objective scoring, held-out tests, adversarial/regression suites and contamination controls.
5. **Governance quality** — promotion gates, autonomy levels, canaries, attribution, rollback and auditability.

This means the next version should not simply add more memory, graph search or GEPA. It should add the missing mechanisms that make those components produce measurable capability improvement.

---

# 1. Assessment of the current specification

The uploaded v10 already contains strong foundations: three-tier memory, periodic nudges, background review, GEPA, Dreaming, Heartbeat, skill auto-creation, active memory, hybrid retrieval, persisted indexes, graph/vector search and a knowledge graph. The document explicitly frames the goal as turning interactions into reusable knowledge rather than logs. [Source: Evolutionary Harness Specification v10.]

The major architectural gap is not feature count; it is the absence of a unified experimental/evolutionary control loop. In particular, v10 does not sufficiently define:

- trace-level credit assignment;
- candidate populations rather than a single mutation;
- diversity preservation;
- automatic curriculum/task generation;
- verifier/evaluator ensembles;
- held-out benchmark protection;
- counterfactual evaluation;
- mutation-operator selection;
- artifact lineage and experiment registry;
- explicit failure/anti-pattern memory;
- online canarying and rollback;
- explicit distinction between learned state and system policy;
- self-improvement of the improvement process itself.

The current roadmap also prioritizes frozen memory, three-tier memory, periodic nudges and prefix-cache optimization before the system has a first-class trace/evaluation/evolution substrate. That ordering should be reversed.

---

# 2. Core research finding: maximize evolution, not memory

A long-lived agent gets progressively better only when the system can reliably answer four questions:

### What happened?
Trace and source references.

### Why did it happen?
Credit assignment, failure analysis and causal diagnosis.

### What should change?
Hypothesis generation and candidate mutation.

### Did the change actually help?
Evaluation, comparison, regression detection and long-term monitoring.

Memory without evaluation can accumulate wrong beliefs. Self-reflection without external verification can reinforce hallucinations. Skill creation without curation creates skill entropy. Optimization without diversity converges prematurely. Evaluation without protected test sets overfits.

The evolutionary harness therefore needs to optimize the complete loop, not individual components.

---

# 3. Mechanism family A — Experience capture and trajectory intelligence

## 3.1 Immutable execution traces

Every task should produce an immutable trajectory containing:

- request and resolved task specification;
- context snapshot/hash;
- plan and subgoals;
- model calls;
- tool calls and outputs;
- intermediate decisions;
- errors and retries;
- retrieved memories/skills;
- final answer/action;
- evaluator results;
- user feedback;
- cost/latency;
- artifact versions used.

This is more important than raw chat logging because evolutionary algorithms need structured evidence tied to decision points.

## 3.2 Step-level credit assignment

Do not record only "task failed". Record which step most likely caused the failure.

Example:

Task failed
→ retrieval missed relevant policy
→ planner chose invalid route
→ tool call used stale skill
→ final answer inherited the wrong assumption.

Store attribution probabilities or ranked root causes. This lets mutations target a component rather than changing the entire system.

## 3.3 Trajectory compression

Long traces should have three forms:

- raw trace for audit;
- structured event trace for machines;
- compressed learning trace for reflection/evolution.

This is important for controlling background cost.

GEPA explicitly benefits when execution traces expose stage-specific failures and textual feedback rather than only a scalar reward.

Source: DSPy GEPA documentation.

---

# 4. Mechanism family B — Reflection and verbal reinforcement

## 4.1 Reflexion-style failure memory

Reflexion showed that language agents can improve without weight updates by turning feedback into verbal reflections stored in episodic memory.

The important mechanism is not "reflection text" itself. It is the persistent association:

failure → explanation → corrective heuristic → later retrieval.

Source: Shinn et al., Reflexion, NeurIPS 2023.

## 4.2 Replace generic reflection with structured reflection

Use a schema:

```yaml
reflection:
  failure_id:
  symptom:
  violated_expectation:
  root_cause:
  contributing_factors:
  what_worked:
  what_failed:
  corrected_strategy:
  confidence:
  reusable_when:
  anti_pattern:
  candidate_test:
```

This is much more actionable than free-form "lesson learned" prose.

## 4.3 Failure-first learning

The current Hermes ecosystem itself has identified failure-aware structured learning as a valuable extension because a success-only self-improvement loop can repeatedly reproduce the same mistakes.

For the Harness this means **Failure Memory is P0**, not an optional feature.

---

# 5. Mechanism family C — Self-refinement vs evolution

Self-Refine and Reflexion are useful, but they are not sufficient for long-term evolution.

Self-Refine performs iterative feedback/refinement within a task. It showed meaningful gains across diverse tasks without additional training.

Source: Madaan et al., Self-Refine.

Use it as:

request → draft → critique → revise

But Evolutionary Harness needs the longer loop:

many tasks → patterns → candidate → benchmark → promotion.

Therefore:

- Self-Refine = inference-time local improvement;
- Reflexion = experience-to-memory improvement;
- Evolution Engine = population-level durable improvement.

They should be layered, not substituted for one another.

---

# 6. Mechanism family D — Population-based evolution

This is the biggest missing mechanism in the current architecture.

A single candidate mutation is vulnerable to local optima and mode collapse. Population-based evolution maintains multiple viable strategies.

A practical population record:

```yaml
candidate:
  id:
  artifact_type:
  parent_id:
  mutation_operator:
  generation:
  objectives:
  scores:
  novelty:
  diversity_score:
  lineage:
  status:
```

Selection should combine:

- exploitation of strong candidates;
- exploration of novel candidates;
- preservation of complementary solutions.

GEPA already uses Pareto-frontier selection and candidate coverage mechanisms. Its current documentation also supports objective-aware frontier tracking.

Source: DSPy GEPA documentation.

---

# 7. Mechanism family E — Island model and diversity preservation

Open-ended evolution frameworks such as OpenEvolve use population size, elite archives and multiple islands with migration to preserve diversity.

The insight is highly transferable to agent evolution:

```text
Island A: conservative / reliability-heavy
Island B: performance-heavy
Island C: cost-heavy
Island D: novelty-heavy
Island E: adversarial / safety-heavy
```

Periodically migrate strong candidates between islands.

Why this matters:

Without diversity preservation, the Harness will converge on the first "pretty good" skill/prompt and stop discovering alternatives.

Recommended mechanism:

- 3–8 logical islands for large optimization jobs;
- migration on a generation/budget schedule;
- diversity penalty or novelty bonus;
- independent seeds and mutation strategies.

Source: OpenEvolve configuration and evolutionary architecture.

---

# 8. Mechanism family F — Mutation operator portfolio

Do not let one LLM prompt be the only mutation mechanism.

Create an operator portfolio:

```text
MutationOperator
├── rewrite
├── specialize
├── generalize
├── simplify
├── decompose
├── compose
├── reorder
├── add-check
├── remove-step
├── change-tool
├── change-retrieval
├── change-evaluator
├── merge-two-candidates
└── adversarial-patch
```

Track operator effectiveness:

```yaml
operator_stats:
  rewrite:
    attempts:
    accepted:
    mean_delta:
    regression_rate:
```

The system can then learn which mutation operators work for which artifact classes.

This is a direct path toward **meta-evolution**.

---

# 9. Mechanism family G — Self-referential evolution

PromptBreeder demonstrates a particularly important idea: evolve not only the task prompt, but the mutation prompts that generate future mutations.

This creates:

```text
artifact evolution
+
mutation-strategy evolution
```

Source: PromptBreeder, ICML 2024.

For the Harness, extend this to:

```text
Evolution Engine
├── candidate generators
├── mutation operators
├── evaluators
└── selection policy
```

The Harness can learn which proposal styles and evaluators produce useful improvements.

This is the foundation of **Meta-Evolution**.

---

# 10. Mechanism family H — Automatic curriculum

Voyager's strongest general mechanism is not only its skill library. It has an automatic curriculum that continuously proposes new tasks based on current state and capability.

Source: Voyager.

A general Harness should therefore have:

```text
Current capability profile
        ↓
Capability gaps
        ↓
Task generator
        ↓
Training/evaluation tasks
        ↓
New evidence
        ↓
Evolution
```

For example:

- find weak areas;
- generate tasks slightly beyond current capability;
- test candidate on those tasks;
- convert difficult failures into regression cases.

This prevents learning from being entirely passive.

---

# 11. Mechanism family I — Skill compositionality

Voyager demonstrates why a skill library becomes much more powerful when skills are compositional.

Instead of only retrieving one skill:

```text
skill A
```

retrieve and compose:

```text
skill A + skill C + skill F
```

v11 should support:

```yaml
skill:
  capabilities:
  prerequisites:
  inputs:
  outputs:
  compatible_with:
  conflicts_with:
  composable_with:
```

The evolution engine should be able to synthesize new skills from existing primitives.

This changes the scaling law of the library from:

"number of skills"

to:

"number of useful compositions."

---

# 12. Mechanism family J — Verifier-first evolution

AlphaEvolve provides a critical design lesson: LLM creativity is paired with automated evaluators that verify candidate programs and feed scores back into evolutionary search.

Source: DeepMind AlphaEvolve; AlphaEvolve paper.

The transferable principle is:

**Make the environment, tests, simulators or validators do as much judging as possible.**

Use a hierarchy:

```text
Level 0 — schema validator
Level 1 — deterministic unit/invariant checks
Level 2 — domain simulator/tool execution
Level 3 — evaluator model
Level 4 — human review
```

Do not use an LLM judge when a deterministic verifier exists.

---

# 13. Mechanism family K — Evaluator ensemble and judge calibration

A single evaluator becomes the new bottleneck.

The evaluator itself can be wrong, biased or reward-hacked.

Use multiple evaluation channels:

```text
correctness
quality
safety
cost
latency
robustness
novelty
```

For high-impact artifacts, use multiple judges or cross-model agreement.

Also maintain evaluator health:

- judge agreement;
- false-positive rate;
- false-negative rate;
- drift;
- correlation with human outcomes.

The evaluator must itself be versioned and benchmarked.

---

# 14. Mechanism family L — Benchmark evolution

A fixed benchmark becomes stale.

The benchmark system itself should evolve.

Add:

```text
Benchmark Generator
Benchmark Curator
Benchmark Deduplicator
Hard Example Miner
Adversarial Example Generator
Regression Promoter
```

New failures should automatically become hard examples unless they are duplicates or contaminated.

This creates:

```text
production failures
→ benchmark growth
→ better evaluation
→ better evolution
```

---

# 15. Mechanism family M — Protected holdout and anti-overfitting

Evolutionary systems can overfit aggressively.

Maintain three datasets:

```text
TRAIN / SEARCH
VALIDATION
PRIVATE HOLDOUT
```

And for long-lived agents:

```text
production-replay
adversarial
never-seen holdout
```

Candidate promotion should never depend only on the dataset used to generate the candidate.

This is mandatory if GEPA/population evolution is used continuously.

---

# 16. Mechanism family N — Counterfactual evaluation

A candidate can appear better because the task distribution changed.

Counterfactual replay asks:

> What would have happened on the same trace using the old artifact vs the new artifact?

Examples:

```text
same task
same tools
same context
baseline artifact
candidate artifact
```

Compare directly.

This is one of the highest-value additions for production evolution because it reduces confounding.

---

# 17. Mechanism family O — Replay engine

Build a deterministic-ish task replay environment.

```text
trace
 ↓
reconstruct context
 ↓
restore artifact versions
 ↓
run baseline
 ↓
run candidate
 ↓
compare
```

For tools with nondeterministic external state, snapshot the relevant tool outputs or create simulators.

Replay is the bridge between production experience and safe offline evolution.

---

# 18. Mechanism family P — Shadow deployment

Before canarying a candidate, run it in shadow mode:

```text
production task
       │
       ├── baseline → actual response
       │
       └── candidate → hidden response
```

Compare quality/cost/latency without changing user-visible behavior.

Recommended rollout:

shadow → canary → gradual promotion.

---

# 19. Mechanism family Q — Memory as evidence graph, not just notes

OpenClaw's current Dreaming system has become strongly attribution-aware: promotions use score, recall-frequency and query-diversity gates; untrusted/system-derived candidates are kept out of the durable promotion path; accepted rewrites retain preimages and reviewable dream reports.

Source: current OpenClaw memory/Dreaming documentation.

The next step is a claim/evidence graph:

```text
Claim
 ├── supported_by → evidence
 ├── observed_in → trace
 ├── contradicted_by → evidence
 ├── supersedes → claim
 ├── derived_from → claim
 └── used_by → skill/policy
```

This enables epistemic reasoning rather than flat recall.

---

# 20. Mechanism family R — Confidence decomposition

Do not store a single confidence score.

Use:

```yaml
belief:
  confidence:
  evidence_quality:
  source_reliability:
  independent_support:
  contradiction_count:
  recency:
```

Confidence should rise from independent evidence, not from repeatedly recalling the same memory.

This prevents reinforcement loops.

---

# 21. Mechanism family S — Anti-pattern and negative knowledge

Store explicit "do not do this" knowledge.

```text
Failure
→ anti-pattern
→ trigger condition
→ known exceptions
→ regression case
```

This is particularly valuable for agent safety, debugging, trading workflows and coding workflows because avoiding known failure modes can produce greater gains than adding positive tips.

---

# 22. Mechanism family T — Staleness and concept drift

An evolutionary system must detect that an old skill is no longer valid.

Use:

- time decay;
- recent failure spike;
- task-distribution shift;
- tool/version changes;
- low retrieval utility;
- conflicting newer evidence.

A skill can then transition:

```text
active → suspect → stale → archived
```

rather than remaining trusted forever.

Hermes' current Curator already implements active → stale → archived maintenance for agent-created skills and produces recoverable archives rather than destructive deletion.

Source: current Hermes Curator.

---

# 23. Mechanism family U — Relevance feedback loop

Retrieval quality must be learned from actual use.

Track:

```text
memory retrieved
→ used?
→ cited?
→ affected decision?
→ helped outcome?
```

This is much better than measuring retrieval only by similarity score.

A memory with lower embedding similarity but high decision utility should gain retrieval weight.

Thus each recall result receives a downstream utility signal.

---

# 24. Mechanism family V — Memory utility learning

Define:

```text
memory_utility =
  relevance
  × decision_impact
  × outcome_gain
  × source_quality
```

Over time, retrieve based on **estimated utility**, not semantic similarity alone.

This is a major upgrade over a conventional vector store.

---

# 25. Mechanism family W — Sleep-time compute

Sleep-time compute shows that offline computation performed before the user query can reduce test-time compute substantially and can improve quality, especially when future queries are predictable.

Source: Lin et al., Sleep-time Compute.

For the Harness:

```text
idle time
 ↓
anticipate likely future tasks
 ↓
precompute summaries / retrieval structures / candidate plans
 ↓
cache useful reasoning artifacts
```

Use this selectively for recurring domains.

This should be modeled as an economic optimization:

```text
offline_cost
vs
expected future savings + quality gain
```

---

# 26. Mechanism family X — Meta-evolution

The most advanced mechanism to add is evolution of the evolution process itself.

The Harness should gradually learn:

- which mutation operator works for a task class;
- which evaluator catches regressions;
- which model is best for reflection;
- which benchmark size is enough;
- how much search budget to allocate;
- when to exploit vs explore;
- when to invoke Active Memory;
- when to create a new skill versus update an existing one.

This forms:

```text
Level 1: evolve artifacts
Level 2: evolve workflows
Level 3: evolve mutation strategy
Level 4: evolve evaluation strategy
Level 5: evolve resource allocation
```

Level 3–5 should be introduced only after strong governance exists.

---

# 27. Mechanism family Y — Resource-aware evolution

Evolution should optimize not only quality but also resource use.

Objectives:

```text
quality
reliability
latency
cost
memory footprint
context usage
background compute
```

This supports Pareto optimization.

A candidate that improves quality 1% while doubling cost may be worse than a candidate improving quality 0.8% at half the cost.

---

# 28. Mechanism family Z — Adaptive model routing

Do not use the same model for every evolutionary role.

Recommended topology:

```text
Task execution → strong/fast task-specialized model
Reflection → cheap reasoning model
Candidate generation → diverse models
Evaluation → independent judge models
Final promotion review → strongest verifier
```

AlphaEvolve explicitly demonstrates value from an ensemble of faster/broader and stronger/deeper models for different roles.

Source: DeepMind AlphaEvolve.

The Harness can generalize this to multi-model evolutionary search.

---

# 29. New core mechanism: Evolution Memory

Every experiment should itself become searchable memory.

```yaml
experiment:
  id:
  hypothesis:
  baseline:
  candidate:
  tasks:
  metrics:
  outcome:
  regressions:
  rejected_reason:
  lessons:
```

Future evolution should retrieve:

- successful mutations;
- failed mutations;
- previously tested hypotheses;
- evaluator weaknesses;
- known local optima.

This prevents rediscovering the same failures.

---

# 30. New core mechanism: Knowledge of failure surfaces

Maintain a map:

```text
Task class
    ↓
Failure mode distribution
    ↓
Most effective repair operators
```

Example:

```yaml
task_class: coding
failure_mode: stale_context
best_repairs:
  - context_refresh
  - repository_search
  - targeted_test
```

The mutation engine can choose an operator using this learned prior.

---

# 31. New core mechanism: Novelty search

Reward candidates for being meaningfully different, not only high-scoring.

Use novelty on:

- behavior;
- plan structure;
- tool usage;
- retrieval path;
- wording/instruction structure.

Novelty is especially important when the current frontier has stagnated.

Combine:

```text
fitness + novelty
```

rather than fitness alone.

---

# 32. New core mechanism: Stagnation detector

Detect:

```text
N generations
without meaningful improvement
```

Then automatically switch strategy:

```text
normal exploitation
        ↓
stagnation
        ↓
more diversity
        ↓
new mutation operators
        ↓
new tasks
        ↓
new evaluators
        ↓
new model
```

This prevents silent evolutionary death.

---

# 33. New core mechanism: Capability frontier

Maintain a map of:

```text
capability
current score
confidence
known failures
skill coverage
```

This lets the system identify:

```text
"what should I learn next?"
```

rather than waiting for a user to provide another task.

This generalizes Voyager's automatic curriculum beyond an embodied environment.

---

# 34. New core mechanism: Dependency-aware evolution

Artifacts have dependencies.

```text
Prompt v7
  ↓
Skill v3
  ↓
Retriever config v5
  ↓
Evaluator v2
```

Changing evaluator v2 may invalidate historical metrics.

Changing retrieval may make old skill usage metrics incomparable.

Therefore every evaluation result must record dependency versions.

This enables reproducible experiments.

---

# 35. New core mechanism: Evaluation contamination control

Never allow the evolutionary process to silently train on its own evaluation answers.

Track:

```text
which benchmark it came from
candidate exposure
memory exposure
previous usage
```

A task that has been used for mutation should not be treated as a clean test forever.

Introduce benchmark states:

```text
fresh
search
validation
holdout
contaminated
retired
```

---

# 36. New core mechanism: Artifact lineage and causal attribution

When performance improves, determine which change caused it.

Record:

```text
candidate
parents
mutation operator
changed components
benchmark delta
```

If three things changed simultaneously and performance improved, do not incorrectly credit one of them.

Use isolated ablations where practical:

```text
baseline
A only
B only
A+B
```

This enables more reliable future search.

---

# 37. New core mechanism: Evolution budget controller

Each experiment receives a budget:

```yaml
budget:
  max_rollouts:
  max_tokens:
  max_cost:
  time_limit:
  parallelism:
```

Allocation policy:

```text
high-potential candidates → more budget
low-potential candidates → early stop
novel candidates → exploration budget
```

This is analogous to resource allocation in evolutionary search.

---

# 38. New core mechanism: Early stopping and successive halving

Instead of fully evaluating every candidate:

```text
100 candidates
 ↓
cheap 5-case screen
 ↓
30 survive
 ↓
20-case validation
 ↓
8 survive
 ↓
full evaluation
 ↓
2 canary
```

This can drastically reduce evolutionary cost.

---

# 39. New core mechanism: Retrieval-aware evolution

Evolution should be able to modify not only how an agent reasons, but also what it retrieves.

Candidate dimensions:

```text
retrieval source
query expansion
weights
reranker
MMR
memory scope
graph depth
active-memory threshold
```

Evaluate downstream task success, not only retrieval precision.

---

# 40. New core mechanism: Skill utility learning

A skill should be judged by downstream value:

```text
skill loaded
→ task outcome
→ improvement relative to no-skill baseline
```

This prevents highly viewed but low-value skills from appearing successful.

Store:

```yaml
skill_utility:
  uses:
  assisted_tasks:
  successful_tasks:
  incremental_gain:
  cost_overhead:
```

---

# 41. New core mechanism: Skill graph

A skill library should become a graph:

```text
skill
 ├── prerequisite
 ├── composed_with
 ├── supersedes
 ├── conflicts_with
 ├── derived_from
 └── validated_by
```

This supports modular reuse and better evolution than a flat folder of Markdown files.

---

# 42. New core mechanism: Controlled self-model

The agent should maintain a lightweight self-model:

```yaml
capability:
  known_strengths:
  known_weaknesses:
  uncertain_areas:
  common_failure_modes:
  preferred_tools:
  evaluator_blindspots:
```

This is not an identity/personality file.

It is a capability model used by the curriculum and routing system.

---

# 43. New core mechanism: Uncertainty-driven learning

Instead of learning only from failures, learn where the system is uncertain.

Signals:

- evaluator disagreement;
- low confidence;
- unstable outputs across seeds/models;
- retrieval ambiguity;
- conflicting evidence.

These become high-value tasks for additional evaluation.

This is an active-learning loop.

---

# 44. New core mechanism: Model disagreement as a search signal

Run two models or two independent reasoning paths.

If they disagree strongly:

```text
disagreement
→ investigate
→ create evidence
→ improve evaluator or policy
```

Disagreement can be more informative than random sampling.

---

# 45. New core mechanism: Adversarial evolution

The evolutionary system needs a dedicated adversary.

```text
Generator
   ↓
Candidate
   ↓
Adversary
   ↓
Find weaknesses
   ↓
Repair
   ↓
Verify
```

Adversarial tasks should target:

- edge cases;
- prompt injection;
- stale memory;
- retrieval traps;
- contradictory evidence;
- tool failures;
- ambiguous instructions;
- evaluator gaming.

---

# 46. New core mechanism: Evaluator gaming defense

An agent may learn to optimize the evaluator rather than the real objective.

Defense mechanisms:

- multiple evaluators;
- hidden holdout;
- behavioral metrics;
- adversarial tests;
- randomized tests;
- human spot checks;
- evaluator rotation.

---

# 47. New core mechanism: Promotion confidence

Promotion should require more than one good run.

Use repeated evaluation:

```text
candidate
 ↓
multiple seeds
 ↓
multiple task slices
 ↓
different evaluator routes
 ↓
confidence interval
```

Then promote only if the measured gain is robust enough for the artifact's risk class.

---

# 48. New core mechanism: Reproducible evolutionary experiments

Every experiment should be replayable.

Record:

```text
models
model versions
prompts
artifact hashes
datasets
evaluator versions
random seeds
tool versions
environment version
```

Without this, the system cannot distinguish real improvement from stochastic luck.

---

# 49. New core mechanism: Human-in-the-loop by exception

Do not require humans for every evolution.

Route only high-risk or ambiguous decisions to humans:

```text
low-risk + strong evidence → auto promote
medium-risk → canary
high-risk → human approval
uncertain → human review
```

Hermes' current memory/skill write approval provides a useful operational pattern: background writes can be staged for review instead of being immediately authoritative.

---

# 50. Recommended final architecture

```text
                         EXPERIENCE
                             │
                             ▼
                        TRACE BUS
                             │
             ┌───────────────┼────────────────┐
             ▼               ▼                ▼
         MEMORY          LEARNING          EVALUATION
         FABRIC          SYSTEM             SYSTEM
             │               │                │
             │               ▼                │
             │         HYPOTHESIS              │
             │               │                │
             └───────────────┼────────────────┘
                             ▼
                     EVOLUTION ENGINE
                             │
      ┌──────────────────────┼────────────────────────┐
      ▼                      ▼                        ▼
 Candidate Generator   Mutation Portfolio       Population Manager
      │                      │                        │
      └──────────────────────┼────────────────────────┘
                             ▼
                      SEARCH / SELECTION
                             │
               ┌─────────────┼─────────────┐
               ▼             ▼             ▼
            baseline      candidate     adversary
               │             │             │
               └─────────────┼─────────────┘
                             ▼
                         VERIFIERS
                             │
                     EVALUATOR ENSEMBLE
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
                HOLDOUT          REGRESSION
                    │                 │
                    └────────┬────────┘
                             ▼
                     PROMOTION GATE
                             │
                    shadow → canary
                             │
                         active
                             │
                         MONITOR
                             │
                    rollback / learn
                             │
                             └────→ TRACE
```

---

# 51. Priority map

## P0 — highest value

1. Immutable trace + event bus
2. Failure memory + anti-patterns
3. Structured reflection
4. Evaluation harness
5. Baseline/candidate replay
6. Regression suite
7. Attribution/trust gates
8. Versioned artifact registry
9. Promotion/rollback
10. protected holdout

## P1 — major capability multiplier

11. Population-based evolution
12. Pareto selection
13. mutation operator portfolio
14. automatic curriculum
15. skill compositionality
16. evaluator ensemble
17. benchmark generator
18. active-memory escalation
19. shadow/canary deployment
20. adaptive model routing

## P2 — advanced evolution

21. island evolution
22. novelty search
23. stagnation detection
24. self-model/capability frontier
25. uncertainty-driven learning
26. adversarial evolution
27. dependency-aware evolution
28. sleep-time compute

## P3 — meta-evolution

29. evolution of mutation operators
30. evolution of evaluator strategy
31. evolution budget optimization
32. self-optimization of routing
33. automated evolution of the evolution engine

---

# 52. What should be removed or demoted from v10

### Demote fixed memory-capacity numbers
A specific character cap can be a product/configuration choice, not a fundamental architecture rule.

### Demote fixed dreaming times
Treat cadence as a scheduler policy, not a cognitive mechanism.

### Demote QMD as a core abstraction
Use a Retriever interface with multiple providers/channels.

### Demote knowledge graph to later phase
The graph is valuable only after claims, source references and retrieval utility are working.

### Demote GEPA from "the evolution engine"
GEPA is an evolutionary optimizer inside a larger governed evolution engine.

### Remove hard-coded improvement targets as architecture guarantees
Targets should become measured baselines and experimental outcomes.

---

# 53. Highest-value upgrades to existing mechanisms

| Existing mechanism | v11 upgrade |
|---|---|
| Periodic Nudge | Event/condition-based metacognitive triggers |
| Background Review | Structured failure/pattern analysis with narrow tools |
| Memory | Evidence-backed claim graph + utility feedback |
| Dreaming | Attribution gate + merge/supersede + preimage rollback |
| Active Memory | Escalation lane, not every-turn LLM retrieval |
| Hybrid Search | Task-aware retrieval policy + downstream utility learning |
| Skill Creation | Proposal → benchmark → canary → promotion |
| Skill Curator | Usage + utility + drift + dependency-aware lifecycle |
| GEPA | Population evolution + objectives + protected evaluation |
| Heartbeat | Maintenance/monitoring, not generic scheduling |
| Multi-Agent | Separation of duties + specialist roles |
| Knowledge Graph | Claims/evidence/contradiction/supersession graph |
| Metrics | Learning velocity + regression debt + capability frontier |
| Cache optimization | Economic optimization subordinate to quality |

---

# 54. Updated roadmap

## Phase 0 — Contracts

Trace schema, artifact schema, event schema, evaluation contract, source references, risk model, lifecycle states.

## Phase 1 — Trace & replay

Immutable traces, event bus, replay engine, artifact version capture.

## Phase 2 — Memory & retrieval

Episodic/semantic/procedural/failure/anti-pattern memory; deterministic retrieval; session search; source references.

## Phase 3 — Evaluation

Golden set, regression set, holdout, evaluator ensemble, benchmark store.

## Phase 4 — Governed skills

Skill registry, workshop, curator, proposal/apply/rollback.

## Phase 5 — Evolution Engine MVP

Hypotheses, candidate generation, mutation operators, baseline/candidate evaluation, selection, rejection memory.

## Phase 6 — Production evolution

Shadow mode, canary mode, monitoring, rollback.

## Phase 7 — Population evolution

GEPA, Pareto frontier, multiple candidate strategies, adaptive budget.

## Phase 8 — Open-ended learning

Automatic curriculum, capability frontier, active learning, novelty search, stagnation recovery.

## Phase 9 — Advanced memory

Active Memory escalation, claim graph, graph/vector hybrid, sleep-time compute.

## Phase 10 — Meta-evolution

Learn which operators, models, evaluators and budgets are effective for each task class.

---

# 55. The true north-star metric

Do not optimize "number of memories", "number of skills", or "number of evolution cycles".

Optimize:

## Capability Gain per Unit of Compute

```text
Capability Gain
-------------------------
Dollar / Token / Time
```

Then maintain supporting metrics:

- learning velocity;
- failure recurrence;
- skill incremental utility;
- memory utility;
- benchmark robustness;
- regression debt;
- promotion quality;
- rollback rate;
- evaluator reliability.

A system that creates 100 skills but improves task success by 1% is worse than a system that creates 5 skills and improves success by 20%.

---

# 56. Final recommendation

The highest-value transformation of the DeepSeek Harness is:

```text
Agent with Memory
        ↓
Agent with Learning Loop
        ↓
Agent with Evaluation Loop
        ↓
Agent with Evolution Loop
        ↓
Agent with Governed Meta-Evolution
```

The architectural center should therefore be **Evolution Engine + Evaluation Harness + Trace/Source Fabric**, while Memory, Skills, GEPA, Dreaming, Active Memory and Multi-Agent systems become specialized components around that center.

The strongest external lessons are:

- Hermes: bounded curated memory, on-demand skills, background self-improvement, curator and recoverable maintenance.
- OpenClaw: source-aware memory admission, deterministic recall before deeper recall, Dreaming with promotion gates, reviewable consolidation and governed skill evolution.
- Reflexion: structured verbal reinforcement from failures.
- Self-Refine: local iterative refinement at inference time.
- Voyager: automatic curriculum + executable compositional skill library.
- PromptBreeder: self-referential mutation strategy evolution.
- GEPA: trace-aware reflective optimization + Pareto frontier + textual feedback.
- AlphaEvolve: automated evaluation as the source of truth for evolutionary search.
- OpenEvolve: population, islands, archive, migration and exploration/exploitation control.
- Sleep-time compute: amortize expensive reasoning offline when future demand is predictable.

Together these imply that the next-generation Harness should be designed as an **experimental evolutionary operating system for agent behavior**, not merely as a smarter memory layer.

---

# 57. External research: HKUDS/OpenSpace — evidence-driven skill evolution

OpenSpace (`https://github.com/HKUDS/OpenSpace`, Python, MIT, v2) is a skill-management layer for MCP-hosted agents, read here at the source level (`openspace/skill_engine/*`, `openspace/cloud/*`, `apps/dashboard/src/api/*`) rather than from its README claims alone.

## 57.1 What OpenSpace actually ships

- Skills are SQLite-backed versioned records (`skill_records`, `skill_lineage_parents`, `execution_analyses`, `skill_judgments`, `skill_trust_observations`, `skill_tool_deps`, `skill_tags`), not flat Markdown files with side telemetry.
- Evolution runs through a mode-gated pipeline: `TriggerJob → EvidencePacket → Decision → Admission → Authoring → Validator → BehaviorEval → commit-or-candidate` (`openspace/skill_engine/evolution/engine.py`).
- Skill quality is computed from real task outcomes: a per-task `ExecutionAnalysis` carries `SkillJudgment{skill_id, skill_applied, note}` entries; `SkillRecord` derives `applied_rate`, `completion_rate`, `effective_rate`, `fallback_rate` from atomic SQL counters (`skill_engine/store.py:record_analysis`).
- Skills carry a version DAG: `SkillOrigin = imported | captured | derived | fixed`, `SkillLineage{generation, parent_skill_ids, content_diff, content_snapshot, change_summary, created_by}` (`skill_engine/types.py`).
- Trust is evidence-backed, not time-based: `SkillTrustState = provisional | trusted`; a skill demotes to `provisional` immediately on an attributable failure and promotes to `trusted` after `trust_promotion_min_independent_successes` (default 2) independent successful observations (`store.py:1325-1371`).
- Failure signals are graded, not flat: `actionability ∈ {observe_only, ranking_only, trigger_review, manual_review}` × `evidence_status ∈ {complete, actionable_partial, missing_result, missing_skill_context, aggregate_only, ambiguous_subject, conflicting, external_only}`, deduplicated by `merge_key`/`failure_signature`, with a dominance precedence so the most decisive signal for one merge key wins (`skill_engine/signals/types.py`, `signals/policy.py`).
- Retrieval is BM25 rough-rank (`rank_bm25.BM25Okapi`) → embedding cosine re-rank, cached and invalidated per skill after evolution (`skill_engine/skill_ranker.py`); pre-filtering only activates past `PREFILTER_THRESHOLD = 10` skills.
- Rejected or blocked proposals are durable, not discarded: `EvolutionCandidate{merge_key (unique while pending), recurrence, blocked_reason, needed_evidence}` remembers what evidence was missing, so the same mistake is not silently retried (`evolution/candidates.py`).
- Skill creation ("CAPTURED") requires a `CaptureContract{capability, procedure_refs, validation_refs, validation_summary, limitations}`: procedural evidence and independent validation evidence are both required, and overlapping or fallback-only evidence is a hard admission failure (`skill_engine/capture_contract.py`).
- Behavior evaluation has three gates before a commit is approved: contract check, routing check (a real selector run against positive and negative trigger queries), and replay (baseline-revision-set vs candidate-revision-set); only replay can approve (`evolution/behavior_eval.py`).
- There is no stored anti-pattern artifact. Negative knowledge lives as graded quality signals, admission hard-failures (`ephemeral_or_secret_dependent_capture`, `permission_bypass_capture`), and required negative trigger queries inside every proposal's eval plan, not a separate skill type.

Source: direct reads of `openspace/skill_engine/{types,store,skill_ranker}.py`, `openspace/skill_engine/evolution/{engine,candidates,admission,validator,behavior_eval,authoring_contract}.py`, `openspace/skill_engine/{evidence,signals,triggers}/*.py`, `openspace/skill_engine/capture_contract.py`, `apps/dashboard/src/api/{types,evolution}.ts`, README.md:301-719. https://github.com/HKUDS/OpenSpace

## 57.2 Mapped against this repository's actual evolution-* implementation

The Harness already implements a substantial share of the mechanism families this document calls for (§3–§49) under `packages/evolution/*` and `packages/skill/evolution-skill-*` — verified by direct source reads, not the aspirational v10 description in §1:

| Existing dsh mechanism | Verified current behavior |
|---|---|
| `evolution-feedback` | Per-session failing-tool-result store, deduplicated by tool and message. `summary(sessionIds, limit)` **does** have callers (`evolution-curator:482`, `evolution-dreaming` light phase — corrected from an earlier "no in-repo caller" reading, see §58.0), but the result is display-only and drives no state transition. The package is also **not mounted** in the product profile (`packages/bundle/web-app/cordis.patch.yml`), so today those callers never observe a result at all. |
| `evolution-skill-telemetry` | Per-skill counters (`useCount`, `viewCount`, `patchCount`), `sessionIds` correlation, `createdBy: agent \| foreground \| null`, lifecycle `state: active \| stale \| archived`. `markAgentCreated` exists but has no production caller (only exercised in `consolidate.spec.ts`, `curator.spec.ts`, `safety.spec.ts`). |
| `evolution-curator` | Idle-triggered `active → stale → archived` transitions (time-based only, no evidence-based trust), plus opt-in LLM consolidation (`keep \| patch \| consolidate \| archive`) with tarball snapshot, append-only ledger, and rollback. `surveyCandidates` already joins a skill's `sessionIds` to `evolutionFeedback` failures, but only to inform a consolidation verdict — it never changes a skill's standing. |
| `evolution-dreaming` | Three-phase (light/REM/deep) consolidation with a fixed six-signal weighted composite and three promotion gates (`minScore`, `minRecallCount`, `minUniqueQueries`) — the closest existing analogue to OpenSpace's admission gate, but for memory promotions, not skills. |
| `evolution-skill-manage` | Model-facing tool (`create`, `patch`, `edit`, `write_file`, `remove_file`, `delete`). README: "Writes are immediate and unversioned — rollback is the caller's version control, not the tool." No lineage, no content hash, no revision. |
| `evolution-memory` staged writes | `StagedWriteKind = memory \| skill`; resolutions record only `approved \| rejected`, no `merge_key`, `recurrence`, or `needed_evidence`. |
| `evolution-scorer` | Scores one recorded corpus (workspace-diff pass, metered tokens, median wall time) — no baseline-vs-candidate A/B, no negative routing queries. |

This means the gap between this document's aspirational mechanisms and the shipped Harness is smaller than §1 implies for trace capture, staged writes, and promotion gates, and larger than §1 implies for evidence-graded trust, revision lineage, and admission gates — the exact three mechanisms OpenSpace demonstrates a working design for.

---

# 58. Concrete integration: evidence-graded skill trust, lineage, admission gate, and preimage rollback

Unlike §3–§49, which describe mechanism families in the abstract, this section is decision-complete and scoped against the packages above: the highest-value subset of §57 that closes seams the Harness already built but never wired to a production caller, without adding a new storage domain, a new model call, or a new package. It supersedes §58 as originally drafted with facts verified by a direct source read on 2026-09-14 (§58.0), and extends the original four-step sketch to seven steps that must land together to close **one** governed, production-running loop:

```
tool result error → graded signal → skill trust → survey/verdict
       ↑                                                  ↓
   ledger + preimage  ←  admission gate  ←  revision + contentSha
```

Required order: 1 → 2 → (3, 4, 5) → 6 → 7. The tree builds and existing tests stay green after every step (step 4 deletes `SurveyFailure`, so it must land together with step 1).

## 58.0 Verified state (2026-09-14 session read; supersedes conflicting claims above)

A direct source read of this repository, done for this integration rather than taken from §1's description, corrects and sharpens §57.2:

| Verified fact | Consequence |
|---|---|
| `evolution-feedback` is **not mounted** in the repository's only product profile, `packages/bundle/web-app/cordis.patch.yml` (9 of 13 evolution packages are mounted; this one is not). `ctx.get('evolutionFeedback')` is always `undefined` in the curator today. | §58.7 mounts it — without this, §58.2 and §58.5 never run in production. |
| `evolution-feedback.summary()` **does** have callers — `evolution-curator:482` and `evolution-dreaming`'s light phase — contradicting the "no in-repo caller" claim in §57.2's original table. The result is display-only today; it drives no state transition. | §58.5 turns it into a decision. |
| `markAgentCreated` has **no production caller** anywhere (only exercised from 4 spec files). `surveyCandidates()` filters out `usage.createdBy !== 'agent'`, so the consolidation machinery (fork LLM, verdict, snapshot, ledger) is dead code in the shipped product — there are zero agent-created skills in production today. | §58.4 wires authorship back in. |
| Skill lifecycle transitions purely on elapsed time (`decideTransition`: idle past `staleAfterDays`/`archiveAfterDays`); no evidence participates. | §58.3 + §58.5. |
| `skill_manage` writes `SKILL.md` directly with `writeFile` — no revision, no content hash, no preimage. `applyConsolidation`'s `patch` branch does the same, with ledger `before: null, after: null`. The package README's rollback description ("restore lifecycle states") does not, in fact, restore a patched body. | §58.3 (lineage) + §58.6 (preimage + admission gate). |
| `applyConsolidation` does not validate the body the model returns; a body that drops its frontmatter breaks the skill and there is no way back. | §58.6. |
| No fixture under `snapshots/` mounts any `evolution-*` package — none of this touches the snapshot-refresh surface, and none of it adds content to a model prompt (the feedback store contributes nothing to prompts). | — |
| `pnpm run verify-md-links` is already red before this work (~40 links to `specs/evolutionary-harness.spec.md`, `specs/improvement.spec.md`, `specs/workspace-memory.md`, none of which exist). Out of scope; verify by diffing the error list, not by running the aggregate `doc-sync`. | §58.10. |

## 58.1 Mechanism-by-mechanism decision (revised)

| # | Mechanism | dsh today (verified) | Decision |
|---|---|---|---|
| 1 | Graded quality signal: `actionability × evidence_status × merge_key`, dominance-ordered | `evolution-feedback` is a flat counted list; `summary()` has callers but they only display, never decide | Adopt — Step 1 |
| 2 | Evidence-backed trust `provisional ↔ trusted`: demote on an attributable failure, promote after N independent successes, anchored so evidence collected before a fix cannot self-promote | Lifecycle is time-based only | Adopt — Step 2 |
| 3 | Linear revision lineage: `revision`, `contentSha`, `parentRevisionSha` per skill | No revision at all; `skill_manage` and `applyConsolidation` both `writeFile` blind | Adopt — Step 2 (bundled with trust: same "artifact changed → prior evidence invalidated" reset) |
| 4 | Authorship wired to the one tool that actually writes agent-authored skills | `markAgentCreated` has zero production callers; the consolidation machinery it gates is dead code | Adopt — Step 3 |
| 5 | Evidence joined to a decision, not just displayed | Curator already joins `sessionIds` → feedback for the consolidation prompt, never for a state change | Adopt — Step 4 |
| 6 | Admission gate before commit (schema/frontmatter validity) | `applyConsolidation` writes `verdict.body` unchecked | Adopt — Step 5 |
| 7 | Preimage + rollback that restores a patched body, not just lifecycle state | Rollback README says "restore lifecycle states"; body is not restored; ledger `before`/`after` are `null` | Adopt — Step 5 |
| 8 | Provider mounted where its consumer runs | `evolution-feedback` absent from the only product profile | Adopt — Step 6 |
| 9 | Candidate store: `merge_key` unique while pending, `recurrence`, `blocked_reason`, `needed_evidence` | Staged writes record only `approved \| rejected` | Deferred — no repeated-block signal exists yet to justify it |
| 10 | Behavior eval 3 gates incl. negative trigger queries, baseline-vs-candidate replay | `evolution-scorer` has no A/B and no negative-trigger check | Deferred — zero agent-created skills exist today; nothing to A/B until Step 4 has run in production |
| 11 | BM25 → embedding re-rank with cache invalidation | Catalog has no ranking | Deferred — only pays off past roughly 10 skills with a measured retrieval miss |
| 12 | `CaptureContract` requiring independent procedure + validation evidence | `skillCreationEvidence` triggers on repeated output paths alone | Deferred — buildable once Steps 1–4 exist |

## 58.2 Step 1 — graded failure signals in `evolution-feedback`

`packages/evolution/evolution-feedback/src/types.ts` adds:

```ts
/** How decisive a signal is for a state transition. */
export type FeedbackActionability = 'observe_only' | 'ranking_only' | 'trigger_review'

/** Whether there is enough evidence to attribute a failure to a specific tool. */
export type FeedbackEvidenceStatus = 'complete' | 'actionable_partial'

/** One aggregated failure, with its evidence grade attached. */
export interface FeedbackSignal extends FeedbackSummaryEntry {
  actionability: FeedbackActionability
  evidenceStatus: FeedbackEvidenceStatus
  /** `${tool ?? ''}\u0000${message}` — the exact key `summary()` already uses internally. */
  mergeKey: string
}
```

`packages/evolution/evolution-feedback/src/index.ts`:

1. Extract the merge key already built inline at `summary()` line 142 into a module-private `mergeKeyOf(tool: string | null, message: string): string`. `summary()` keeps its exact current behavior and sort order (it now has real callers — do not change it).
2. Add a public method, placed right after `summary()`:

```ts
signals(sessionIds: readonly string[], limit: number): FeedbackSignal[]
```

   - Built on `this.summary(sessionIds, limit)` (reused, no second table read).
   - `evidenceStatus = entry.tool === null ? 'actionable_partial' : 'complete'` (a `null` tool means the failing call itself was not observable).
   - `actionability`: `'trigger_review'` when `evidenceStatus === 'complete' && entry.sessions >= this.resolved.triggerReviewSessions`; `'ranking_only'` when merely `evidenceStatus === 'complete'`; else `'observe_only'`.
   - `mergeKey = mergeKeyOf(entry.tool, entry.message)`.
   - Sort by descending precedence: `evidenceStatus` rank (`complete` 2 / `actionable_partial` 1) → `actionability` rank (`trigger_review` 3 / `ranking_only` 2 / `observe_only` 1) → `sessions` → `count` → `lastAt`. No model call, no new domain.
3. `Config` adds `triggerReviewSessions?: number` with JSDoc (required for `gen-config-catalog`'s `checkMemberDocs`), zod `z.number().step(1).min(1).default(2)`; add to `ResolvedConfig` and `resolveConfig` (destructured default `= 2`, never a hidden `??`).

## 58.3 Step 2 — evidence-backed trust and revision lineage in `evolution-skill-telemetry`

`src/types.ts` adds, and extends `SkillUsageRecord` with, seven fields:

```ts
/** A skill's trust standing, derived from evidence rather than elapsed time. */
export type SkillTrustState = 'provisional' | 'trusted'

/** The most recent failure attributed to this skill — negative knowledge on the artifact itself. */
export interface SkillTrustFailure {
  mergeKey: string
  message: string
  at: string
}
```

```ts
  trust: SkillTrustState
  /** Times demoted by evidence (does not count demotions caused by an edit). */
  trustFailures: number
  /** Sessions already counted toward a pending promotion, newest first. */
  trustObservedSessions: readonly string[]
  /** Newest session at the moment of the last demotion; only sessions newer than this count. */
  trustAnchorSessionId: string | null
  lastTrustFailure: SkillTrustFailure | null
  /** Times the SKILL.md body has changed, starting at 0. A linear chain keyed by skill name. */
  revision: number
  /** sha256-hex of the current SKILL.md body, or null when never written through this path. */
  contentSha: string | null
  parentRevisionSha: string | null
```

`src/spec.ts` adds exactly these fields to `skillUsageRecord`, **all `.default(...)`**, without bumping `version` (per the file's own rule — "compatible reshapes add an optional or defaulted field, never a version bump"):

```ts
  trust: z.enum(['provisional', 'trusted']).default('trusted'),
  trustFailures: z.number().int().nonnegative().default(0),
  trustObservedSessions: z.array(z.string()).default([]),
  trustAnchorSessionId: z.string().nullable().default(null),
  lastTrustFailure: z.object({ mergeKey: z.string(), message: z.string(), at: z.string() }).nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
  contentSha: z.string().nullable().default(null),
  parentRevisionSha: z.string().nullable().default(null),
```

`src/index.ts`:

1. `freshRecord()` (line 106): `trust: 'trusted'`, `trustFailures: 0`, `trustObservedSessions: []`, `trustAnchorSessionId: null`, `lastTrustFailure: null`, `revision: 0`, `contentSha: null`, `parentRevisionSha: null`. New records default `trusted` because no evidence yet exists against them; only an artifact the **model wrote** or that was **just edited** drops to `provisional`.
2. A module-private helper (one place defines "the artifact changed, so prior evidence no longer counts"):

```ts
function resetTrust(record: SkillUsageRecord): SkillUsageRecord {
  return {
    ...record,
    trust: 'provisional',
    trustObservedSessions: [],
    trustAnchorSessionId: record.sessionIds[0] ?? null,
  }
}
```

3. `markPatched` (line 231) and `markAgentCreated` (line 244) apply `resetTrust` to the record they return. `markAgentCreated` keeps its existing "no change, no write" early exit, but that exit must now also require `trust === 'provisional'` — the guard becomes `current.createdBy === 'agent' && current.trust === 'provisional'`.
4. `markAgentCreated`'s JSDoc is rewritten: `createdBy: 'agent'` means **the model wrote this skill through `skill_manage`**, not yet vouched for by a user; `markAdopted` (`/curator adopt`) is the user-vouching path. Drop the "foreground creates never call this" line.
5. New public method:

```ts
/**
 * Records one trust observation for a skill. Only sessions newer than the
 * last demotion's anchor count, so evidence collected before a fix cannot
 * self-promote the skill again.
 * @param name - skill name.
 * @param outcome - the observed outcome.
 * @param sessionId - the session that loaded this skill.
 * @param failure - attribution evidence, used only for `'failure'`.
 * @returns the saved record, or undefined for an excluded source.
 */
async recordTrustObservation(
  name: string,
  outcome: 'success' | 'failure',
  sessionId: string,
  failure?: SkillTrustFailure,
): Promise<SkillUsageRecord | undefined>
```

   - An excluded source (`isExcludedSkillSource(await this.lookupSource(name))`) returns `undefined`, no write.
   - `'failure'` → `{ ...resetTrust(record), trustFailures: record.trustFailures + 1, lastTrustFailure: failure ?? record.lastTrustFailure }`.
   - `'success'` → inside the `write` callback:
     - `const anchorAt = record.trustAnchorSessionId === null ? -1 : record.sessionIds.indexOf(record.trustAnchorSessionId)`
     - `const at = record.sessionIds.indexOf(sessionId)`; if `anchorAt !== -1 && (at === -1 || at >= anchorAt)` return `record` unchanged (the session is not newer than the anchor; `sessionIds` is newest-first, so a smaller index is newer).
     - if `record.trustObservedSessions.includes(sessionId)` return `record` unchanged (counted independently per session).
     - otherwise: `trustObservedSessions = [sessionId, ...record.trustObservedSessions].slice(0, this.resolved.maxSessionIds)`, and `trust = next.length >= this.resolved.trustPromotionSessions ? 'trusted' : record.trust`.
   - When the record would not change, return before calling `write` — no wasted disk write.
6. New public method:

```ts
/**
 * Records a new revision of the SKILL.md body. The store hashes it itself so
 * only one place defines the shape of `contentSha`; rewriting identical
 * content is a no-op.
 * @param name - skill name.
 * @param content - the exact bytes just written to SKILL.md.
 * @returns the saved record, or undefined for an excluded source.
 */
async markRevised(name: string, content: string): Promise<SkillUsageRecord | undefined>
```

   `contentSha = createHash('sha256').update(content).digest('hex')` (`node:crypto`). If `record.contentSha === contentSha`, return the current record unchanged. Otherwise `{ ...resetTrust(record), revision: record.revision + 1, parentRevisionSha: record.contentSha, contentSha }`.
7. `Config` adds `trustPromotionSessions?: number` (JSDoc + `z.number().step(1).min(1).default(2)`) plus `ResolvedConfig` and `resolveConfig` wiring.

## 58.4 Step 3 — reconnect authorship and lineage in `evolution-skill-manage`

`packages/skill/evolution-skill-manage/src/index.ts`:

1. `createSkill`'s signature becomes `createSkill(ctx: Context, createDir: string, args: ResolvedManageArgs, signal: AbortSignal)`; the call site in `execute` (line 139) becomes `createSkill(ctx, createDir, args, signal)`.
2. In `createSkill`, right after the successful `writeFile`, before `return`:

```ts
const telemetry = ctx.get('evolutionSkillTelemetry')
await telemetry?.markAgentCreated(args.name)
await telemetry?.markRevised(args.name, /* the file content just written */)
```

   (`buildSkillFile(...)` already builds the string — assign it to a variable and reuse it for both `writeFile` and `markRevised`; do not re-read the file from disk.)
3. `patchSkill` (lines 262-263): after `markPatched`, add `await ctx.get('evolutionSkillTelemetry')?.markRevised(args.name, next)`.
4. `editSkill` (lines 285-286): build `const file = \`---\n${split.head}\n---\n${content}\`` once, write it, then `markRevised(args.name, file)`.
5. `write_file` / `remove_file` keep calling only `markPatched` — `SKILL.md`'s body is unchanged, so there is no new revision, but trust still resets (this package's behavior does change here: any write, even to a side file, invalidates prior trust evidence).
6. The package README states plainly: every `create` through `skill_manage` carries an `agent` creation record; a user vouches for it with `/curator adopt <name>`; `consolidate` defaults to off, so this is not a silent behavior change.

## 58.5 Step 4 — evidence enters decisions in `evolution-curator`

`packages/evolution/evolution-curator/src/types.ts`:

1. **Delete** `SurveyFailure` outright (clean cutover, no alias). `SurveyCandidate.failures` becomes `readonly FeedbackSignal[]` (`import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'` — already a peer with a tsconfig reference, no new dependency).
2. `SurveyCandidate` gains: `trust: SkillTrustState`, `revision: number`, `contentSha: string | null`, `lastTrustFailure: SkillTrustFailure | null` (all re-exported types from telemetry, the same pattern `SkillLifecycleState` already uses at lines 7-9).
3. `RollbackReport` gains `restoredFiles: string[]` (used in §58.6) — `/** Skills whose SKILL.md body was restored from a preimage, in ledger order. */`.

`packages/evolution/evolution-curator/src/index.ts`:

4. In `run()`'s per-skill loop (lines 371-404), **after** the three `continue` exclusions (pinned/protected/excluded) and **before** `decideTransition`, insert a trust-recording block; skip it entirely when `dryRun`:

```ts
if (!dryRun) {
  try {
    const signals = this.ctx.get('evolutionFeedback')?.signals(usage.sessionIds, this.resolved.maxCandidateFailures) ?? []
    const attributable = signals.find(signal => signal.actionability === 'trigger_review')
    if (attributable !== undefined) {
      const newest = usage.sessionIds[0]
      if (newest !== undefined) {
        await telemetry.recordTrustObservation(name, 'failure', newest, {
          mergeKey: attributable.mergeKey,
          message: attributable.message,
          at,
        })
      }
    } else {
      for (const sessionId of usage.sessionIds) {
        await telemetry.recordTrustObservation(name, 'success', sessionId)
      }
    }
  } catch (error) {
    this.ctx.logger.warn(`evolution curator could not record trust for '${name}': ${String(error)}`)
  }
}
```

   One broken skill must not break the lifecycle pass: catch per skill, log **one** `warn`, continue. When `evolutionFeedback` is not mounted, `signals` is `[]`, so every session counts as success — the correct behavior when there is no evidence against the skill and the seam is simply absent.
5. `surveyCandidates()` (lines 480-487): replace `feedback.summary(...).map(...)` with `feedback.signals(usage.sessionIds, this.resolved.maxCandidateFailures)` (no mapping needed — `FeedbackSignal` is already the survey shape), and add `trust: usage.trust`, `revision: usage.revision`, `contentSha: usage.contentSha`, `lastTrustFailure: usage.lastTrustFailure`.
6. `src/consolidate.ts` — `frameConsolidationInput`: print `trust` and `revision` per candidate, and `actionability`/`evidenceStatus`/`sessions` per failure, so the verdict is driven by **how decisive the evidence is**, not a raw error string. `consolidationInstructions()` gains exactly one sentence: only `patch`/`archive` a skill that is `provisional` or has a `trigger_review` signal; a `trusted` skill with no signal is `keep`.
7. `packages/evolution/command-evolution/src/index.ts` — `executeCuratorStatus` (lines 729-748): the "Tracked skills" line gains a `· trust: <N> provisional, <M> trusted` suffix counted from `telemetry.entries()`.

## 58.6 Step 5 — admission gate + preimage for patches, and body-restoring rollback

`packages/evolution/evolution-curator/src/safety.ts` adds three exports (a content blob uses a `.md` extension, and never touches `writeBlob`/`readBlob`, which address `blobs/<sha>.json` for records — an existing user's on-disk record blobs must keep reading exactly as before):

```ts
export function textSha(text: string): string                                   // sha256-hex
export async function writeTextBlob(home: string, sha: string, text: string): Promise<void>   // blobs/<sha>.md
export async function readTextBlob(home: string, sha: string): Promise<string>
```

`recordSha` becomes `return textSha(JSON.stringify(record))`, so only one place hashes (value unchanged, existing blobs still match).

`packages/evolution/evolution-curator/src/consolidate.ts`:

1. Add a dependency on `@deepseek-ai/dsh-evolution-skill-manage` (peer + dev, `workspace:^`) to `packages/evolution/evolution-curator/package.json`, and `{ "path": "../../skill/evolution-skill-manage" }` to `tsconfig.json` references. No dependency cycle: skill-manage never references curator.
2. A module-private helper, reusing the exact invariant `skill_manage edit` already enforces (one implementation of one invariant):

```ts
/** Validates a body before commit: same invariant `skill_manage edit` checks. */
function isValidSkillBody(name: string, body: string): boolean {
  const split = splitFrontmatter(body)
  if (split === undefined) return false
  try {
    validateSkillHead(split.head, name)
    return true
  } catch {
    // Swallows only frontmatter-validation errors; a broken verdict is
    // dropped like any other inapplicable verdict, and the pass continues.
    return false
  }
}
```

   (`splitFrontmatter`, `validateSkillHead`, `SKILL_FILE` are already re-exported from `@deepseek-ai/dsh-evolution-skill-manage/src/index.ts:29-39`.)
3. The `patch` branch inside `applyConsolidation` (lines 266-282) is rewritten to reject first, write the preimage, then commit:

```ts
if (verdict.action === 'patch') {
  if (verdict.body === undefined || !isValidSkillBody(verdict.name, verdict.body)) {
    applied.skipped += 1
    continue
  }
  const file = join(dir, SKILL_FILE)
  const previous = await readFile(file, 'utf8')
  const beforeSha = textSha(previous)
  await writeTextBlob(deps.home, beforeSha, previous)
  await writeFile(file, verdict.body)
  const revised = await deps.telemetry.markRevised(verdict.name, verdict.body)
  await appendLedger(deps.home, {
    id: randomUUID(),
    at: deps.at,
    actor: 'curator',
    action: 'patch',
    evidence: { passId: deps.passId, name: verdict.name, dir, file },
    before: beforeSha,
    after: revised?.contentSha ?? textSha(verdict.body),
  })
  continue
}
```

`packages/evolution/evolution-curator/src/index.ts`:

4. `rollbackPass` (lines 705-717): before calling `applyRollback`, add

```ts
const patches = entries.filter(entry => entry.action === 'patch' && entry.evidence['passId'] === passId)
const restoredFiles = await this.revertPatchedBodies(label, patches, options.now ?? Date.now())
```

   and return `{ ...report, restoredDirs, restoredFiles }`. `rollbackEntry` returns `restoredFiles: []`.
5. New private `revertPatchedBodies(label, patches, now): Promise<string[]>`, fail-closed in the same style `applyRollback` already uses (verify everything, then write):
   - Skip an entry whose `entry.before === null` or that is missing `evidence.file`: that patch was written **before** this change landed, so it has no preimage to restore (documented in a comment — not a silent skip of an existing referent).
   - For every remaining entry: `before` must have a `blobs/<sha>.md` blob (`pathExists`); if missing, `throw new Error(\`evolution-curator: rollback ${label} is missing the body blob for '<name>'\`)`.
   - Only after verifying every entry: for each, `writeFile(file, await readTextBlob(home, entry.before))`, then `telemetry.markRevised(name, body)` so `contentSha` matches disk, then a `rollback` ledger entry with `evidence: { rollbackOf: label, name, file }`, `before: <current sha>`, `after: entry.before`.
6. `command-evolution` `/curator rollback` (lines 813-816): add one line when `restoredFiles.length > 0`: `` `Restored bodies: ${report.restoredFiles.join(', ')}` ``.

## 58.7 Step 6 — mount `evolution-feedback` into the product profile

Without this, Steps 1 and 4 never run in the shipped product.

1. `packages/bundle/web-app/package.json`: add exactly one line, `"@deepseek-ai/dsh-evolution-feedback": "workspace:^"`, to `dependencies`, alphabetically between `dsh-evolution-curator` (line 110) and `dsh-evolution-memory` (line 111). Not in `devDependencies` — that block only mirrors `peerDependencies` (cordis, loader, shell-env) and contains no evolution package.
2. `packages/bundle/web-app/cordis.patch.yml`: insert **before** `evolution-curator` (a consumer must be listed after its provider):

```yaml
    - id: evolution-feedback
      name: '@deepseek-ai/dsh-evolution-feedback'
```

   No `config` block: the defaults (`enabled: true`, `maxEntries: 100`, `maxMessageChars: 500`, `triggerReviewSessions: 2`) are the intended values.
3. Update the evolution-block comment just above (lines 102-106) to name the feedback store.

## 58.8 Step 7 — regenerate docs/catalogs and record an Agent Note

1. `scripts/gen-doc-graphs.ts`, `evolutionFeedback` entry (~line 545): add `consumers: ['evolution-curator', 'evolution-dreaming']` and rewrite `note` for the new role (graded signals now decide skill trust). `evolutionSkillTelemetry` entry: add trust + revision to `note`.
2. Run the generators in order: `gen-config-catalog`, `gen-cordis-catalog`, `gen-doc-graphs`, `gen-module-graph` (the new dependency from §58.6.1 changes the module graph).
3. Every bilingual README triple (`README.md` + `README.zh.md` + `README.i18n.yaml`) must be edited in the same pass: `evolution-feedback`, `evolution-skill-telemetry`, `evolution-skill-manage`, `evolution-curator`, `command-evolution`, and `packages/evolution/README.md` (its package table is missing `evolution-dreaming` — add the row). Re-hash each pair with `pnpm run verify-translation-pairing --write <file>`.
4. An Agent Note triple, `.agents/notes/implemented/architecture/2026-09-14-evidence-graded-skill-trust.md` + `.zh.md` + `.i18n.yaml`, following the template in `.agents/notes/implemented/architecture/2026-09-13-evolution-feedback.md`. Content: why trust follows evidence rather than elapsed time; why the anchor session exists (evidence collected before an edit must not self-promote); why the preimage uses a separate `.md` blob instead of touching `writeBlob`; why `createdBy: 'agent'` now means "the model wrote this through `skill_manage`".

## 58.9 Critical files & anchors

- `packages/evolution/evolution-feedback/src/index.ts:135-157` — `summary()`; `signals()` must reuse the exact merge key `${tool ?? ''}\u0000${message}` at line 142 and must not change `summary()`'s sort order.
- `packages/skill/evolution-skill-telemetry/src/spec.ts:16-30` — the zod schema; every new field **requires** `.default(...)`, `version: 1` stays unchanged. `src/index.ts:340-349` `write()` is the sole write path; `freshRecord()` is at line 106.
- `packages/evolution/evolution-curator/src/index.ts:371-404` (`run()`'s per-skill loop, where trust is recorded), `:459-492` (`surveyCandidates`), `:705-717` (`rollbackPass`), `:793-830` (`applyRollback` — the fail-closed template `revertPatchedBodies` mirrors).
- `packages/evolution/evolution-curator/src/consolidate.ts:266-282` — the `patch` branch that today overwrites unchecked with ledger `before/after: null`; this is where the admission gate and preimage land.
- `packages/evolution/evolution-curator/src/safety.ts:71-73,112-115,252-254` — `recordSha`/`writeBlob`/`readBlob` address `blobs/<sha>.json`; the new content blob must use a different extension so it never collides with an existing user's record blobs.
- `packages/bundle/web-app/cordis.patch.yml:102-147` — the repository's only evolution block; entry order is resolve order.

## 58.10 Verification

Run from the repo root (`C:/project/.NET/deepseek-harness`), no API key required.

```sh
pnpm exec vitest run packages/evolution/evolution-feedback packages/skill/evolution-skill-telemetry packages/skill/evolution-skill-manage packages/evolution/evolution-curator packages/evolution/command-evolution
```

New behavioral evidence (concrete input → observable output) goes into each package's existing spec file:

- `packages/evolution/evolution-feedback/tests/feedback.spec.ts`: record two failures in two sessions — one with an observable `tool`/`call`, one without. `signals(['s1','s2'], 10)` returns the tool-bearing signal **first**, `evidenceStatus: 'complete'`, `actionability: 'trigger_review'` (default `triggerReviewSessions: 2`), `mergeKey === "<tool>\u0000<message>"`; the tool-less signal is `actionable_partial` / `observe_only`. On the same data, `summary()` still sorts by `count` as before. A failure seen in only one session is `ranking_only`.
- `packages/skill/evolution-skill-telemetry/tests/telemetry.spec.ts`: `markUsed` on a new skill → `trust: 'trusted'`, `revision: 0`; `markRevised(name, 'body-1')` → `revision: 1`, `contentSha` is the sha256 of `'body-1'`, `parentRevisionSha: null`, `trust: 'provisional'`; `markRevised(name, 'body-1')` again → no change. `markRevised(name, 'body-2')` → `revision: 2`, `parentRevisionSha` equals the prior `contentSha`. Trust: after `markPatched` (anchor = the newest session at that time), `recordTrustObservation(name,'success',<a session older than the anchor>)` → **still** `provisional` and `trustObservedSessions` stays empty; two sessions newer than the anchor → `trusted`; `recordTrustObservation(name,'failure','sN',{mergeKey,message,at})` → `provisional`, `trustFailures: 1`, `lastTrustFailure.message` matches the recorded string, `trustObservedSessions` empty again.
- `packages/skill/evolution-skill-manage/tests/manage.spec.ts`: `create` → record has `createdBy: 'agent'`, `revision: 1`, `trust: 'provisional'`, `contentSha` equal to the sha256 of the file just written; a following `patch` → `revision: 2`, `parentRevisionSha` equal to the prior `contentSha`; `write_file` → `revision` unchanged.
- `packages/evolution/evolution-curator/tests/curator.spec.ts` (proves the **end-to-end loop**): a skill with `createdBy:'agent'`, `markUsed` across two sessions; feedback returns one `trigger_review` signal → after `run()` the record is `provisional`, `lastTrustFailure.mergeKey` matches the signal, and `surveyCandidates()` reports `failures[0].actionability === 'trigger_review'` with `trust: 'provisional'`. Counter-scenario: no `trigger_review` signal, two sessions newer than the anchor → after `run()` the record is `trusted`. Third scenario: `run({dryRun:true})` records no trust at all.
- `packages/evolution/evolution-curator/tests/consolidate.spec.ts`: a `patch` verdict with a body **missing frontmatter** → `skipped` increments, `SKILL.md` **unchanged**, no `patch` ledger entry; a `patch` verdict with a valid body → the file changes, the ledger entry has different `before`/`after` shas, and `blobs/<before>.md` exists and equals the old file body.
- `packages/evolution/evolution-curator/tests/safety.spec.ts` or `curator.spec.ts`: after a consolidation pass with a patch, `rollbackPass(passId)` restores `SKILL.md` to the exact prior bytes, `report.restoredFiles` includes the skill name, and the record's `contentSha` matches the restored disk content; an older patch entry (`before: null`) is skipped rather than thrown.
- `packages/evolution/command-evolution/tests/command-evolution.spec.ts`: `/curator status` prints the `trust: N provisional, M trusted` suffix; `/curator rollback --id <id>` prints `Restored bodies: …` when a file was restored.

Static gates, in order:

```sh
pnpm run gen-config-catalog && pnpm run gen-cordis-catalog && pnpm run gen-doc-graphs && pnpm run gen-module-graph
pnpm run typecheck && pnpm run lint
pnpm run constraints && pnpm run verify-cordis-config
pnpm run verify-translation-pairing
pnpm exec vitest run --coverage packages/evolution/evolution-feedback packages/skill/evolution-skill-telemetry packages/evolution/evolution-curator
```

The repository's coverage gate is **100% per-file** on `packages/*/*/src`: every new branch (the three `actionability` grades, two `evidenceStatus` grades, the anchor branches `-1`/`at === -1`/`at >= anchorAt`, the `markRevised` identical-sha branch, the excluded-source branch, both `isValidSkillBody` false reasons, the missing-preimage rollback branch) needs a corresponding test, or CI goes red.

## 58.11 Assumptions & contingencies

- `pnpm run verify-md-links` is **already red before this change** (~40 links to `specs/evolutionary-harness.spec.md`, `specs/improvement.spec.md`, `specs/workspace-memory.md` — none of the three files exist). Not fixed here. Check by running the gate and diffing against this pre-existing list — **no new broken link may appear**. Use the individual gates above instead of the aggregate `pnpm run doc-sync`; if `doc-sync` is run anyway, expect exactly those three pre-existing errors.
- After Step 3, `createdBy: 'agent'` means "the model wrote this through `skill_manage`" — broader than the old JSDoc's "background review" framing. Consequence: a skill a user asked the agent to write also enters the survey. Acceptable because `consolidate` defaults to `false` and needs a provider/model, and the user still has `/curator adopt`, `/curator pin`, and `protectedNames`. A narrower semantics would need a separate authorship flag, not a reinterpretation of this one — but only once a real background-authorship flow exists.
- Trust is only **recorded and displayed**; it does not gate a skill's visibility to the model. The one new gate is the patch admission gate in Step 5 (frontmatter validity), not a new policy gate.
- Trust advances at the curator's pass cadence (`intervalHours`, default 168h), not per turn — it needs independent sessions, not repeated turns within one.
- If `gen-doc-graphs` rejects a name in `consumers` (e.g. because `evolution-dreaming` is not a declared-dependency consumer), fall back to `['evolution-curator']` only, and if that is still rejected, edit only `note`.
- If `pnpm run constraints` requires `@deepseek-ai/dsh-evolution-skill-manage` in both `peerDependencies` and `devDependencies` at the same range (as curator's other peers), do that; if it instead rejects an evolution → skill cross-group dependency, drop §58.6.1–.2 and replace `isValidSkillBody` with an inline check in `consolidate.ts`: the body must start with `---\n`, have a closing `\n---\n`, and its head must match `/^name:\s*<name>\s*$/m` and `/^description:\s*\S/m`.
- Step 5 is independent of Step 4: if it must be cut, cut it as one block (`restoredFiles` types, safety helpers, the `consolidate.ts` patch branch, rollback) without touching Steps 1–4.
- Does not touch `snapshots/`: confirmed no fixture mounts any `evolution-*` package, and none of this adds content reaching a model prompt (the feedback store contributes nothing to prompts).

## 58.12 What this integration does not do

Trust is recorded and surfaced (survey, `/curator status`); it does not gate a skill's visibility to the model — that would be a product behavior change beyond what was asked. `markAgentCreated` still has no separate background-authorship flow; Step 3 does not invent one, it only makes the one tool that writes agent-authored skills carry real signal. Trust moves at the curator's pass cadence, not per turn, because it requires independent sessions rather than repeated turns within one. The admission gate in Step 5 checks frontmatter validity only — it is not OpenSpace's three-gate behavior evaluation (§57.1's `behavior_eval.py`); that needs a baseline-vs-candidate replay corpus, deliberately deferred (§58.1 row 10) because there are zero agent-created skills in production to replay until Step 3 and Step 6 have both run.

---

# Sources

1. Evolutionary Harness Specification v10 — uploaded source document.
2. Hermes Agent — Persistent Memory and session search: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md
3. Hermes Agent — Curator: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/curator.md
4. Hermes Agent — Skills guide: https://github.com/hermes-agent-org/hermes/blob/main/website/docs/guides/work-with-skills.md
5. Hermes Agent — current self-improvement release notes: https://github.com/NousResearch/hermes-agent/blob/main/RELEASE_v0.12.0.md
6. OpenClaw — Memory overview: https://docs.openclaw.ai/concepts/memory
7. OpenClaw — Active Memory: https://docs.openclaw.ai/concepts/active-memory
8. OpenClaw — Dreaming: https://docs.openclaw.ai/concepts/dreaming
9. OpenClaw — Memory configuration: https://docs.openclaw.ai/reference/memory-config
10. DSPy — GEPA overview: https://github.com/stanfordnlp/dspy/blob/main/docs/docs/api/optimizers/GEPA/overview.md
11. DSPy — GEPA in depth: https://github.com/stanfordnlp/dspy/blob/main/docs/docs/diving-deeper/gepa-in-depth.md
12. Shinn et al. — Reflexion: Language Agents with Verbal Reinforcement Learning: https://arxiv.org/abs/2303.11366
13. Madaan et al. — Self-Refine: Iterative Refinement with Self-Feedback: https://arxiv.org/abs/2303.17651
14. Wang et al. — Voyager: An Open-Ended Embodied Agent with Large Language Models: https://arxiv.org/abs/2305.16291
15. Fernando et al. — PromptBreeder: https://proceedings.mlr.press/v235/fernando24a.html
16. Novikov et al. — AlphaEvolve: A coding agent for scientific and algorithmic discovery: https://arxiv.org/abs/2506.13131
17. DeepMind — AlphaEvolve announcement: https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/
18. OpenEvolve: https://github.com/algorithmicsuperintelligence/openevolve
19. Lin et al. — Sleep-time Compute: https://arxiv.org/abs/2504.13171
20. Packer et al. — MemGPT: Towards LLMs as Operating Systems: https://arxiv.org/abs/2310.08560
21. Park et al. — Generative Agents: https://arxiv.org/abs/2304.03442
22. Liu et al. — AgentBench: https://arxiv.org/abs/2308.03688
23. LongMemEval-V2: https://arxiv.org/abs/2605.12493
24. Yuksekgonul et al. — TextGrad: https://arxiv.org/abs/2406.07496
25. OpenSpace — HKUDS/OpenSpace repository: https://github.com/HKUDS/OpenSpace
26. OpenSpace — skill_engine core types (`SkillOrigin`, `SkillLineage`, `SkillTrustState`, `ExecutionAnalysis`): https://github.com/HKUDS/OpenSpace/blob/main/openspace/skill_engine/types.py
27. OpenSpace — skill quality store and trust-observation transitions: https://github.com/HKUDS/OpenSpace/blob/main/openspace/skill_engine/store.py
28. OpenSpace — evolution engine, admission, validator, behavior evaluation, candidates: https://github.com/HKUDS/OpenSpace/tree/main/openspace/skill_engine/evolution
29. OpenSpace — graded quality signals and trigger policy: https://github.com/HKUDS/OpenSpace/tree/main/openspace/skill_engine/signals
30. OpenSpace — SkillRanker hybrid BM25/embedding retrieval: https://github.com/HKUDS/OpenSpace/blob/main/openspace/skill_engine/skill_ranker.py
31. OpenSpace — capture contract for CAPTURED evolution: https://github.com/HKUDS/OpenSpace/blob/main/openspace/skill_engine/capture_contract.py
32. DeepSeek Harness — evolution package group, current implementation: `packages/evolution/README.md`
33. DeepSeek Harness — evolution-feedback, current implementation: `packages/evolution/evolution-feedback/README.md`
34. DeepSeek Harness — evolution-skill-telemetry, current implementation: `packages/skill/evolution-skill-telemetry/README.md`
35. DeepSeek Harness — evolution-curator, current implementation: `packages/evolution/evolution-curator/README.md`

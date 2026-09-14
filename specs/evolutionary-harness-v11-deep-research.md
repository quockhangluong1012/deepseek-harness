# Evolutionary Harness v11 — Deep Research & Mechanism Upgrade

## Executive conclusion

The highest-value upgrade is to treat Evolutionary Harness as a governed optimization system rather than a collection of memory and automation features.

The central loop should be:

Experience → Trace → Credit Assignment → Failure/Pattern Mining → Hypothesis → Candidate Generation → Evaluation → Selection → Promotion → Monitoring → Regression/Rollback → New Evidence

The key insight from current agent systems and evolutionary research is that capability growth is driven by five interacting factors:

1. **Learning-signal quality** — detailed traces, external feedback, verifier results, failures and counterexamples.
2. **Search quality** — diversity, mutation operators, population management, Pareto selection and exploration/exploitation balance.
3. **Skill/memory quality** — retrieval, consolidation, compositionality, provenance and anti-patterns.
4. **Evaluation quality** — robust benchmarks, multi-objective scoring, held-out tests, adversarial/regression suites and contamination controls.
5. **Governance quality** — promotion gates, autonomy levels, canaries, provenance, rollback and auditability.

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
Trace and provenance.

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

OpenClaw's current Dreaming system has become strongly provenance-aware: promotions use score, recall-frequency and query-diversity gates; untrusted/system-derived candidates are kept out of the durable promotion path; accepted rewrites retain preimages and reviewable dream reports.

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
benchmark provenance
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
7. Provenance/trust gates
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
The graph is valuable only after claims, provenance and retrieval utility are working.

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
| Dreaming | Provenance gate + merge/supersede + preimage rollback |
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

Trace schema, artifact schema, event schema, evaluation contract, provenance, risk model, lifecycle states.

## Phase 1 — Trace & replay

Immutable traces, event bus, replay engine, artifact version capture.

## Phase 2 — Memory & retrieval

Episodic/semantic/procedural/failure/anti-pattern memory; deterministic retrieval; session search; provenance.

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

The architectural center should therefore be **Evolution Engine + Evaluation Harness + Trace/Provenance Fabric**, while Memory, Skills, GEPA, Dreaming, Active Memory and Multi-Agent systems become specialized components around that center.

The strongest external lessons are:

- Hermes: bounded curated memory, on-demand skills, background self-improvement, curator and recoverable maintenance.
- OpenClaw: provenance-aware memory admission, deterministic recall before deeper recall, Dreaming with promotion gates, reviewable consolidation and governed skill evolution.
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
| `evolution-feedback` | Per-session failing-tool-result store, deduplicated by tool and message. `summary(sessionIds, limit)` aggregates across sessions but has no in-repo caller (Dev Note: "the optimizer pass that consumes `summary` is the reason this store exists; until it lands, `summary` has no in-repo caller"). |
| `evolution-skill-telemetry` | Per-skill counters (`useCount`, `viewCount`, `patchCount`), `sessionIds` correlation, `createdBy: agent \| foreground \| null`, lifecycle `state: active \| stale \| archived`. `markAgentCreated` exists but has no production caller (only exercised in `consolidate.spec.ts`, `curator.spec.ts`, `safety.spec.ts`). |
| `evolution-curator` | Idle-triggered `active → stale → archived` transitions (time-based only, no evidence-based trust), plus opt-in LLM consolidation (`keep \| patch \| consolidate \| archive`) with tarball snapshot, append-only ledger, and rollback. `surveyCandidates` already joins a skill's `sessionIds` to `evolutionFeedback` failures, but only to inform a consolidation verdict — it never changes a skill's standing. |
| `evolution-dreaming` | Three-phase (light/REM/deep) consolidation with a fixed six-signal weighted composite and three promotion gates (`minScore`, `minRecallCount`, `minUniqueQueries`) — the closest existing analogue to OpenSpace's admission gate, but for memory promotions, not skills. |
| `evolution-skill-manage` | Model-facing tool (`create`, `patch`, `edit`, `write_file`, `remove_file`, `delete`). README: "Writes are immediate and unversioned — rollback is the caller's version control, not the tool." No lineage, no content hash, no revision. |
| `evolution-memory` staged writes | `StagedWriteKind = memory \| skill`; resolutions record only `approved \| rejected`, no `merge_key`, `recurrence`, or `needed_evidence`. |
| `evolution-scorer` | Scores one recorded corpus (workspace-diff pass, metered tokens, median wall time) — no baseline-vs-candidate A/B, no negative routing queries. |

This means the gap between this document's aspirational mechanisms and the shipped Harness is smaller than §1 implies for trace capture, staged writes, and promotion gates, and larger than §1 implies for evidence-graded trust, revision lineage, and admission gates — the exact three mechanisms OpenSpace demonstrates a working design for.

---

# 58. Concrete integration: evidence-graded skill trust and lineage

Unlike §3–§49, which describe mechanism families in the abstract, this section is a decision-complete integration already scoped against the packages above: the highest-value subset of §57 that closes two seams the Harness already built but never wired to a production caller, without adding a new storage domain or a new model call.

## 58.1 Mechanism-by-mechanism decision

| # | OpenSpace mechanism (source) | dsh today | Decision |
|---|---|---|---|
| 1 | Graded quality signal: `actionability × evidence_status × merge_key` + dominance precedence (`signals/types.py`, `signals/policy.py`) | `evolution-feedback` is a flat counted list; `summary()` has no caller | Adopt — Step 1 |
| 2 | Evidence-backed trust `provisional ↔ trusted`: demote on failure, promote after 2 independent successes (`types.py:SkillTrustState`, `store.py:1325-1371`) | Lifecycle is time-based only | Adopt — Step 2 |
| 3 | Evidence joined to a decision, not just displayed (`evolution/engine.py` admission) | Curator already joins `sessionIds` → feedback for reflection, never for a state change | Adopt — Step 3 |
| 4 | Version DAG: `SkillLineage{origin, generation, parent_skill_ids, content_hash, content_snapshot, change_summary}` (`types.py`) | Rollback restores "states and moves, not patched bodies"; no revision at all | Adopt in reduced form — Step 4 (linear chain + content hash, not a full DAG) |
| 5 | Candidate store: `merge_key` unique while pending, `recurrence`, `blocked_reason`, `needed_evidence` (`evolution/candidates.py`) | Staged writes record only `approved \| rejected` | Deferred — staged queue already prevents duplicate proposals; only worth it once a proposal is blocked repeatedly |
| 6 | Behavior eval 3 gates incl. negative trigger queries, baseline-vs-candidate replay (`evolution/behavior_eval.py`) | `evolution-scorer` has no A/B and no negative-trigger check | Deferred — needs a two-sided scenario corpus, a separate change |
| 7 | BM25 → embedding re-rank with cache invalidation (`skill_ranker.py`) | Catalog has no ranking | Deferred — only pays off past roughly 10 skills with a measured retrieval miss |
| 8 | `CaptureContract` requiring independent procedure and validation evidence (`capture_contract.py`) | `skillCreationEvidence` triggers on 3 repeated output paths alone | Deferred — becomes buildable once Steps 1–2 exist |
| 9 | Mode gating `audit_only \| fix_only \| autonomous` | `writeApproval` + curator `consolidate` flag already gate every write | Not adopted — redundant with existing gates |
| 10 | Task-trace artifact v2 + redaction-gated upload | dsh is machine-local by design, no upload path | Not adopted — no counterpart to protect |

## 58.2 Step 1 — graded failure signals in `evolution-feedback`

Add to `packages/evolution/evolution-feedback/src/types.ts`:

```ts
export type FeedbackActionability = 'observe_only' | 'ranking_only' | 'trigger_review'
export type FeedbackEvidenceStatus = 'complete' | 'actionable_partial'

export interface FeedbackSignal {
  tool: string | null
  message: string
  actionability: FeedbackActionability
  evidenceStatus: FeedbackEvidenceStatus
  mergeKey: string        // `${tool ?? ''}\u0000${message}` — same key `summary` already uses
  count: number
  sessions: number
  lastAt: string
}
```

`signals(sessionIds, limit)` reuses `summary(sessionIds, limit)`: `evidenceStatus` is `complete` when the failing call's tool was observed, else `actionable_partial`; `actionability` is `trigger_review` once `evidenceStatus === 'complete'` and `sessions >= triggerReviewSessions` (config, default 2), `ranking_only` when merely `complete`, else `observe_only`. Results sort by evidence-status rank, then actionability rank, then `sessions`, `count`, `lastAt`. No model call, no new storage — a deterministic derivation from the existing per-session record.

## 58.3 Step 2 — evidence-backed trust in `evolution-skill-telemetry`

Add `SkillTrustState = 'provisional' | 'trusted'` and four `SkillUsageRecord` fields: `trust`, `trustSuccesses`, `trustFailures`, `trustObservedSessions`. Zod defaults (`trust.default('trusted')`, counters `.default(0)`, sessions `.default([])`) keep this a compatible reshape — no domain version bump.

`markPatched` and `markAgentCreated` — both already have real production callers (`evolution-skill-manage`'s four mutation ops; curator's `patch` verdict) — additionally set `trust: 'provisional'` and clear `trustObservedSessions`. This is the production trigger the mechanism needs; no new call site is required.

New method:

```ts
async recordTrustObservation(name: string, outcome: 'success' | 'failure', sessionId: string): Promise<SkillUsageRecord | undefined>
```

`'failure'` sets `trust: 'provisional'`, increments `trustFailures`, and clears `trustObservedSessions` so promotion restarts after a failure. `'success'` is a no-op when `sessionId` is already recorded (independence); otherwise it appends the session (capped by `maxSessionIds`), increments `trustSuccesses`, and promotes to `trusted` once `trustObservedSessions.length >= trustPromotionSessions` (config, default 2).

## 58.4 Step 3 — wire evidence to trust in `evolution-curator`

`SurveyCandidate` gains `trust: SkillTrustState`; `SurveyFailure` is replaced outright by `FeedbackSignal` (clean cutover, no alias). In the curator's lifecycle pass, for each tracked skill: read `evolutionFeedback.signals(usage.sessionIds, maxCandidateFailures)`; if any signal reaches `trigger_review`, record one `failure` observation against the newest loading session; otherwise record one `success` observation per loading session (the store's own session-dedup makes this safe). A per-skill write failure logs one warning and never aborts the pass; `dryRun` records nothing. `command-evolution`'s `/curator status` gains a provisional/trusted count; `gen-doc-graphs.ts` records `evolutionFeedback`'s new consumer, `evolution-curator`.

## 58.5 Step 4 — linear revision lineage

Add `SkillRevisionOrigin = 'created' | 'patched' | 'consolidated'` and `revision`, `parentRevisionSha`, `contentSha`, `revisionOrigin`, `revisedAt` to `SkillUsageRecord`. New method `markRevised(name, origin, contentSha)` advances the chain: `revision += 1`, `parentRevisionSha = record.contentSha`, `contentSha = <new>`. Callers hash the bytes they just wrote — `evolution-skill-manage` after `create`/`patch`/`edit`, `evolution-curator` after a `patch` or `consolidate` verdict. This is deliberately a linear chain keyed by skill name, not OpenSpace's full DAG: deeper history already lives in the curator's ledger and tarball snapshots, so lineage here only needs to answer what changed since the last revision, not replace the ledger.

## 58.6 What this does not do

Trust is recorded and surfaced (survey, `/curator status`); it does not gate a skill's visibility to the model — that would be a product behavior change beyond what was asked. `markAgentCreated` still has no production authorship flow; Step 2 does not invent one, it only makes the existing mutation path (`markPatched`) carry real signal. Trust moves at the curator's pass cadence (`intervalHours`, default 168h), not per turn, because it requires independent sessions, not repeated turns within one.

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

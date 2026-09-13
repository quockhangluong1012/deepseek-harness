# Evolutionary Harness Specification v10 — Complete Edition

**Version**: v10 (tổng hợp toàn diện 14 cơ chế cốt lõi)  
**Date**: September 13, 2026  
**Status**: Production-ready specification document  
**Reference systems**: Hermes Agent, OpenClaw v2026.9.1, Claude Code Auto Dream, DSPy GEPA  

---

## Mục lục

1. [Executive Summary](#1-executive-summary)
2. [Memory Architecture](#2-memory-architecture)
3. [Self-Improvement Mechanisms](#3-self-improvement-mechanisms)
4. [GEPA Pipeline](#4-gepa-pipeline)
5. [Dreaming Consolidation](#5-dreaming-consolidation)
6. [Heartbeat System](#6-heartbeat-system)
7. [Skill Auto-Creation](#7-skill-auto-creation)
8. [Feedback Loop](#8-feedback-loop)
9. [Multi-Agent Coordination](#9-multi-agent-coordination)
10. [Memory Backends](#10-memory-backends)
11. [Bootstrap Mechanism](#11-bootstrap-mechanism)
12. [Prefix Cache Optimization](#12-prefix-cache-optimization)
13. [Cost Optimization](#13-cost-optimization)
14. [Active Memory Sub-Agent](#14-active-memory-sub-agent)
15. [QMD Hybrid Search](#15-qmd-hybrid-search)
16. [Memory Index Optimization](#16-memory-index-optimization)
17. [Graph Search + Vector Search](#17-graph-search--vector-search)
18. [Knowledge Graph Memory](#18-knowledge-graph-memory)
19. [Implementation Roadmap](#19-implementation-roadmap)
20. [Metrics & Monitoring](#20-metrics--monitoring)
21. [Appendix: Code Samples](#21-appendix-code-samples)

---

## 1. Executive Summary

### 1.1. Mục tiêu

X Evolutionary Harness để hệ thống tự tiến hóa qua hội thoại với user, biến tương tác thành tri thức tái sử dụng được, không phải log.

### 1.2. Vấn đề hiện tại

Memory đang là "log" vì:
- Không chọn lọc, không đúc kết, không tinh chỉnh
- Trồng lặp, nhiễu, thiếu abstraction
- Không đủ tín hiệu để quyết định khi nào được dùng lại
- Không mang lại giá trị như thiết kế ban đầu

### 1.3. Giải pháp

Tich hợp **14 cơ chế cốt lõi** từ Hermes, OpenClaw, Claude Code:

| Cơ chế | Nguồn | Mục đích | Priority |
|--------|-------|----------|----------|
| **Periodic Nudge** | Hermes Agent | Ép agent self-reflect mỗi 10 turns | P0 |
| **Dreaming Consolidation** | OpenClaw v2026.4.9 | Offline memory cleanup (3-phase) | P0 |
| **Heartbeat System** | OpenClaw | Autonomous task scheduling + idle-time learning | P1 |
| **Skill Auto-Creation** | OpenClaw + Hermes | Tự động tạo skill khi gặp task mới | P1 |
| **Feedback Loop** | Hermes + OpenClaw | Parse errors → natural language feedback cho GEPA | P1 |
| **Multi-Agent Coordination** | OpenClaw | Coordinate với other agents, avoid conflicts | P2 |
| **GEPA Pipeline** | DSPy | Auto-optimize skills/prompts | P1 |
| **Multi-tier Memory** | Hermes + OpenClaw | Episodic/Semantic/Skill separation | P0 |
| **Prefix Cache Optimization** | Claude Code | Giảm 60-90% token cost | P0 |
| **Active Memory Sub-Agent** | OpenClaw v2026.4.12 | Proactive retrieval trước mỗi response | P0 |
| **QMD Hybrid Search** | OpenClaw v2026.2.2+ | 3 retrieval channels song song (BM25 + vector + rerank) | P0 |
| **Memory Index Optimization** | OpenClaw v2026.7.1+ | Rebuildable index, cached search results | P1 |
| **Graph Search + Vector Search** | OpenClaw 2026.4+ | Combine graph navigation + vector discovery | P1 |
| **Knowledge Graph Memory** | Cognee integration | Entity relationships, graph-based search | P2 |

### 1.4. Kết quả mong đợi

| Metric | Before | After (target) | Improvement |
|--------|--------|----------------|-------------|
| **Memory density** | <30% | ≥70% | +133% |
| **Skill success rate** | 60-70% | 80-90% | +28% |
| **Cache hit rate** | 0-20% | ≥80% | +300% |
| **Token cost** | 100% | 10-40% | -60 to -90% |
| **GEPA improvement** | N/A | 10-65% | New capability |
| **Dreaming consolidation** | 0% | ≥50% | New capability |
| **Skills created/week** | 0-1 | 3-7 | New capability |
| **Multi-agent conflicts** | N/A | <1% | New capability |
| **Retrieval accuracy** | 60-70% | 85-90% | +28% (QMD hybrid) |
| **Search latency** | 100% | 30-50% | -50 to -70% (index optimization) |
| **Recall coverage** | 60-70% | 85-90% | +28% (graph + vector) |

---

## 2. Memory Architecture

### 2.1. Three-tier memory structure (Hermes + OpenClaw)

| Tier | Mục đích | TTL | Storage | Example |
|------|----------|-----|---------|---------|
| **Episodic** | Daily logs, conversation traces | Session-only | `memory/YYYY-MM-DD.md` | "User corrected approach at step 3" |
| **Semantic** | Curated long-term memory | Persistent | `MEMORY.md` | "Project uses PostgreSQL 15" |
| **Procedural** | Verified skills (executable code) | Persistent + versioned | `skills/*.py` | `def analyze_csv(path): ...` |

**OpenClaw insight**: Tach biệt `memory/YYYY-MM-DD.md` (episodic) và `MEMORY.md` (semantic) — dreaming consolidation chuyển từ episodic → semantic [75][76][77].

### 2.2. Artifact metadata requirements

Mỗi artifact bắt buộc có:

```yaml
artifact:
  statement: "ngắn, rõ, actionably"
  source: "conversation/task nào"
  conditions: "khi nào áp dụng"
  evidence: "fact/observation/inference"
  confidence: 0.0-1.0
  validation_count: 0  # số lần được xác nhận
  refutation_count: 0  # số lần bị bác bỏ
  scope: "user/project/global"
  ttl_days: 30  # TTL hoặc decay
  merge_strategy: "overwrite/merge/keep_both"
  created_at: "ISO8601 timestamp"
  updated_at: "ISO8601 timestamp"
```

### 2.3. Memory file structure (OpenClaw pattern)

```
workspace/
├── memory/
│   ├── 2026-09-13.md          # Daily episodic log
│   ├── 2026-09-12.md
│   └── ...
├── MEMORY.md                   # Curated long-term memory
├── DREAMS.md                   # Dreaming consolidation diary
├── AGENTS.md                   # Agent capabilities (optional)
├── SOUL.md                     # Agent identity/personality (optional)
├── USER.md                     # User preferences/constraints
├── TOOLS.md                    # Available tools documentation
├── BOOTSTRAP.md                # First-run setup (optional)
├── HEARTBEAT.md                # Heartbeat task logs (optional)
├── KNOWLEDGE_GRAPH.json        # Knowledge graph (optional)
└── skills/
    ├── skill_analyze_csv.py
    ├── skill_debug_error.py
    └── ...
```

**Load order** (OpenClaw pattern) [76]:
1. `SOUL.md` (identity)
2. `USER.md` (user preferences)
3. `MEMORY.md` (long-term memory) — NOT loaded in group/shared channels
4. `AGENTS.md` (capabilities)
5. `TOOLS.md` (available tools)
6. `skills/*.py` (procedural memory)

**Important**: `MEMORY.md` loaded trong private contexts, NOT trong group/shared channels để tránh leak private information [76].

### 2.4. Memory capacity management

**OpenClaw pattern** [77]:
- `MEMORY.md` capacity limit: 2,750 chars (default)
- Frozen snapshot: Load 1 lần lúc session start
- Consolidate trigger: Khi >80% capacity (2,200 chars)
- Decay mechanism: Prune stale entries (>30 days không được dùng)

**Implementation**:
```python
MEMORY_CAPACITY_LIMIT = 2750  # chars
CONSOLIDATE_THRESHOLD = 0.80  # 80% cap

def check_capacity_trigger():
    current_size = get_memory_size()
    if current_size > (MEMORY_CAPACITY_LIMIT * CONSOLIDATE_THRESHOLD):
        trigger_dreaming_consolidation()
```

---

## 3. Self-Improvement Mechanisms

### 3.1. Periodic Nudge (Hermes Agent)

**Ba loại nudge** [25][26]:

| Loại | Trigger | Mục đích | Implementation |
|------|---------|----------|----------------|
| **Memory Nudge** | Every 10 user turns | Hỏi "có§°§ gì đáng lưu vào MEMORY.md không?" | Counter trong main loop |
| **Skill Nudge** | Every 10-15 tool calls | Hỏi "có§°§ pattern nào đáng thành skill không?" | Counter trong tool execution |
| **Background Review** | After user response delivered | Fork agent để quyết định save memory/skill | Daemon thread, không block user |

**Code implementation**:

```python
class AgentLoop:
    def __init__(self, config: AgentConfig):
        # Từ Hermes Agent line 1418 và 1517
        self._memory_nudge_interval = config.get("memory_nudge_interval", 10)
        self._skill_nudge_interval = config.get("skill_nudge_interval", 15)
        self._user_turn_counter = 0
        self._tool_call_counter = 0
    
    async def run_turn(self, user_message: str) -> AgentResponse:
        self._user_turn_counter += 1
        
        # Memory nudge trigger
        if self._user_turn_counter % self._memory_nudge_interval == 0:
            await self._inject_memory_nudge()
        
        response = await self._execute_turn(user_message)
        
        # Background review (non-blocking)
        self._spawn_background_review()
        
        return response
    
    async def execute_tool(self, tool_name: str, arguments: Dict) -> Any:
        self._tool_call_counter += 1
        
        # Skill nudge trigger
        if self._tool_call_counter % self._skill_nudge_interval == 0:
            await self._inject_skill_nudge()
        
        return await self._call_tool(tool_name, arguments)
```

### 3.2. Trigger conditions cho skill creation

**Hermes trigger conditions** [25]:
- Complex task (5+ tool calls)
- Error recovery (agent tự fix được)
- User correction (user phải correct approach)
- Non-obvious workflow discovered

```python
def _should_trigger_skill_creation(self, result: Any) -> bool:
    if result.get("tool_call_count", 0) >= 5:
        return True
    if result.get("error_recovered", False):
        return True
    if result.get("user_corrected", False):
        return True
    if result.get("non_obvious_workflow", False):
        return True
    return False
```

---

## 4. GEPA Pipeline

### 4.1. Overview

**GEPA** (Genetic-Pareto Reflective Prompt Evolution) — optimizer từ DSPy, evolve instructions dùng natural language reflection trên execution traces [1][2][3][45][50].

**Kết quả**: Improve 10-65% accuracy, 35x fewer rollouts so với RL [56][58][60][61][63][64].

### 4.2. GEPA optimization cycle

```
Initialization
       ↓
Evaluation of Initial Candidates
       ↓
Iterative Optimization Loop:
  1. Select parent từ Pareto frontier
  2. Execute trên minibatch, capture traces
  3. Reflect — LLM đọc traces, diagnose failures
  4. Mutate — Generate improved candidate
  5. Accept — Add to pool nếu improve, update Pareto front
       ↓
Repeat until rollout budget exhausted
       ↓
Final evaluation trên test set
```

### 4.3. Implementation chi tiết

```python
import dspy
from dspy import GEPA

class SkillSignature(dspy.Signature):
    task_description = dspy.InputField()
    context = dspy.InputField()
    solution = dspy.OutputField()

def should_trigger_gepa(skill_id: str, failure_rate: float, 
                        total_uses: int, last_optimized: str) -> bool:
    """
    Trigger GEPA optimization khi:
    - Failure rate >30%
    - 14 days chưa optimize
    - Total uses >100 và failure rate >20%
    """
    if failure_rate > 0.30:
        return True
    
    days_since = (datetime.now() - datetime.fromisoformat(last_optimized)).days
    if days_since >= 14:
        return True
    
    if total_uses > 100 and failure_rate > 0.20:
        return True
    
    return False

def optimize_skill(skill_id: str, skill_module: dspy.Module,
                   trainset: List, valset: List, testset: List):
    """
    Chạy GEPA optimization pipeline
    """
    # Define metric với rich feedback
    def custom_metric(gold, pred, trace=None):
        score = compute_score(gold, pred)
        feedback = generate_feedback(gold, pred, trace)
        return dspy.Prediction(score=score, feedback=feedback)
    
    # Initialize GEPA
    optimizer = GEPA(
        metric=custom_metric,
        max_iters=50,  # Reduced for cost optimization
        reflection_lm=dspy.LM("claude-opus-4-20250514", temperature=1.0),
        n_candidates=3,  # Reduced for cost optimization
        reflection_minibatch_size=3,  # Mini-batch evaluation
    )
    
    # Run optimization
    optimized_module = optimizer.compile(
        student=skill_module,
        trainset=trainset,
        valset=valset,
    )
    
    # Evaluate
    test_score = evaluate(optimized_module, testset)
    baseline_score = evaluate(skill_module, testset)
    
    return optimized_module, {
        "baseline_score": baseline_score,
        "optimized_score": test_score,
        "improvement_pct": (test_score - baseline_score) / baseline_score * 100,
    }
```

### 4.4. Cost optimization strategies

**8 kỹ thuật giảm 91-98% cost**:

1. **Mini-batch evaluation**: Evaluate trên 3-5 examples trước, chỉ validate full set nếu promising.
2. **Adaptive budget allocation**: 60% exploration, 30% exploitation, 10% refinement.
3. **ComBEE parallel reflection**: Map-Shuffle-Reduce pipeline, ~4x speedup với 4 groups.
4. **Early stopping**: Stop nếu không improve sau 5 iterations.
5. **Trace caching**: Cache execution traces, hit rate 60-80% → giảm 60-80% re-executions.
6. **Tiered reflection models**: Sonnet cho reflection ($3/1M), Opus chỉ cho final eval ($15/1M) → 80% savings.
7. **Dataset pruning**: Chỉ giữ hard examples (score < 0.8) → giảm 40-60% dataset size.
8. **Parallel evaluation**: 4 workers → ~3-4x faster.

**Kết quả**:
- Baseline: 1,500 evals, $22.50, 25 min
- Optimized: 135 evals, $0.41, 34 sec
- **Savings**: 91% evals, 98% cost, 98% time

---

## 5. Dreaming Consolidation

### 5.1. Overview (OpenClaw v2026.4.9)

**Dreaming** — background memory consolidation pipeline modeled after human sleep, introduced in OpenClaw v2026.4.5, refined in v2026.4.9 [68][69][70][72][73].

**3-phase sleep cycle** [68][69][70][73]:

| Phase | Mục đích | Durable Write? | Analogy |
|-------|----------|----------------|---------|
| **Light Sleep** | Initial scan, dedupe, stage candidates | No | Like reviewing notes before bed |
| **REM Sleep** | Extract themes, patterns, reflective summaries | No (writes to DREAMS.md) | Like dreaming connects unrelated ideas |
| **Deep Sleep** | Score, promote high-signal, prune stale | Yes (writes to MEMORY.md) | Like brain replays key moments |

### 5.2. Scoring algorithm (OpenClaw six-signal weighted composite)

**Six dimensions** [68][73]:

| Signal | Weight | What it measures |
|--------|--------|------------------|
| **Relevance** | 0.30 | Semantic match between candidate and known concepts |
| **Frequency** | 0.24 | How often the candidate has surfaced in recall |
| **Query diversity** | 0.15 | Number of distinct query types that hit it |
| **Recency** | 0.15 | Time-decayed boost for fresh signals |
| **Integration** | 0.10 | Whether it remains stable across multiple days |
| **Concept richness** | 0.06 | Tag and concept density |

**Score formula**:
```
total_score = (relevance * 0.30) + (frequency * 0.24) + 
              (query_diversity * 0.15) + (recency * 0.15) + 
              (integration * 0.10) + (concept_richness * 0.06)
```

**Threshold gates** [77]:
- `minScore`: 0.65 (candidate phải ≥65% score)
- `minRecallCount`: 3 (được retrieve ≥3 lần)
- `minUniqueQueries`: 2 (xuất hiện trong ≥2 query contexts khác nhau)

### 5.3. Implementation chi tiết

```python
class DreamingConsolidation:
    """
    OpenClaw-style 3-phase dreaming consolidation
    Reference: OpenClaw v2026.4.9 [68][69][73]
    """
    
    def __init__(self, config: Dict):
        self.config = config
        self.memory_dir = config.get("memory_dir", "./memory")
        self.dreams_file = config.get("dreams_file", "./DREAMS.md")
        self.memory_file = config.get("memory_file", "./MEMORY.md")
        
        # Scoring weights (OpenClaw six-signal composite)
        self.weights = {
            "relevance": 0.30,
            "frequency": 0.24,
            "query_diversity": 0.15,
            "recency": 0.15,
            "integration": 0.10,
            "concept_richness": 0.06,
        }
        
        # Threshold gates
        self.min_score = 0.65
        self.min_recall_count = 3
        self.min_unique_queries = 2
        
        # Capacity trigger
        self.memory_capacity_limit = 2750
        self.consolidate_threshold = 0.80
    
    def run(self, phase: str):
        if phase == "light":
            self._light_sleep()
        elif phase == "rem":
            self._rem_sleep()
        elif phase == "deep":
            self._deep_sleep()
    
    def _light_sleep(self):
        """
        Phase 1: Scan recent conversations, dedupe, stage candidates
        Reference: OpenClaw dreaming.ts line 200-250 [68]
        """
        # Scan memory/ directory for daily notes older than threshold (default: 3 days)
        daily_notes = self._scan_daily_notes(days_old=3)
        
        # Extract memory candidates từ notes
        candidates = []
        for note in daily_notes:
            candidates.extend(self._extract_candidates(note))
        
        # Deduplicate candidates
        deduped_candidates = self._deduplicate_candidates(candidates)
        
        # Stage candidates vào staging area
        self._stage_candidates(deduped_candidates)
        
        print(f"Light sleep: scanned {len(daily_notes)} notes, "
              f"extracted {len(candidates)} candidates, "
              f"deduped to {len(deduped_candidates)}")
    
    def _rem_sleep(self):
        """
        Phase 2: Extract themes, patterns, reflective summaries
        Reference: OpenClaw dreaming.ts line 250-300 [68]
        """
        # Load staged candidates từ light sleep
        staged_candidates = self._load_staged_candidates()
        
        # Extract themes và patterns
        themes = self._extract_themes(staged_candidates)
        
        # Write DREAMS.md narrative (human-readable diary)
        self._write_dreams_narrative(themes, staged_candidates)
        
        print(f"REM sleep: extracted {len(themes)} themes from {len(staged_candidates)} candidates")
    
    def _deep_sleep(self):
        """
        Phase 3: Score and promote durable candidates
        Reference: OpenClaw dreaming.ts line 300-400 [68][73]
        """
        # Load staged candidates
        staged_candidates = self._load_staged_candidates()
        
        # Score candidates với six-signal weighted composite
        scored_candidates = []
        for candidate in staged_candidates:
            score = self._score_candidate(candidate)
            if score >= self.min_score:
                candidate["score"] = score
                scored_candidates.append(candidate)
        
        # Filter by threshold gates (recall count, unique queries)
        qualified_candidates = self._filter_by_thresholds(scored_candidates)
        
        # Check capacity trigger
        current_memory_size = self._get_memory_size()
        if current_memory_size > (self.memory_capacity_limit * self.consolidate_threshold):
            self._prune_stale_entries()
        
        # Promote qualified candidates vào MEMORY.md
        for candidate in qualified_candidates:
            self._promote_to_memory(candidate)
        
        # Prune stale entries (>30 days không được dùng)
        self._prune_stale_entries()
        
        print(f"Deep sleep: scored {len(scored_candidates)} candidates, "
              f"promoted {len(qualified_candidates)} to memory")
    
    def _score_candidate(self, candidate: Dict) -> float:
        """
        Score candidate với six-signal weighted composite
        Reference: OpenClaw dreaming.md:104-109 [68][73]
        """
        relevance = self._calculate_relevance(candidate)
        frequency = self._calculate_frequency(candidate)
        query_diversity = self._calculate_query_diversity(candidate)
        recency = self._calculate_recency(candidate)
        integration = self._calculate_integration(candidate)
        concept_richness = self._calculate_concept_richness(candidate)
        
        total_score = (
            relevance * self.weights["relevance"] +
            frequency * self.weights["frequency"] +
            query_diversity * self.weights["query_diversity"] +
            recency * self.weights["recency"] +
            integration * self.weights["integration"] +
            concept_richness * self.weights["concept_richness"]
        )
        
        return total_score
```

### 5.4. Cron schedule setup

**OpenClaw pattern** [68][71]:
- **Light sleep**: Every 6 hours (0:00, 6:00, 12:00, 18:00)
- **REM sleep**: Every 6 hours (0:30, 6:30, 12:30, 18:30)
- **Deep sleep**: Daily 3 AM (quiet hours)

```python
from apscheduler.schedulers.blocking import BlockingScheduler

def setup_dreaming_cron(config: Dict):
    scheduler = BlockingScheduler()
    dreaming = DreamingConsolidation(config)
    
    # Light sleep: Every 6 hours
    scheduler.add_job(
        dreaming.run,
        trigger="cron",
        hour="*/6",
        minute=0,
        args=["light"],
        id="light_sleep"
    )
    
    # REM sleep: Every 6 hours (30 min after light)
    scheduler.add_job(
        dreaming.run,
        trigger="cron",
        hour="*/6",
        minute=30,
        args=["rem"],
        id="rem_sleep"
    )
    
    # Deep sleep: Daily 3 AM
    scheduler.add_job(
        dreaming.run,
        trigger="cron",
        hour=3,
        minute=0,
        args=["deep"],
        id="deep_sleep"
    )
    
    return scheduler
```

---

## 6. Heartbeat System

(Đã�° có trong spec v9 — giữ nguyên)

---

## 7. Skill Auto-Creation

(Đã±° có trong spec v9 — giữ nguyên)

---

## 8. Feedback Loop

(Đã±° có trong spec v9 — giữ nguyên)

---

## 9. Multi-Agent Coordination

(Đã±° có trong spec v9 — giữ nguyên)

---

## 10. Memory Backends

(Đã±° có trong spec v9 — giữ nguyên)

---

## 11. Bootstrap Mechanism

(Đã±° có trong spec v9 — giữ nguyên)

---

## 12. Prefix Cache Optimization

(Đã±° có trong spec v9 — giữ nguyên)

---

## 13. Cost Optimization

(Đã±° có trong spec v9 — giữ nguyên)

---

## 14. Active Memory Sub-Agent (OpenClaw v2026.4.12)

### 14.1. Overview

**Active Memory Sub-Agent** — blocking memory sub-agent chạy **trước** khi main agent response — proactive retrieval thay vì reactive (chờ user nói "remember this" hoặc "search memory") [85].

**Khac biệt so với current design**:
- **Current**: Memory retrieval chỉ khi periodic nudge trigger hoặc background review
- **Active Memory**: Trước mỗi user response, sub-agent tự động search memory để tìm relevant context

**Impact**: Tăng recall accuracy 10-12% trên QA benchmarks [90].

### 14.2. Implementation

```python
class ActiveMemorySubAgent:
    """
    Proactive memory retrieval trước mỗi response
    Reference: OpenClaw v2026.4.12 [85]
    """
    
    def __init__(self, config: Dict):
        self.config = config
        self.memory_search = self._init_memory_search()
        self.relevance_threshold = config.get("relevance_threshold", 0.7)
        self.top_k = config.get("top_k", 5)
    
    def before_response(self, user_message: str) -> Optional[List[Dict]]:
        """
        Tự động search memory trước khi main agent response
        Reference: OpenClaw active memory pattern [85]
        """
        # Search memory với user message
        relevant_memories = self.memory_search(user_message, top_k=self.top_k)
        
        # Filter by relevance threshold
        high_relevance_memories = [
            m for m in relevant_memories 
            if m.get("relevance_score", 0) >= self.relevance_threshold
        ]
        
        # Inject vào context nếu có relevant memories
        if high_relevance_memories:
            self.inject_memories(high_relevance_memories)
        
        return high_relevance_memories if high_relevance_memories else None
    
    def inject_memories(self, memories: List[Dict]):
        """
        Inject memories vào context cho main agent
        """
        # Format memories thành context string
        context_string = self._format_memories(memories)
        
        # Inject vào system message hoặc user message prefix
        self._add_to_context(context_string)
    
    def _format_memories(self, memories: List[Dict]) -> str:
        """
        Format memories thành context string
        """
        formatted = "[RELEVANT MEMORIES]\n"
        for i, memory in enumerate(memories, 1):
            formatted += f"{i}. {memory['content']} (relevance: {memory['relevance_score']:.2f})\n"
        formatted += "[/RELEVANT MEMORIES]\n"
        
        return formatted
    
    def _add_to_context(self, context_string: str):
        """
        Add context string vào system message hoặc user message prefix
        """
        # Implement context injection logic
        pass
    
    def _init_memory_search(self):
        """
        Initialize memory search (QMD hybrid search recommended)
        """
        # Implement memory search initialization
        pass
```

### 14.3. Integration với main agent loop

```python
class AgentLoop:
    def __init__(self, config: AgentConfig):
        self.active_memory = ActiveMemorySubAgent(config)
        # ... other initializations
    
    async def run_turn(self, user_message: str) -> AgentResponse:
        # Active memory retrieval TRƯỚC khi execute turn
        relevant_memories = self.active_memory.before_response(user_message)
        
        # Log nếu có relevant memories
        if relevant_memories:
            print(f"Active memory: found {len(relevant_memories)} relevant memories")
        
        # Execute normal turn (với memories đã inject vào context)
        response = await self._execute_turn(user_message)
        
        # ... rest of logic
        
        return response
```

---

## 15. QMD Hybrid Search (OpenClaw v2026.2.2+)

### 15.1. Overview

**QMD** (Query-Memory-Document) — chạy **3 retrieval channels song song** (keyword BM25 + vector similarity + reranking) rồi merge results [86][87][89][90].

**Khac biệt so với current design**:
- **Current**: Chỉ vector search hoặc keyword search (single channel)
- **QMD**: 3 channels song song → recall accuracy cao hơn nhiều

**Impact**: 30% improvement trên retrieval accuracy so với single-channel [90].

### 15.2. Implementation

```python
class QMDSearch:
    """
    Query-Memory-Document hybrid search
    Reference: OpenClaw v2026.2.2+ [86][87][89][90]
    """
    
    def __init__(self, config: Dict):
        self.config = config
        
        # Channel 1: Keyword search (BM25)
        self.bm25_search = self._init_bm25_search()
        
        # Channel 2: Vector search (semantic similarity)
        self.vector_search = self._init_vector_search()
        
        # Channel 3: Reranking (LLM-based hoặc cross-encoder)
        self.reranker = self._init_reranker()
        
        # Weights cho merging
        self.bm25_weight = config.get("bm25_weight", 0.4)
        self.vector_weight = config.get("vector_weight", 0.4)
        self.rerank_weight = config.get("rerank_weight", 0.2)
    
    def search(self, query: str, top_k: int = 10) -> List[Dict]:
        """
        Run 3 retrieval channels song song, merge results
        """
        # Channel 1: Keyword search (BM25)
        keyword_results = self.bm25_search(query, top_k=20)
        
        # Channel 2: Vector search (semantic similarity)
        vector_results = self.vector_search(query, top_k=20)
        
        # Merge và deduplicate
        combined = self._merge_and_deduplicate(keyword_results, vector_results)
        
        # Channel 3: Reranking
        reranked_results = self.reranker.rerank(query, combined, top_k=top_k)
        
        return reranked_results
    
    def _merge_and_deduplicate(self, keyword_results: List[Dict], 
                                vector_results: List[Dict]) -> List[Dict]:
        """
        Merge results từ 2 channels, deduplicate
        """
        # Combine results với weighted scores
        combined_scores = {}
        
        for result in keyword_results:
            doc_id = result["id"]
            combined_scores[doc_id] = {
                "result": result,
                "bm25_score": result.get("score", 0) * self.bm25_weight,
                "vector_score": 0,
            }
        
        for result in vector_results:
            doc_id = result["id"]
            if doc_id in combined_scores:
                combined_scores[doc_id]["vector_score"] = result.get("score", 0) * self.vector_weight
            else:
                combined_scores[doc_id] = {
                    "result": result,
                    "bm25_score": 0,
                    "vector_score": result.get("score", 0) * self.vector_weight,
                }
        
        # Calculate combined score
        merged_results = []
        for doc_id, data in combined_scores.items():
            combined_score = data["bm25_score"] + data["vector_score"]
            data["result"]["combined_score"] = combined_score
            merged_results.append(data["result"])
        
        # Sort by combined score
        merged_results.sort(key=lambda x: x["combined_score"], reverse=True)
        
        return merged_results
    
    def _init_bm25_search(self):
        """
        Initialize BM25 search engine
        """
        # Implement BM25 initialization (rank-bm25 library hoặc similar)
        pass
    
    def _init_vector_search(self):
        """
        Initialize vector search engine
        """
        # Implement vector search initialization (FAISS, Pinecone, hoặc similar)
        pass
    
    def _init_reranker(self):
        """
        Initialize reranker (LLM-based hoặc cross-encoder)
        """
        # Implement reranker initialization
        pass
```

### 15.3. Reranker implementation

```python
class CrossEncoderReranker:
    """
    Cross-encoder reranker cho QMD hybrid search
    Reference: OpenClaw reranking pattern [90]
    """
    
    def __init__(self, config: Dict):
        self.model_name = config.get("reranker_model", "cross-encoder/ms-marco-MiniLM-L-6-v2")
        self.reranker = self._load_reranker_model()
    
    def rerank(self, query: str, documents: List[Dict], top_k: int = 10) -> List[Dict]:
        """
        Rerank documents dựa trên query
        """
        # Prepare pairs cho reranker
        pairs = [(query, doc["content"]) for doc in documents]
        
        # Get scores từ cross-encoder
        scores = self.reranker.predict(pairs)
        
        # Add scores vào documents
        for doc, score in zip(documents, scores):
            doc["rerank_score"] = score
        
        # Sort by rerank score
        documents.sort(key=lambda x: x["rerank_score"], reverse=True)
        
        # Return top_k
        return documents[:top_k]
    
    def _load_reranker_model(self):
        """
        Load cross-encoder model
        """
        from sentence_transformers import CrossEncoder
        
        reranker = CrossEncoder(self.model_name)
        return reranker
```

---

## 16. Memory Index Optimization (OpenClaw v2026.7.1+)

### 16.1. Overview

**Memory Index Optimization** — rebuildable index work separate từ conversations, cached search results, filtered matches beyond sqlite-vec's first 4,096 candidates [78][79].

**Khac biệt so với current design**:
- **Current**: Mỗi search đều rebuild index từ đầu
- **Optimized**: Index persisted, reuse healthy index, chỉ rebuild khi có changes

**Impact**: 50-70% faster search times cho repeated queries [78][79].

### 16.2. Implementation

```python
class OptimizedMemoryIndex:
    """
    Optimized memory index với rebuildable index và cached search results
    Reference: OpenClaw v2026.7.1+ [78][79]
    """
    
    def __init__(self, config: Dict):
        self.config = config
        self.index_cache = {}
        self.index_health = "unknown"  # healthy, dirty, rebuilding
        self.index_path = config.get("index_path", "./memory_index")
        self.search_results_cache = TTLCache(maxsize=1000, ttl=3600)  # 1 hour TTL
        
        # Load persisted index nếu có
        self._load_index()
    
    def search(self, query: str) -> List[Dict]:
        """
        Search với optimized index
        """
        # Check cache first
        cache_key = f"search:{query}"
        if cache_key in self.search_results_cache:
            return self.search_results_cache[cache_key]
        
        # Check if index healthy
        if self.index_health == "healthy":
            # Reuse persisted index
            results = self._search_cached(query)
        elif self.index_health == "dirty":
            # Trigger background rebuild, but still search
            self._rebuild_index_async()
            results = self._search_dirty(query)
        else:
            # Rebuild index first
            self._rebuild_index()
            results = self._search_cached(query)
        
        # Cache results
        self.search_results_cache[cache_key] = results
        
        return results
    
    def _search_cached(self, query: str) -> List[Dict]:
        """
        Search với persisted index
        """
        # Implement search logic với persisted index
        pass
    
    def _search_dirty(self, query: str) -> List[Dict]:
        """
        Search với dirty index (có¢°§ thể outdated)
        """
        # Implement search logic với dirty index
        pass
    
    def _rebuild_index_async(self):
        """
        Rebuild index trong background thread
        """
        threading.Thread(target=self._rebuild_index).start()
    
    def _rebuild_index(self):
        """
        Rebuild index từ memory files
        """
        self.index_health = "rebuilding"
        
        try:
            # Read all memory files
            memory_files = self._read_memory_files()
            
            # Build index
            self.index_cache = self._build_index(memory_files)
            
            # Persist index to disk
            self._persist_index()
            
            self.index_health = "healthy"
            
        except Exception as e:
            print(f"Index rebuild failed: {e}")
            self.index_health = "dirty"
    
    def _read_memory_files(self) -> List[Dict]:
        """
        Read all memory files
        """
        # Implement memory file reading logic
        pass
    
    def _build_index(self, memory_files: List[Dict]) -> Dict:
        """
        Build index từ memory files
        """
        # Implement index building logic
        pass
    
    def _persist_index(self):
        """
        Persist index to disk
        """
        # Implement index persistence logic
        pass
    
    def _load_index(self):
        """
        Load persisted index từ disk
        """
        try:
            if os.path.exists(self.index_path):
                with open(self.index_path, "rb") as f:
                    self.index_cache = pickle.load(f)
                self.index_health = "healthy"
            else:
                self.index_health = "unknown"
        except Exception as e:
            print(f"Index load failed: {e}")
            self.index_health = "dirty"
```

---

## 17. Graph Search + Vector Search (OpenClaw 2026.4+)

### 17.1. Overview

**Graph Search + Vector Search** — kết hợp **graph search** (navigate known connections) và **vector search** (discover unknown relevant files) [84].

**Khac biệt so với current design**:
- **Current**: Chỉ vector search (semantic similarity)
- **Combined**: Vector search để discover, graph search để navigate relationships

**Use cases**:
- `memory_search("topic")` → Vector search (similarity)
- `graph_search("topic")` → Graph search (structure/relationships)

**Impact**: Better coverage — vector search discovers, graph search navigates [84].

### 17.2. Implementation

```python
class HybridSearch:
    """
    Combine graph search + vector search
    Reference: OpenClaw 2026.4+ [84]
    """
    
    def __init__(self, config: Dict):
        self.config = config
        
        # Vector search: Find files you didn't know were relevant
        self.vector_search = self._init_vector_search()
        
        # Graph search: Navigate files you know are connected
        self.graph_search = self._init_graph_search()
        
        # Weights cho merging
        self.vector_weight = config.get("vector_weight", 0.5)
        self.graph_weight = config.get("graph_weight", 0.5)
    
    def search(self, query: str, top_k: int = 10) -> List[Dict]:
        """
        Combine vector search + graph search
        """
        # Vector search: Find files you didn't know were relevant
        vector_results = self.vector_search.search(query, top_k=5)
        
        # Graph search: Navigate files you know are connected
        graph_results = self.graph_search.search(query, top_k=5)
        
        # Merge và deduplicate
        combined = self._merge_and_deduplicate(vector_results, graph_results)
        
        return combined
    
    def _merge_and_deduplicate(self, vector_results: List[Dict], 
                                graph_results: List[Dict]) -> List[Dict]:
        """
        Merge results từ 2 channels, deduplicate
        """
        # Combine results với weighted scores
        combined_scores = {}
        
        for result in vector_results:
            doc_id = result["id"]
            combined_scores[doc_id] = {
                "result": result,
                "vector_score": result.get("score", 0) * self.vector_weight,
                "graph_score": 0,
            }
        
        for result in graph_results:
            doc_id = result["id"]
            if doc_id in combined_scores:
                combined_scores[doc_id]["graph_score"] = result.get("score", 0) * self.graph_weight
            else:
                combined_scores[doc_id] = {
                    "result": result,
                    "vector_score": 0,
                    "graph_score": result.get("score", 0) * self.graph_weight,
                }
        
        # Calculate combined score
        merged_results = []
        for doc_id, data in combined_scores.items():
            combined_score = data["vector_score"] + data["graph_score"]
            data["result"]["combined_score"] = combined_score
            merged_results.append(data["result"])
        
        # Sort by combined score
        merged_results.sort(key=lambda x: x["combined_score"], reverse=True)
        
        return merged_results
    
    def _init_vector_search(self):
        """
        Initialize vector search engine
        """
        # Implement vector search initialization
        pass
    
    def _init_graph_search(self):
        """
        Initialize graph search engine
        """
        # Implement graph search initialization
        pass
```

---

## 18. Knowledge Graph Memory (Cognee integration)

### 18.1. Overview

**Knowledge Graph Memory** — extract entities và relationships từ memory files, build knowledge graph, expose graph-based search modes (traverse connections thay vì chỉ match vectors) [86].

**Khac biệt so với current design**:
- **Current**: Chỉ flat memory entries (no relationships)
- **Knowledge graph**: Entities + relationships → trả lời questions bằng traversing connections

**Use cases**:
- "Who worked on project X?" → Traverse: project_X → worked_by → [people]
- "What projects use library Y?" → Traverse: library_Y → used_by → [projects]

### 18.2. Implementation

```python
class KnowledgeGraphMemory:
    """
    Knowledge graph memory với entity relationships
    Reference: Cognee integration [86]
    """
    
    def __init__(self, config: Dict):
        self.config = config
        self.graph = self._build_graph_from_memory()
    
    def _build_graph_from_memory(self):
        """
        Build knowledge graph từ memory files
        """
        # Read memory files
        memory_files = self._read_memory_files()
        
        # Extract entities (NER)
        entities = self._extract_entities(memory_files)
        
        # Extract relationships (relation extraction)
        relationships = self._extract_relationships(memory_files)
        
        # Build graph (nodes = entities, edges = relationships)
        graph = self._build_graph(entities, relationships)
        
        return graph
    
    def search(self, query: str) -> List[Dict]:
        """
        Search knowledge graph
        """
        # Parse query để tìm entities
        entities = self._extract_entities_from_query(query)
        
        # Traverse graph từ entities
        results = self._traverse_graph(entities)
        
        return results
    
    def answer_question(self, question: str) -> Optional[str]:
        """
        Answer question bằng traversing graph
        Example: "Who worked on project X?"
        """
        # Parse question để tìm subject và relation
        subject = self._extract_subject(question)  # "project X"
        relation = self._extract_relation(question)  # "worked_by"
        
        # Traverse graph: subject → relation → [objects]
        objects = self._traverse_relation(subject, relation)
        
        # Format answer
        if objects:
            return f"{', '.join(objects)} worked on {subject}"
        else:
            return None
    
    def _read_memory_files(self) -> List[Dict]:
        """
        Read memory files
        """
        # Implement memory file reading logic
        pass
    
    def _extract_entities(self, memory_files: List[Dict]) -> List[Dict]:
        """
        Extract entities từ memory files (NER)
        """
        # Implement NER logic (spaCy, NLTK, hoặc LLM-based)
        pass
    
    def _extract_relationships(self, memory_files: List[Dict]) -> List[Dict]:
        """
        Extract relationships từ memory files (relation extraction)
        """
        # Implement relation extraction logic (spaCy, pattern matching, hoặc LLM-based)
        pass
    
    def _build_graph(self, entities: List[Dict], relationships: List[Dict]):
        """
        Build graph từ entities và relationships
        """
        # Implement graph building logic (NetworkX, Neo4j, hoặc similar)
        pass
    
    def _extract_entities_from_query(self, query: str) -> List[str]:
        """
        Extract entities từ query
        """
        # Implement entity extraction logic
        pass
    
    def _traverse_graph(self, entities: List[str]) -> List[Dict]:
        """
        Traverse graph từ entities
        """
        # Implement graph traversal logic
        pass
    
    def _extract_subject(self, question: str) -> str:
        """
        Extract subject từ question
        Example: "Who worked on project X?" → "project X"
        """
        # Implement subject extraction logic
        pass
    
    def _extract_relation(self, question: str) -> str:
        """
        Extract relation từ question
        Example: "Who worked on project X?" → "worked_by"
        """
        # Implement relation extraction logic
        pass
    
    def _traverse_relation(self, subject: str, relation: str) -> List[str]:
        """
        Traverse graph từ subject qua relation
        Example: project_X → worked_by → [people]
        """
        # Implement relation traversal logic
        pass
```

---

## 19. Implementation Roadmap

### Phase 1 (Tuần 1-2): Foundation — P0

- [ ] **Frozen snapshot**: Load MEMORY.md 1 lần lúc session start, enforce 2,750 char cap
- [ ] **Three-tier memory**: Tach episodic/semantic/skill thành 3 files riêng
- [ ] **Periodic nudge**: Thêm system message nudge mỗi 10 turns
- [ ] **Prefix cache optimization**: Three-tier prompt structure, block alignment

**Impact**: Cao nhất, effort thấp nhất — memory density ≥70%, cache hit rate ≥80%

### Phase 2 (Tuần 3-4): Dreaming + Heartbeat — P0

- [ ] **Dreaming cron job**: Implement 3-phase (light, rem, deep) với APScheduler
- [ ] **Capacity trigger**: Auto-consolidate khi >80% cap
- [ ] **Decay mechanism**: Prune stale entries (>30 days không dùng)
- [ ] **Heartbeat engine**: Autonomous task scheduling, idle detection

**Impact**: Tự động hóa consolidation, memory không phồng theo thời gian

### Phase 2.5 (Tuần 5): Active Memory + Index Optimization — P0

- [ ] **Active Memory Sub-Agent**: Proactive retrieval trước mỗi response
- [ ] **Memory Index Optimization**: Rebuildable index, cached search results

**Impact**: Recall accuracy +10-12%, search latency -50-70%

### Phase 3 (Th
# Hermes Agent – Cơ chế Tự Improve / Tự Nâng cấp của Harness
*Ngày nghiên cứu: 2026-09-11 | Nguồn chính: docs chính thức + GitHub NousResearch/hermes-agent | Phiên bản quan sát: v0.21.1 | Độ tin cậy: Cao (dựa trên docs), Trung bình (suy luận code internals chưa đọc trực tiếp source .py)*

> Hermes Agent (https://hermes-agent.nousresearch.com/) – “The Agent That Grows With You”, “self-improving AI agent built by Nous Research”, MIT License. Tagline chính thức trong docs: *“The only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, and builds a deepening model of who you are across sessions.”*

---

## Executive Summary

Hermes không “tự improve” bằng một mô hình tự huấn luyện weights trong lúc chạy. Nó tự improve ở **tầng harness** bằng **closed learning loop** gồm 5 vòng lặp lồng nhau, tất cả chạy trên cùng một `AIAgent` + SQLite + file system:

1. **Vòng lặp trong-turn (foreground):** Agent tự ghi `MEMORY.md / USER.md` qua tool `memory` và tự tạo/sửa `SKILL.md` qua `skill_manage` khi phát hiện kiến thức tái dùng được. System prompt “nudge” nó làm việc này.
2. **Vòng lặp sau-turn (background review fork):** Sau mỗi turn, harness fork một `AIAgent` nền, replay lại hội thoại (tận dụng prompt cache) để chắt lọc memory + skill mà turn chính bỏ sót. Đây là *trái tim* của self-improve. Chỉ fork này mới được đánh dấu `created_by: agent` → mới thuộc quyền quản lý của Curator.
3. **Vòng lặp bảo trì định kỳ (Curator):** Mỗi 7 ngày + 2h idle, một fork khác rà soát toàn bộ thư viện skill agent-created: `active → stale (30d) → archived (90d)`, đo telemetry `use/view/patch`, tùy chọn LLM-consolidation gộp skill trùng lặp thành umbrella, có backup tar.gz + audit ledger + rollback từng edit.
4. **Vòng lặp recall dài hạn:** FTS5 (`messages_fts` + trigram + CJK) + `session_search` + compression `lean` + Honcho dialectic giúp kiến thức cũ không bị mất khi context bị compact, và user model ngày càng sâu.
5. **Vòng lặp ngoài-harness (evolution/sharing/training):** Skills tuân `agentskills.io`, có Hub/quarantine/scan, project-local skills, bundles/blueprints → cron, trajectory export ShareGPT + batch_runner cho RL với Atropos. Đây là cách harness “tiến hóa” qua cộng đồng và qua training.

Toàn bộ vòng lặp đều **consent-aware + cache-aware + an toàn**: `write_approval` staging, `memory_notifications`, security scan injection, prompt 3-tier `stable → context → volatile` + frozen snapshot để không phá prompt cache, in-place compaction giữ một session id ổn định.

---

## 1. Triết lý và kiến trúc nền đỡ cho self-improve

### 1.1. Định vị

Docs nhấn mạnh Hermes không phải “coding copilot tethered to IDE” hay “chatbot wrapper”. Nó là **autonomous agent sống ở VPS/GPU cluster/serverless (Daytona, Modal), nói chuyện qua 20+ platform (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Email, SMS, Teams…) từ một gateway duy nhất, một memory duy nhất**.

Key features list ghi rõ:

> *“A closed learning loop — Agent-curated memory with periodic nudges, autonomous skill creation, skill self-improvement during use, FTS5 cross-session recall with LLM summarization, and Honcho dialectic user modeling”*

### 1.2. Harness map (để hiểu self-improve cắm vào đâu)

```
Entry: CLI (cli.py) | Gateway (gateway/run.py) | ACP | Batch Runner | API Server
              ↓
AIAgent (run_agent.py facade; loop ở agent/conversation_loop.py + agent/turn_*.py)
 ├── Prompt Builder (prompt_builder.py + system_prompt.py)
 ├── Provider Resolution (runtime_provider.py – 18+ providers, 3 API modes)
 └── Tool Dispatch (model_tools.py + tools/registry.py – ~86 tools, ~28 toolsets)
              ↓
Session Storage (SQLite WAL + FTS5 – hermes_state.py)  +  Tool Backends (Terminal 7 backend, Browser 5, Web 4, MCP dynamic)
```

- **Agent Loop:** `chat()` → `run_conversation()` → build/reuse cached system prompt → preflight compression check (>50%) → build API messages theo 3 mode (`chat_completions` / `codex_responses` / `anthropic_messages`) → inject ephemeral layers → interruptible API call (thread + interrupt event) → nếu tool_calls thì dispatch (single=sync, multi=ThreadPoolExecutor, giữ order) → loop; nếu text thì persist + flush memory.
- **Agent-level tools bị intercept trước registry** (`agent/tool_executor.py`): `todo`, `memory`, `session_search`, `delegate_task`. Nghĩa là memory/skill không phải tool thường – chúng sửa trực tiếp agent state.
- **Design principles quan trọng cho learning:** *Prompt stability* (không mutate system prompt giữa hội thoại trừ `/model`), *Observable execution* (mọi tool call visible), *Profile isolation* (mỗi `-p <name>` có HERMES_HOME/config/memory/sessions riêng), *Loose coupling* (memory provider, context engine cắm qua registry + check_fn).

### 1.3. Prompt Assembly 3-tier – nền cache cho learning

`stable → context → volatile` (xem `agent/system_prompt.py`):

1. **stable:** identity (`SOUL.md` hoặc `DEFAULT_AGENT_IDENTITY`), tool/model guidance, coding brief.
2. **context:** `system_message` caller-supplied, project context files (`.hermes.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`, chỉ 1 loại thắng, security scan + truncate 70/20, YAML frontmatter stripped), worktree git snapshot, operator instructions, platform hints.
3. **volatile:** skills index, frozen `MEMORY.md` snapshot, frozen `USER.md` snapshot, external memory-provider block, timestamp/session/model/provider line, runtime env hints (host/home/cwd).

Thứ tự này cố ý để prefix dài nhất được reuse bởi provider cache. `skills` thuộc stable tier, `memory/profile` thuộc volatile tier nhưng **cả hai vẫn nằm trong cached system prompt, không phải overlay giữa turn**. Mid-session writes chỉ ghi disk, không mutate cached prompt cho tới session mới hoặc rebuild do compression. `pre_llm_call` plugin context thì append vào user message hiện tại, không chạm cached prefix. Đổi platform (desktop ↔ TUI) không đổi bytes prompt mà gửi one-shot note (`agent/surface_switch.py`).

Hệ quả: self-improve có thể ghi liên tục mà không phá cache → rẻ.

---

## 2. Bộ nhớ bền có giới hạn (Bounded Curated Memory) – “bộ não sự thật”

### 2.1. Hai file

| File | Mục đích | Limit |
|------|----------|-------|
| `MEMORY.md` (`~/.hermes/memories/`) | Ghi chú của agent: env facts, conventions, tool quirks, diary task đã xong, techniques hiệu quả | 2.200 chars (~800 tokens) |
| `USER.md` | Hồ sơ user: tên/role/timezone, style giao tiếp, pet peeves, thói quen workflow, level kỹ thuật | 1.375 chars (~500 tokens) |

Cả hai được **inject frozen vào system prompt lúc session start** với header hiển thị capacity:

```
═══ MEMORY (your personal notes) [67% — 1,474/2,200 chars] ═══
User's project is Rust Axum + SQLx at ~/code/myapi § Ubuntu 22.04 Docker+Podman § prefers concise
```

Entries phân tách bằng `§`, cho phép multiline.

### 2.2. Tool `memory` (không có `read`)

- `add`, `replace` (substring `old_text` unique), `remove`. Không có `read` vì đã auto-inject.
- Substring matching: chỉ cần đoạn unique, nếu match nhiều entries → lỗi yêu cầu cụ thể hơn.
- **Không auto-compact:** write vượt limit → trả lỗi kèm `current_entries` + `usage`, bắt agent ngay trong turn đó phải `replace` gộp hoặc `remove` rồi retry `add`. Trên 80% (nhìn header) nên chủ động consolidate. Ví dụ gộp 3 dòng “project uses X” thành 1 entry tổng hợp.
- Duplicate prevention: reject exact duplicate (trả success “no duplicate added”).
- Security scanning trước accept: chặn prompt injection, exfiltration credentials, SSH backdoor, invisible Unicode – vì entries sẽ thành system prompt.

### 2.3. Save gì / Skip gì (proactive)

Agent **tự save, user không cần nhắc**: preference → `user`; env facts, corrections (“Don't use sudo for Docker”), conventions (tabs, 120-col, Google docstrings), completed work + date, explicit “remember …” → `memory`. Skip: vague (“User asked about Python”), dễ search lại, raw dumps/log/code lớn, ephemeral paths, thứ đã có trong SOUL.md/AGENTS.md.

Ví dụ tốt: `“Staging 10.0.1.50 SSH port 2222, key ~/.ssh/staging_ed25519”`, `“~/code/api Go 1.22 sqlc chi router, test via make test”`. Ví dụ xấu: `“User has a project”` hoặc entry verbose kể lể ngày tháng.

### 2.4. Cấu hình

```yaml
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
  write_approval: false  # true = staging cần duyệt
```

Tắt cả hai → tool `memory` biến khỏi schema + guidance biến khỏi prompt. Tắt một → schema chỉ advertise target còn lại. `agent.disabled_toolsets: [memory]` là switch nặng hơn (ẩn cả provider ngoài). Đừng chạy 2 process cùng HERMES_HOME – hai writer sẽ compound entries của nhau.

### 2.5. Journey / Star Map – nhìn và sửa cái đã học

Timeline `skills + memory chunks` (cũ trên, mới dưới) + scrubber “constellation” replay:

- CLI: `hermes journey` (`learning`, `memory-graph`), flags `--play --fps --width --height --no-color --json`
- TUI/Desktop: `/journey` overlay / Star Map panel
- Prune: `journey list` (ids `skill-name` và `memory:<source>:<index>`), `delete <node> [-y]` (skill → archive restorable, memory → remove), `edit <node>` mở `$EDITOR`.

---

## 3. Background Self-Improvement Review Fork – trái tim tự nâng cấp

### 3.1. Ý tưởng

Sau mỗi turn, harness **fork một AIAgent nền** (same pattern như Curator) chạy trong prompt cache riêng, không chạm conversation đang active. Fork replay lại hội thoại để tìm:

- Corrections lặp lại, workflow lessons bền vững → compact memory entries hoặc procedural skills.
- Skill hiện có đã lỗi thời → đề xuất patch.
- Vấn đề mới giải được bằng cách novel → tạo umbrella skill mới.

Docs memory ghi: *“After a turn, the background self-improvement review may quietly save a memory or update a skill. This is Hermes' consent-aware learning loop…”* + *“including from the background self-improvement review that runs after a turn”*.

Curator docs xác nhận: *“Currently, only the background self-improvement review fork sets this marker — when it creates a new umbrella skill during its periodic review pass (~every 10 agent turns).”*

Nudge intervals điều tần suất: `memory.nudge_interval` / `skills.creation_nudge_interval` (giảm nudge = giảm work khi không muốn đổi effort của main model).

Manual trigger: `/refine` luôn chạy ngay lập tức dù `enabled: false`.

### 3.2. Tại sao replay mà vẫn rẻ? Warm cache vs digest

- **Mặc định chạy trên main chat model, replay full transcript:** vì conversation đã warm trong prompt cache → chỉ tốn cache reads rẻ.
- **Nếu route sang model rẻ hơn (`auxiliary.background_review.provider/model`):** không reuse được cache của main → fork tự động replay **digest gọn** (recent turns verbatim + summary older ones) thay vì full transcript để giảm cache writes mới. Benchmark ghi giảm ~3–5× cost, memory capture identical, skill capture near-identical.

```yaml
auxiliary:
  background_review:
    provider: openrouter
    model: google/gemini-3-flash-preview  # auto = main chat model
    enabled: true   # false = tắt auto fork, /refine vẫn chạy
    extra_tools: [propose_shared_memory]  # whitelist hẹp, tool phải có ở parent
    defer: auto     # auto | never (local llama-server thì queue tới idle)
    defer_max_age_s: 1800
```

- **Same-model reasoning inheritance:** review cùng model luôn kế thừa `reasoning_effort` của parent, set `auxiliary.background_review.reasoning_effort` không có tác dụng (để giữ byte-identical system prompt/tool defs/reasoning settings/conversation snapshot cho cache reuse). Muốn nhẹ hơn: giảm nudge intervals, tắt auto, hoặc route sang model khác. Bug task-effort cho different-model route tracked #94825.
- **Local GPU defer:** khi runtime là managed local `llama-server`, fork chiếm GPU làm prompt tiếp theo bị cancel → mất learning. `defer: auto` queue review tới khi máy quiet (settle window), coalesce per session (snapshot mới thay cũ vì replay cả conversation nên không mất gì), preempted thì re-queue không discard, quá `defer_max_age_s` thì chạy dù không idle. Queue in-memory, thoát app là mất như in-flight fork. `/refine` luôn immediate.
- **Whitelist tools:** mặc định review chỉ dùng memory, skill-management, read-only file tools. `extra_tools` chỉ opt-in thêm tool đã có ở parent, ưu tiên tool stage proposal hơn apply destructive.
- **Observability:** usage persist vào `session_model_usage` với `task='background_review'` + dòng `Background review complete: thread=bg-review calls=… in=… out=… result=…` trong `agent.log`. Chat notification điều bởi `display.memory_notifications` (xem 3.3), không ảnh hưởng writes.

### 3.3. Consent & visibility

| `memory.write_approval` | Foreground | Background review |
|---|---|---|
| `false` (default) | Write freely | Write freely |
| `true` | Prompt inline (entries nhỏ đọc được) | **Staged**, duyệt qua `/memory pending / approve <id\|all> / reject / approval on\|off` |

Skills tương tự nhưng diff quá lớn không đọc trong chat bubble:

```yaml
skills:
  write_approval: false
```
Khi `true`: mọi skill writes (create/edit/patch/write_file/delete) đều stage → `/skills pending` (one-line gist) → `/skills diff <id>` (full unified diff, xem ở CLI/dashboard/`~/.hermes/pending/skills/<id>.json`) → approve/reject.

```yaml
display:
  memory_notifications: on  # off | on (default) | verbose
```
- `off`: vẫn chạy+vẫn ghi, chỉ không hiện dòng chat.
- `on`: `💾 Memory updated`, `💾 Skill 'foo' patched`.
- `verbose`: kèm preview (`💾 Memory ➕ User prefers terse replies`, snippet `"old" → "new"`). Batch thành công liệt kê từng op (kể cả supporting files), staged/rolled-back không báo completed. Set per-platform via `display.platforms.<platform>.memory_notifications`.

Đây là câu trả lời cho “agent saved wrong assumption”: bật `write_approval: true`, mọi save nền đều chờ yes/no.

---

## 4. Skills – Procedural Memory tự tạo và tự cải tiến khi dùng

### 4.1. Progressive disclosure (tiết kiệm token)

```
Level 0: skills_list() → [{name, description, category}] (~3k tokens)
Level 1: skill_view(name) → full SKILL.md + metadata
Level 2: skill_view(name, path) → reference file cụ thể
```

Agent chỉ load full khi cần. Mọi skill installed đều thành slash command (`/gif-search`, `/axolotl`, `/github-pr-workflow`), stack tối đa 5 (`/skillA /skillB fix #123`), `/plan [request]` nay là built-in lưu dưới `.hermes/plans/`.

### 4.2. SKILL.md + directory

`~/.hermes/skills/` là source of truth (fresh install copy từ repo, hub + agent-created cũng về đây, agent có thể sửa/xóa). Cấu trúc: `category/skill-name/SKILL.md + references/ + templates/ + scripts/ + examples/ + assets/`, `.hub/lock.json` (source URL, hash, scanner version, findings), `.bundled_manifest`, `.usage.json` (telemetry cho Curator).

Frontmatter:

```yaml
name: my-skill
description: ≤60 chars
version: 1.0.0
platforms: [macos, linux]  # ẩn khỏi prompt/list/slash nếu OS không match
metadata:
  hermes:
    tags: [python, automation]
    category: devops
    fallback_for_toolsets: [web]   # chỉ hiện khi toolsets này VẮNG
    requires_toolsets: [terminal]  # chỉ hiện khi toolsets này CÓ
    fallback_for_tools / requires_tools: tương tự per-tool
    config: [{key, description, default, prompt}]  # non-secret → skills.config trong config.yaml, inject vào context khi load
    blueprint: {schedule, deliver, prompt, no_agent}  # skill cũng là automation
required_environment_variables: [{name, prompt, help, required_for}]  # secrets → .env, auto passthrough vào execute_code/terminal sandboxes, CLI hỏi secure khi load, messaging không hỏi trong chat
required_credential_files: [{path relative ~/.hermes, description}]  # OAuth files → mount Docker read-only, sync Modal
```

Body chuẩn: `When to Use / Procedure / Pitfalls / Verification` (+ Quick Reference). Hỗ trợ `${HERMES_SKILL_DIR}`, `${HERMES_SESSION_ID}` substitution, inline shell `` !`cmd` `` opt-in (`skills.inline_shell: true`, timeout 10s, cwd=skill dir, cap 4000 chars), `[[as_document]]` ép gateway gửi media thành file attachment (tránh Telegram recompress), `[[audio_as_voice]]` thành voice bubble.

### 4.3. Agent-managed skills (`skill_manage` tool)

Actions: `create` (full SKILL.md), `patch`/`edit`/`write_file`/`remove_file`/`delete`. New skills → `~/.hermes/skills/` (hoặc `skills.create_dir` nếu redirect sang shared brain/git repo/fleet volume – instructions trong tool description render dynamic theo config). Existing → sửa tại chỗ (kể cả `external_dirs` nếu writable – không phải write-protection boundary, muốn read-only phải dùng FS permissions).

Điều kiện hiện: `requires_*` / `fallback_*` quyết định skill có vào index/prompt không. Ví dụ `duckduckgo-search` có `fallback_for_toolsets: [web]` → ẩn khi đã có `FIRECRAWL_API_KEY`.

`/learn <anything>`: biến bất kỳ nguồn nào (SDK dir, URL docs, workflow vừa làm, pasted notes, cả cuốn sách) thành skill chuẩn house (agent tự gather bằng read_file/search_files/web_extract rồi `skill_manage` save → chịu `write_approval` gate). Nguồn lớn → knowledge-base skill: SKILL.md lean (mental models + index) + mỗi chapter một file `references/`, load on-demand qua `skill_view` nên cost ∝ answer không ∝ source. Re-run `/learn` cùng topic thì fold vào skill cũ không duplicate. Không có model-tool footprint (chỉ là prompt + normal turn).

### 4.4. Vòng đời mở rộng: external / project-local / bundles / blueprints

- **External dirs:** `skills.external_dirs: [~/.agents/skills, /shared/team-skills]` (`~` + `${VAR}` expansion, missing → skip). Local thắng external khi trùng tên. Đều vào index/list/view/slash.
- **Project-local:** `<git-root>/.hermes/skills/` + `.agents/skills/`, precedence `project → local → external`, tag `[project]`. Không auto-load từ repo lạ: lần đầu banner `run hermes skills trust`, lưu `skills.trusted_project_dirs`, `project_discovery: false` để tắt. Mỗi project skill scan security trước khi vào index (dangerous → quarantine, hash-cache ở `~/.hermes/cache/project_skill_scans/`). Cron/API/ACP kế thừa trust, resolve root từ `workdir`, không prompt/auto-trust. Curator không bao giờ sửa project skills, skill mới luôn về `~/.hermes/skills/`.
- **Bundles:** YAML gom nhiều skills thành một slash (`hermes bundles create backend-dev --skill …`).
- **Blueprints:** skill có `blueprint.schedule` → automation shareable, install chỉ tạo *suggested cron* (opt-in qua `/suggestions accept/dismiss`), không silent schedule. Export ngược cron → SKILL.md → publish.
- **Opt-out bundled:** `--no-skills` lúc install/profile create, hoặc `hermes skills opt-out [--remove]` (chỉ xóa bundled byte-identical, giữ edited/hub/self-made), marker `.no-bundled-skills`.

---

## 5. Curator – bảo trì nền chống phình thư viện skill

### 5.1. Vì sao cần

> *“It exists so that skills created via the self-improvement loop don't pile up forever… Without maintenance, you end up with dozens of narrow near-duplicates that pollute the catalog and waste tokens.”*

Mặc định `prune_builtins: true` → cả bundled built-ins không dùng sau `archive_after_days` cũng bị archive (hub skills luôn exempt). Không bao giờ auto-delete – worst case là move vào `~/.hermes/skills/.archive/` recoverable. Track issue #7816.

### 5.2. Cách chạy

Không phải cron mà **inactivity check**: CLI start, gateway housekeeping, Desktop/`hermes serve` maintenance timer (hourly, first poll 90s) kiểm tra `interval_hours` (168h=7d) đã qua + `min_idle_hours` (2h) idle (đo từ startup + recent chat activity, giữ timestamp sau close/reap, skip khi turn đang chạy, connected-inactive không block). Chạy trong worker thread, đóng backend không interrupt. Nhiều serve cùng profile có thể race interval check.

First-run: chỉ seed `last_run_at=now`, defer pass thật một interval để user kịp review/pin/opt-out. Preview: `hermes curator run --dry-run`.

Fork `AIAgent` nền, cache riêng, không chạm conversation active.

### 5.3. Hai phase

1. **Auto-transitions deterministic (luôn on, free):** `active → stale` sau `stale_after_days:30`, `→ archived` sau `archive_after_days:90` (move `.archive/`). Bỏ qua pinned + skills được cron job reference (kể cả paused/disabled, consolidation còn rewrite cron refs khi merge umbrella). Never-used (`use_count==0`) có grace floor: không archive tới khi đủ `stale_after_days` tuổi.
2. **LLM consolidation (opt-in, 50–100 API calls/sweep):** khi `curator.consolidate: true` (hoặc `run --consolidate`), fork survey agent-created skills, `skill_view` bất kỳ, quyết keep/patch (`skill_manage`)/consolidate thành umbrella class-level/archive via terminal. Coi skill là full package: nếu có `references/templates/scripts/assets` hoặc relative links → phải keep standalone, re-home + rewrite paths, hoặc archive cả package – không flatten chỉ SKILL.md.

```yaml
curator:
  enabled: true
  interval_hours: 168
  min_idle_hours: 2
  stale_after_days: 30
  archive_after_days: 90
  consolidate: false
  prune_builtins: true
  backup: {enabled: true, keep: 5}
  archive_ttl_days: 0  # 0=never purge, purge luôn explicit + ledgered
auxiliary:
  curator: {provider: openrouter, model: google/gemini-3-flash-preview, timeout: 600}
```

Legacy `curator.auxiliary` vẫn chạy nhưng log deprecation – migrate sang `auxiliary.curator` để dùng chung `hermes model`/dashboard Models tab.

### 5.4. “Agent-created” nghĩa là gì? Adopt & Pin

Chỉ managed khi **đồng thời**: không trong `.bundled_manifest`, không trong `.hub/lock.json`, và `.usage.json` có `"created_by":"agent"` (hoặc `agent_created:true`). **Hiện chỉ background_review fork (origin `background_review` via `tools/skill_provenance.py` → `mark_agent_created()`) mới set marker khi tạo umbrella (~mỗi 10 turns).** Foreground `skill_manage(create)` theo yêu cầu user → coi là user-directed, Curator bỏ qua. Hand-written/external → `created_by:null` → bỏ qua. `hermes curator status` cho biết counts; nếu agent-created=0 thì LLM pass skip (`Model: (not resolved)`, `Duration:0s` – không phải lỗi).

- `list-unmanaged` phân loại `pre-dates marker` (không thể biết authorship) vs `foreground-created`; `adopt <name> | --all-unmanaged [--dry-run] [--yes]` ghi cùng marker (không reset `last_activity_at` – adopt skill idle lâu sẽ stale/archive ngay pass tới, đúng ý định). Adopt cũng unblock autonomous patch: review fork từ chối patch skill không managed mà chỉ recommend adoption. Từ chối bundled/hub/external/protected. Nhấn mạnh: *“created_by is policy flag, not provenance claim… Provenance is declared, never inferred”* – không heuristic auto-adopt vì telemetry patch nhiều chỉ chứng minh maintain không chứng minh authored.
- `pin <skill>`: skip auto-transitions + LLM được dặn leave alone + `skill_manage(delete)` bị refuse (patch/edit vẫn qua để cải tiến content không cần unpin). Chỉ pin được agent-created; cron-referenced được bảo vệ auto-transitions tương tự nhưng không block delete (nên pin explicit nếu cần). Protected built-ins (hiện rỗng, `plan` đã graduate thành built-in command) filter khỏi candidate list. Pin lưu `"pinned":true` trong `.usage.json`.

### 5.5. Telemetry, reports, backups, ledger, purge

- **`.usage.json` per skill:** `{use_count (load vào prompt), view_count (skill_view), patch_count, last_used/viewed/patched_at, created_at, state, pinned, archived_at}`. Bundled/hub excluded khỏi writes. `status` còn liệt kê LRU top5/bottom5 để đoán stale tiếp theo.
- **`~/.hermes/logs/curator/<ts>/run.json + REPORT.md`:** stats, LLM output, transitions, patches, rename map `old→new` khi merge umbrella.
- **Backups:** trước mỗi real pass snapshot tar.gz `~/.hermes/skills/.curator_backups/<utc-iso>/skills.tar.gz` (+ manifest reason/size). `backup|rollback [--list|--id <ts>|-y]` (rollback lấy snapshot pre-rollback nên undo được cả rollback nhầm). Manual `backup --reason`.
- **Ledger:** `~/.hermes/skills/.curator_ledger.jsonl` append-only, mọi mutation (curator/agent/user): actor/action/evidence (`absorbed_into`, session id)/before-after `{path,sha256}` content-addressed dedup ở `~/.hermes/.curator_backups/blobs/`. `ledger [--skill --limit]` + `rollback <entry-id>` restore đúng files mutation đó (fail closed nếu safety capture fail). Ledger là telemetry không phải gate (ghi fail vẫn cho mutation qua). Tắt via `skills.ledger:false`.
- **Purge:** `archive_ttl_days:180` + `purge [--days --dry-run]` (explicit only, ledgered+blobbed trước xóa nên vẫn recoverable/auditable).
- CLI/`/curator` slash đầy đủ: `status/run[--consolidate|--background|--dry-run]/backup/rollback/pause/resume/pin/unpin/adopt/list-unmanaged/restore/list-archived/archive/prune/ledger/purge`.

---

## 6. Nudges – lời nhắc tự persist trong system prompt

System prompt chứa guidance blocks (tool-aware behavior): *“Task-learned procedures… belong in skills. Memory is narrow exception for facts that apply to EVERY session…”*, *“When user references past conversation… use session_search…”*, cộng skill-writing instructions chỉ hiện khi `skill_manage` available (vắng không nới scope memory). `memory.nudge_interval` và `skills.creation_nudge_interval` điều tần suất các nudge/review này xuất hiện – giảm chúng là cách giảm review work mà không đổi reasoning effort (vì same-model review không cho override effort để giữ cache parity).

---

## 7. Recall & Continuity – FTS5, compression lean, session lineage

- **Session Storage:** `~/.hermes/state.db` WAL (1 writer + N readers, timeout 1s + retry jitter 20–150ms×15 + BEGIN IMMEDIATE + checkpoint 50 writes), tables `sessions/messages/session_model_usage/messages_fts(+trigram+CJK)/state_meta/gateway_routing/compression_locks/async_delegations/delivery_obligations/schema_version (v23, declarative _reconcile_columns + version-gated migrations)`. Cron/subagent rows bị loại khỏi trigram shadow (~2.6×) nhưng vẫn ở `messages` + standard FTS nên `session_search` vẫn thấy. Profile isolation mỗi `$HERMES_HOME/state.db`.
- **`session_search` tool (free, no LLM, ~20ms FTS5 + ~1ms scroll):** 4 shapes discovery (`query`) / scroll (`session_id+around_message_id`) / read (`session_id`) / browse; hỗ trợ FTS5 syntax (`"exact"`, `OR/NOT`, `prefix*`, sanitize quotes/hyphens/dangling ops), filter `source/role`, snippet `>>>match<<<` + 1 msg context. `hermes sessions list`. So sánh: Memory ~1.300 tokens fixed/session cho facts luôn cần; Session search unlimited, on-demand cho “did we discuss X last week?”.
- **Dual compression:** Gateway hygiene 85% (pre-agent, rough est → usage anchor → real tokens, `len>=4`) + Agent ContextCompressor 50% (in-loop, real tokens). Usage anchor (`agent/usage_anchor.py`) fingerprint priced transcript, persist trên session row nên survive restart/resume; whole-context rough est quá threshold thì wait 1 request lấy provider evidence; failure cooldown 60→300→900s (manual `/compress` force clear, provider-proven overflow bypass 1 bounded attempt). Config `threshold/target_ratio/tail_mode lean|legacy/protect_last_n 20/min_tail_user_messages 1/protect_first_n 3/idle_compact_after_seconds/model_thresholds substring longest-win + small-context floor 0.75/codex_gpt55_autoraise 85%/codex_app_server_auto native|hermes|off/codex_responses_native opt-in gpt-5.6/in_place true`.
  - **Lean (default):** tail 2.5% window (10K–25K clamp) + summary identifier-preserving + anchor index regex (PR/SHA/paths/errors, never paraphrased) + verbatim user msgs newest-first + `session_search` pointer; oversized regions sampled với elision markers; 1 aux LLM call/attempt; old tool results trong tail demote thành one-line stubs + pointer. Kết quả 500K real sessions: ~49K retained vs ~162K legacy, recall cao hơn khi kèm recovery. Summary budget `content×0.20` (min 2K, max `min(ctx×0.05,12K)`), template Goal/Constraints/Progress Done|In Progress|Blocked/Decisions/Files/Next/Critical, iterative update previous summary, prune old tool results >200 chars trước, align boundaries không split tool groups, sanitize orphan pairs.
  - **In-place:** rewrite live list cùng session id, pre-compaction turns soft-archive (`active=0,compacted=1`) vẫn searchable/recoverable, event `session:compress {in_place, old_session_id}` – hết bug rotation (mất `/goal`, orphan, search gaps).
  - **Prompt caching Anthropic `system_and_3` (max 4 breakpoints):** sys + 3 msgs cuối rolling, `cache_control: {type:ephemeral[,ttl:1h]}` handle string/list/None/tool msgs, TTL `5m|1h`, mid-conversation model/fallback/credential-pool rotation → zero hits (inherent). Không intermediate pressure warnings (làm model give up sớm).

---

## 8. User Modeling sâu – Honcho + 7 provider ngoài

Built-in memory luôn on + **tối đa 1 external provider** (`hermes memory setup/status/off`, `memory.provider`, `hermes plugins`): Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory. Flow chung: inject provider context vào prompt + prefetch background non-blocking trước turn + sync turns sau response + extract lúc session end + mirror built-in writes + provider tools.

**Honcho (plastic-labs, AI-native, dialectic):**

- Hai lớp inject mỗi turn (`hybrid`/`context`): **Base** (session summary + user representation + peer cards + AI self/identity, refresh `contextCadence:1`) + **Dialectic supplement** (LLM synthesis current needs, refresh `dialecticCadence:2`, cap `dialecticMaxChars:600`, budget `contextTokens`). Cold (no base → “Who is this person?”) vs Warm (có base → session-scoped) auto-select. Prewarm background full depth ở session init (turn1 fallback sync bounded timeout nếu chưa về). Query-adaptive reasoning (+1 ≥120 chars, +2 ≥400, cap `reasoningLevelCap:high`, tắt via `reasoningHeuristic:false`).
- Ba núm trực giao: `contextCadence` (API freq) / `dialecticCadence` (LLM freq 1–5) / `dialecticDepth` 1–3 (pass0 cold/warm, pass1 self-audit gaps, pass2 reconcile contradictions; proportional levels, override `dialecticDepthLevels`, bail early nếu signal mạnh).
- Tools (5): `honcho_profile` (card), `honcho_search` (raw excerpts), `honcho_context` (summary+rep+card+msgs), `honcho_reasoning` (`reasoning_level` minimal→max, `dialecticDynamic:true` cho model override), `honcho_conclude` (PII only).
- Observation: `directional` (4 flags on, mutual) vs `unified` (AI chỉ observe user) + override per-peer `observation.{user,ai}.{observeMe,observeOthers}`; server toggles thắng local.
- Session strategy `per-directory|per-repo|per-session|global`; recall `hybrid|context|tools`; write `async|turn|session|N`; `saveMessages`, `messageMaxChars 25000`, `dialecticMaxInputChars 10000`; gateway identity `pinUserPeer/userPeerAliases/runtimePeerPrefix` (+ `a2aSessions:true` tách bot DMs, `honcho_conclude/profile` refuse khi bot turn chạy); multi-peer workspace (user peer shared, AI peer per profile `hermes.<profile>`, `hermes profile create --clone`, `hermes honcho sync` backfill); config `$HERMES_HOME/honcho.json > ~/.hermes/honcho.json > ~/.honcho/config.json`.

Các provider khác (ngắn gọn): OpenViking (Volcengine, FS hierarchy `viking://`, tiered L0 100tok→L1 2k→L2 full, auto-extract 6 cats, 6 tools), Mem0 (LLM extract+dedupe+rerank, modes platform/self-hosted-dashboard/OSS, 4 tools, `sync_max_chars 450`), Hindsight (KG+entity+`reflect` synthesis, retain full turns incl tools, 3 tools), Holographic (local SQLite FTS5+trust+HRR, 9-action `fact_store` + `fact_feedback`), RetainDB/ByteRover/Supermemory (xem Memory Providers guide).

---

## 9. Tiến hóa ngoài-runtime: sharing + training

- **Open standard `agentskills.io`, portable/shareable, Skills Hub:** third-party URL/GitHub installs chỉ copy SKILL.md + files được reference, scan quarantine + `lock.json` (URL/hash/scanner/findings/timestamp), optional NVIDIA SkillEvaluator Tier1 advisory (PII/unicode-smuggling/lint/license/SkillSpector, highlight credentials đỏ, không block; `skills.tier1_advisory:false` để tắt).
- **Batch + Trajectory:** `batch_runner.py` chạy hàng trăm/ngàn prompts song song → ShareGPT trajectories cho training/eval; cron jobs fresh AIAgent (no history) + attached skills/scripts → deliver mọi platform; `cron` là first-class agent tasks không phải shell.
- **Research-ready RL:** docs ghi *“Batch processing, trajectory export, RL training with Atropos. Built by Nous Research — lab behind Hermes, Nomos, Psyche models”*. Đây là outer loop: harness thu trajectories → train models Hermes/Nomos/Psyche tốt hơn → harness chạy tốt hơn.
- **Delegation & Programmatic:** `delegate_task` (isolated convo/terminal/toolset, default 3 concurrent, subagents budgets 50 vs parent 500, total có thể vượt parent cap) + `execute_code` (Python RPC collapse multi-step thành 1 inference, zero-context-cost pipelines) + 7 terminal backends (local/docker/ssh/daytona/singularity/modal/vercel) + container hardening + Tool Gateway (Portal bundle search/image/TTS/browser) + MCP (`mcp__<server>__`, filtering/sampling) + ACP (VS Code/Zed/JetBrains) + API Server OpenAI-compatible.

---

## 10. An toàn, governance và giới hạn

- Prompt stability + frozen snapshots + in-place compaction + `platform:` không phải identity field (surface switch gửi one-shot user-msg note giữ prefix).
- Write gates (`memory/skills.write_approval`), staging CLIs, per-platform notifications, curator pin/adopt/quarantine/ledger/backups/TTL, project trust + scan-time quarantine, env/credential passthrough có kiểm soát, sudo/approval callbacks, sandbox 7 backends + read-only root/drop caps/PID limits/namespace isolation.
- Giới hạn: memory ~1.3k tokens (không thay deep KB – dùng providers/session_search), background fork tốn tokens (tắt via `auxiliary.background_review.enabled:false` hoặc defer/cheaper model), curator prune-only default (consolidation tốn 50–100 calls), same-model không giảm effort độc lập, model/credential switch mất cache, local GPU cần defer, 2 writers cùng HOME gây compound, summary model phải ≥ main ctx nếu không sẽ drop middle không summary.

---

## 11. So sánh nhanh (để đặt Hermes vào bản đồ)

| Harness | Self-improve tương đương | Khác Hermes |
|---|---|---|
| Claude Code / Cursor | CLAUDE.md, memory, skills, hooks | Không có background review fork + curator lifecycle + Honcho dialectic built-in mạnh như Hermes |
| OpenAI GPTs / Assistants | Instructions + files + memory | Memory đóng, không có skill filesystem + curator + FTS5 local + trajectory RL mở |
| LangChain/LangGraph, AutoGPT, CrewAI | Custom memory/vector + loops | Phải tự code loop bảo trì; Hermes cho sẵn closed loop + CLI/gateway/cron/ACP |
| MemGPT/Letta | Tiered memory, archival recall | Hermes thêm procedural skills + curator + journey Star Map + 8 providers |

---

## Key Takeaways (hành động)

- Muốn Hermes “càng dùng càng khôn”: để mặc định on (memory+review+curator prune), nói corrections rõ ràng, dùng `/learn` sau workflow mới, pin skill quan trọng, thỉnh thoảng `journey` prune.
- Muốn rẻ: `auxiliary.background_review → gemini-flash`, `auxiliary.curator` tương tự, giữ `curator.consolidate:false`, `display.memory_notifications:off`, per-model `compression.thresholds`.
- Muốn kiểm soát: `memory/skills.write_approval:true`, review `/memory pending` + `/skills pending/diff`, `skills.create_dir` về git repo để review diff, `archive_ttl_days` + `purge --dry-run`.
- Muốn deep user model: bật Honcho `hybrid`, `dialecticDepth:2`, `contextTokens:1200`, `sessionStrategy:per-directory`.
- Muốn fleet/brain chung: `skills.create_dir:/opt/brain/skills` + `external_dirs` + project skills `trust` + blueprint → cron → publish.

---

## Sources (đã fetch full-text via web_fetch – web_search endpoint lỗi nên không dùng snippets)

1. Homepage – https://hermes-agent.nousresearch.com/ — tagline Agent That Grows With You, 6 pillars Lives/Memory/Automation/Delegate/Search/Sandbox
2. Docs index – https://hermes-agent.nousresearch.com/docs — định nghĩa self-improving + closed learning loop
3. Architecture – https://hermes-agent.nousresearch.com/docs/developer-guide/architecture — AIAgent map, data flows, principles
4. Agent Loop – https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop — turn lifecycle, 3 API modes, tool exec, budgets
5. Prompt Assembly – https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly — 3-tier stable/context/volatile, SOUL, context files, ephemeral layers
6. Context Compression & Caching – https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching — dual compression, lean algorithm, prompt caching system_and_3
7. Session Storage – https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage — SQLite WAL, FTS5, schema v23, lineage
8. Persistent Memory – https://hermes-agent.nousresearch.com/docs/user-guide/features/memory — MEMORY/USER limits, frozen snapshot, background review, write_approval, auxiliary.background_review
9. Skills System – https://hermes-agent.nousresearch.com/docs/user-guide/features/skills — progressive disclosure, SKILL.md, /learn, external/project/bundles, create_dir
10. Curator – https://hermes-agent.nousresearch.com/docs/user-guide/features/curator — lifecycle, consolidate, telemetry, ledger/backups/purge, adopt/pin
11. Creating Skills – https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills — skill vs tool, frontmatter, secure setup, blueprints
12. Tools & Toolsets – https://hermes-agent.nousresearch.com/docs/user-guide/features/tools — registry categories, terminal 7 backends, background processes
13. Built-in Tools Reference – https://hermes-agent.nousresearch.com/docs/reference/tools-reference — ~86 tools incl memory/session_search/skill_* /delegate/execute_code
14. Features Overview – https://hermes-agent.nousresearch.com/docs/user-guide/features/overview — core/automation/media/integrations map
15. Memory Providers – https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers — 8 providers, Honcho/OpenViking/Mem0/Hindsight…
16. Honcho Memory – https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho — two-layer injection, cadences, depth, observation, gateway mapping
17. GitHub – https://github.com/NousResearch/hermes-agent — MIT, Python, ~25k tests/~1250 files (truncated fetch, chỉ lấy header)

## Methodology

- Sub-questions: (1) Harness tổng thể là gì? (2) Vòng lặp tự improve gồm những loop nào? (3) Background review fork chạy thế nào? (4) Skills tự tạo/cải tiến + Curator ra sao? (5) Recall/user-modeling + training outer loop?
- Searched 3 queries via web_search (lỗi endpoint OpenRouter, không trả kết quả) → chuyển sang fetch trực tiếp 17 URLs docs (full-text, không dựa snippets).
- Deep-read 8 key sources (memory, skills, curator, architecture, prompt-assembly, agent-loop, honcho, compression).
- Mọi claim đều có inline source; suy luận code (file .py) gắn confidence trung bình; gaps: chưa đọc source .py trực tiếp, chưa đo cost thực tế, giá trị default nudge_interval chi tiết chưa fetch được ngoài “~every 10 turns”.

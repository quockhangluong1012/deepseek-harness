# Review Evolutionary Harness — thực thi specs/evolutionary-harness-prompt-v6.md

- Ngày: 2026-09-13
- Nguồn: đọc trực tiếp mã nguồn thật (không đoán) — `packages/evolution/*`, `packages/context/evolution-memory-context`, `packages/core/system-prompt`, `packages/core/agent-loop`, `packages/llm/*`, `packages/skill/evolution-*`, `packages/guard/budgets`; cộng ba tài liệu đã có sẵn trong repo: `specs/evolutionary-harness.spec.md` (behaviour contract), `specs/improvement.spec.md` (ledger implemented-vs-planned theo phase), `specs/hermes-self-improve-research.md` (nghiên cứu Hermes có sẵn — không re-research), và `research/notes/final_report_evolutionary-harness-dsh-cf2785.md` (hyperresearch report đã chạy trước, trích dẫn file:line dày đặc).
- Phạm vi: chỉ **review + thiết kế đề xuất**, chưa sửa code. Theo đúng khuôn của `docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md` (review → batch plan P0-P4 → mỗi batch một commit riêng, TDD per-finding), batch thực thi là bước tiếp theo sau khi tài liệu này được duyệt.
- Quy tắc trích dẫn: mọi khẳng định kèm `path:line`; chỗ không đọc được mã nguồn thật thì đánh dấu `[THIẾU CONTEXT]` hoặc `[CẦN XÁC MINH]` thay vì đoán.

## Bối cảnh kỹ thuật (điền từ mã nguồn, không đoán)

| Mục | Giá trị | Nguồn |
|---|---|---|
| Tech stack | TypeScript monorepo, pnpm workspaces, framework plugin **Cordis** ("all-plugin agent harness"), ESM toàn bộ, Node `^22.19 \|\| >=24` | `AGENTS.md:15,65,109` |
| LLM chính | **DeepSeek official API**, adapter `@deepseek-ai/dsh-llm-deepseek`. Cache tự động phía server — không cần app gửi `cache_control`; wire trả `prompt_cache_hit_tokens`/`prompt_tokens_details.cached_tokens`, map vào `TokenUsage.cacheReadTokens` | `packages/llm/llm-deepseek/src/translate.ts:48-73`, `types.ts:162-176` |
| LLM phụ | `@deepseek-ai/dsh-llm-pi-ai` — gateway đa nhà cung cấp (OpenAI-compatible, Anthropic-messages, gateway tự khai). Catalog có cờ `supportsCacheControlOnTools`, `supportsLongCacheRetention` cho endpoint kiểu Anthropic (`cache_control` tường minh, khác cơ chế tự động của DeepSeek) | `packages/llm/llm-pi-ai/src/catalog.ts:100-101,312-316,418-423`, README |
| Định dạng lưu memory | JSON, một file mỗi scope, backend `storage-json`, layout `per-record`: `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json` | `packages/evolution/evolution-memory/src/spec.ts:111-120`, `packages/storage/storage-json/src/per-record-unit.ts:1-57` |
| Quy mô hiện tại | **[THIẾU CONTEXT]** — đây là dev repo, không tìm thấy dump production nào; artifact thật duy nhất là fixture test (`evolution-memory/tests/store.spec.ts`). Giả định bắt buộc dùng: coi mọi ví dụ trong báo cáo này là fixture, không phải telemetry thật. | fork recon (evolution-memory core) |
| Context budget cho memory khi retrieve | `capacityBytes` bản ghi = 131072 (128 KiB); brief tiêm vào model `maxBytes` = 16384 (16 KiB) — cấu hình mặc định composition `web-app` | `research/notes/final_report_evolutionary-harness-dsh-cf2785.md:52` (trích `packages/bundle/web-app/cordis.patch.yml:102-146`) |
| Average session length | **[THIẾU CONTEXT]** — không có rollup "turns/session" nào trong `token-meter` hay `session-telemetry`; chỉ có sự kiện thô `turn/start`/`turn/end` per-session. Giả định bắt buộc dùng: coi phiên trung bình là "không biết", không suy diễn con số. | Grep `packages/session*`, `packages/llm/token-meter/src` |

## 1. Chẩn đoán — Hỏng ở đâu

Phân loại theo 3 trụ cột. Severity: critical / high / medium / low.

### 1.A Memory architecture

**G1 (critical) — biến dung lượng sống nằm trong đúng tier lẽ ra phải bất biến.** Section nhắc `evolution-memory-scope` (order 10051) đăng ký qua `ctx.systemPrompt.section()` và tham chiếu biến `{{evolution_memory_usage}}` — `packages/context/evolution-memory-context/src/sections.ts:12-30`. Section này nằm trong **cùng một system-prompt message** với toàn bộ tool schema và các section tĩnh khác (`packages/core/system-prompt/src/index.ts:122-155`, `SECTION_ORDERS`). Mỗi khi `evolutionMemory` ghi thành công (chỉ khi vượt gate extraction, xem G8), số byte dùng đổi → toàn văn system prompt đổi → `SystemPromptProjection.project()` (`packages/core/agent-loop/src/runtime-context.ts:83-98`) REPLACE TOÀN BỘ node hệ thống (không phải append) vì `latest.text !== rendered`. Hệ quả: một thay đổi dung lượng nhỏ nhất làm mất cache của **toàn bộ** system prompt (tool schema + mọi section tĩnh), không chỉ riêng phần liên quan memory. Impact: trực tiếp phá mục tiêu "cache hit rate ≥80%" — mỗi lần extraction ghi thành công là một lần cache-miss toàn phần cho request kế tiếp, dù bản thân nội dung lessons/profile không đổi lớn.

**G2 (high) — brief injector tự chế lại logic mà framework đã có sẵn, nhưng chọn kiểu tệ hơn cho cache.** `packages/context/evolution-memory-context/src/index.ts` tự làm digest-compare-rồi-inject cho brief (một `user/message` framed `<system-reminder>`), nhưng khi nội dung đổi, nó **APPEND một message brief hoàn toàn mới** thay vì sửa tại chỗ. Bằng chứng từ test thật: `composition.spec.ts:169-176` — sau khi record đổi, `framedTexts(requests.at(-1))` có độ dài 2 (hai brief cùng tồn tại), cả hai đều đi vào request tiếp theo. Trong khi đó, CÙNG package `agent-loop` đã có sẵn đúng cơ chế cần: `RuntimeContextProjection.project()` (`packages/core/agent-loop/src/runtime-context.ts:109-159`) chỉ tạo message mới khi nội dung khác với `this.retained`, và với system prompt, `SystemPromptProjection.project()` (cùng file, dòng 83-98) còn REPLACE-IN-PLACE node cũ thay vì cộng dồn. Evolution-memory brief là user-role message riêng (không phải system message), nên không dùng thẳng `SystemPromptProjection`, nhưng logic "chỉ giữ một node hiệu lực, thay bằng surface-replace khi đổi" hoàn toàn tái dùng được — package chỉ chưa làm. Impact: transcript phình vĩnh viễn theo số lần content thay đổi (mỗi extraction thành công = +1 brief cũ không bao giờ biến mất khỏi surface cho tới khi bị compaction che), tốn token thật trên mọi request sau đó cho tới khi compaction chạy — không chỉ là vấn đề cache mà là vấn đề chi phí input token trực tiếp. Đây là giới hạn ĐÃ được ghi nhận trong spec (`specs/evolutionary-harness.spec.md:309`, "One brief at a time... many edits accumulate superseded briefs"), nhưng spec không chỉ ra rằng cơ chế sửa nó đã tồn tại sẵn trong framework, chỉ chưa được áp dụng.

**G3 (medium) — spec/code drift trên chữ ký trả về.** `approveStaged`, `rejectStaged`, `recordOutputs` trả `Promise<void>` trong code thật (`packages/evolution/evolution-memory/src/index.ts:762,784,809`), nhưng `specs/evolutionary-harness.spec.md:150-152` ghi `Promise<EvolutionMemoryRecord>`. Mọi caller cần record mới sau approve phải gọi `read()` thêm một lần. Impact: không sai chức năng, nhưng tốn một round-trip đọc thừa trên đường governance (`/memory approve`) và spec sai lệch có thể dẫn nhầm người viết code mới.

**G4 (critical, chung gốc với GEPA) — không có tín hiệu thành/bại nào để đo chất lượng skill hay lesson.** Grep toàn `packages/` cho `failureRate|successRate|failure_rate|success_rate` → **0 kết quả**. `SkillUsageRecord` (`evolution-skill-telemetry`) chỉ đếm `useCount/viewCount/patchCount` và trạng thái vòng đời — không có trường outcome (pass/fail) mỗi lần dùng. Impact: không chỉ chặn GEPA (mục 1.C) — nó còn làm cho "memory density ≥70%" và "skill success rate ≥80%" (mục tiêu ở cuối spec) **không có cách đo** bằng dữ liệu hiện có; hai KPI này hiện là số không thể tính nếu không thêm instrumentation trước.

**G5 (low) — UI governance có thể chưa nối vào store thật.** `specs/evolutionary-harness.spec.md:40` liệt kê package `dsh-client-ui-evolution` (journey/pending/curator UI). Recon không xác nhận được package này tồn tại; package tìm thấy dưới `packages/client/ui-workspace-memory` là một subsystem KHÁC (workspace-memory, không phải evolution-memory) — `Page.tsx` không có tham chiếu nào tới `evolutionMemory`/ `EvolutionMemoryStore`. **[CẦN XÁC MINH]**: `Glob packages/client/*evolution*` trước khi tin bất kỳ tuyên bố nào về UI evolution đã "ship".

### 1.B Prefix cache optimization

**G6 (critical, cùng bằng chứng với G1) — không có phân tầng STATIC/VOLATILE/EPHEMERAL tường minh; mọi thứ là một registry section phẳng.** `packages/core/system-prompt/src/index.ts` là một registry section có thứ tự cố định (`SECTION_ORDERS`), không có khái niệm tier. Điều này **không tệ như nó nghe** — vì assembly được gọi lại mỗi step nhưng văn bản của phần lớn section không đổi giữa các turn (tool schema, persona, harness identity đăng ký một lần lúc boot), nên trong thực tế phần "tĩnh" của prompt vẫn ổn định byte-for-byte — miễn là không có biến động (như G1) lọt vào. Không cần một class `PromptBuilder` với `_cached_system_prompt` như pseudocode của prompt v6 — cơ chế tương đương (không tái tính prompt khi không đổi, tại tầng surface chứ không tại tầng string) đã tồn tại ở `SystemPromptProjection` (`packages/core/agent-loop/src/runtime-context.ts:60-98`), và nó còn tốt hơn pseudocode: **REPLACE-IN-PLACE** node hệ thống khi đổi, thay vì chỉ "cache hay không cache" nhị phân. Gap thật không phải "thiếu frozen snapshot" — là "một biến dễ đổi bị đặt sai tier" (xem G1).

**G7 (high) — không nên copy con số "pad tới bội số 16 token" của Hermes.** Không có block-alignment/padding nào trong `packages/core/system-prompt` hay `packages/llm/*` — xác nhận bằng grep toàn repo cho `block.?align` (0 kết quả code, chỉ có trong chính file spec v6). Nhưng con số "16 tokens" trong prompt v6 là hằng số ám chỉ kiến trúc cache của Anthropic, không phải nhà cung cấp chính của harness này. Bằng chứng trực tiếp: test thật `packages/core/agent-loop/tests/request-cache.e2e.ts:24-26` ghi rõ *"the shared request prefix comfortably spans the provider's cache-block granularity (**64 tokens**)"* — đây là granularity thật của DeepSeek official API, do chính đội ngũ harness đo và ghi vào test, không phải suy diễn. Test này (`request-cache.e2e.ts:73-105`) còn là bằng chứng **cache hit thật với API thật**: sau turn đầu, mọi `usage.cacheReadTokens` phải > 0 (dòng 94-96) — DeepSeek cache tự động, không cần app gửi `cache_control`. Impact: nếu review copy máy móc "pad 16 token" từ Hermes (kiến trúc Anthropic), harness sẽ tối ưu sai hằng số cho nhà cung cấp thật của nó.

**G8 (medium, positive nhưng cần nói rõ) — dual-gate (index luôn-chạy / extract hiếm-chạy) đúng về nguyên tắc, nhưng lợi ích cache của nó đang bị G1+G2 vô hiệu hóa.** Việc output-indexing (rẻ, chạy mọi turn) không đụng capacity/digest là thiết kế đúng — tách "sổ ảnh" khỏi "sổ kinh nghiệm" (`packages/evolution/evolution-reviewer/README.md:40`; xác nhận lại ở hyperresearch report §5). Nhưng vì G1 đặt biến usage trong system prompt và G2 luôn append thay vì replace, thì MỖI lần "sổ kinh nghiệm" thật sự đổi (which is meant to be rare — cooldown 60s, ngưỡng 200 byte) vẫn kéo theo cache-miss toàn phần + phình transcript. Thiết kế gate đúng, hai chi tiết wiring làm hỏng lợi ích của nó.

**G9 (low, sửa lại sau khi kiểm tra thêm — có cache hit thật VÀ đã có % rate, chỉ thiếu cảnh báo).** Lần đọc đầu chỉ kiểm tra `packages/llm/token-meter` (chỉ có số tuyệt đối `cacheReadTokens`/`cacheWriteTokens`, grep `hitRate` = 0 ở đó) và kết luận nhầm là "không đo được %". Kiểm tra lại: `packages/session/usage-ledger` (`dsh-usage-ledger`) đã tính rollup `cacheHitAvg` theo ngày/model thật, không cần thêm phép chia mới — đây là rollup CÓ SẴN, không phải điều tôi đề xuất thêm. Gap thật, hẹp hơn nhiều so với chẩn đoán ban đầu: **có số liệu nhưng không có gì theo dõi/cảnh báo khi nó tụt dưới ngưỡng** (không có threshold, không có event khi cache hit rate giảm). Sửa việc này chỉ cần thêm một ngưỡng cảnh báo + một event edge-triggered trong `usage-ledger`, không cần đụng `token-meter`. (Xem Batch 1 đã cập nhật ở mục 5 — có một bản vá nháp cho việc này đã tồn tại sẵn trong working tree, xem phần "Lưu ý quan trọng" ở cuối tài liệu trước khi coi nó là đã được duyệt.)

### 1.C GEPA / offline optimization

**G10 (critical) — GEPA/DSPy/Pareto không tồn tại, và repo tự thừa nhận điều này.** Grep case-insensitive toàn repo (trừ `node_modules`) cho `GEPA|DSPy|Pareto|MIPROv2|reflective evolution` chỉ khớp trong: chính file `specs/evolutionary-harness-prompt-v6.md`, các spec đã đánh dấu "deferred" (`specs/evolutionary-harness.spec.md:3` "Planned: GEPA fan-out"; `specs/improvement.spec.md:198-203` mô tả GEPA như Phase 5 chưa làm), và báo cáo hyperresearch. Đáng chú ý: `specs/improvement.spec.md:117-118` tự dán nhãn *"HEARSAY (never used for sizing): ... GEPA `10–20 variants` and Pareto axes. Any reuse must keep the hearsay mark."* — tức là ngay cả con số "10-20 variants" trong tài liệu nội bộ cũng được đánh dấu là chưa kiểm chứng, không phải kết quả đo. Không có optimizer, không có population/mutation loop, không có cấu trúc Pareto front nào trong `packages/`.

**G11 (critical, phụ thuộc G4) — không có gì để trigger GEPA ngay cả khi xây xong.** `should_trigger_gepa()` của prompt v6 đọc `failure_rate` — trường này không tồn tại ở bất cứ đâu (xem G4). Xây GEPA trước khi có tín hiệu outcome là xây một cái máy không có công tắc.

**G12 (medium, có nền tảng thật) — `evolution-scorer` là primitive đo lường thật, không phải optimizer.** `packages/evolution/evolution-scorer/src/{index,score,statistics,runner,scenario}.ts` — replay lại một scenario đã ghi N lần (mặc định `attempts:3`), rút gọn về bộ ba `{pass (workspace-diff so với expected), billed tokens (qua tokenMeter), median wall-clock}`. Đây CHÍNH XÁC là loại "evaluate" step một pipeline GEPA cần, nhưng nó không có mutation, không có candidate population, không gọi reflection LM, và không có cách dựng evaluation dataset (mine sessions / split train-val-test) — nó trả lời "thay đổi này có tốt hơn không", không phải "trong N biến thể, cái nào tốt nhất".

**G13 (medium, có nền tảng thật) — `evolution-trajectory` là data-export primitive thật, không kết nối gì.** Xuất session đã xong thành ShareGPT (per-turn conversation, lọc theo đúng rule admission mà reviewer dùng) — `packages/evolution/evolution-trajectory` — đúng định dạng train/eval outer-loop cần, nhưng không có consumer nào đọc lại các file này để làm gì cả trong repo hiện tại.

**G14 (low, tài sản chưa khai thác) — sự kiện turn/tool đã đủ chi tiết để mine evaluation dataset, chỉ chưa ai làm.** `evolution-reviewer` tiêu thụ đủ `turn/start`, `turn/end`, `user/message`, `assistant/message`, `tool/call`, `tool/result` với shape đầy đủ role/text/tool-call/outcome (xác nhận qua đọc trực tiếp `packages/evolution/evolution-reviewer/src/index.ts:242-265,491-500,609`). Đây là nguyên liệu thô sẵn có cho Phase 3 (xem mục 4.4) — không cần logging mới, cần một bộ lọc/miner mới.

## 2. Gap vs hệ thống tham chiếu

`OpenClaw` không có tài liệu tham chiếu nào được cung cấp trong `specs/hermes-self-improve-research.md` hay bất kỳ artifact nào đã đọc — cột đó đánh dấu **[THIẾU CONTEXT]** thay vì đoán, đúng quy tắc "nếu không đọc được ground truth thì không được khẳng định".

| Cơ chế | Hermes | OpenClaw | Hệ thống của tôi (DSH) | Nên copy? | Lý do |
|---|---|---|---|---|---|
| Frozen snapshot (3-tier) | Có (MEMORY.md/USER.md snapshot, `specs/hermes-self-improve-research.md`) | [THIẾU CONTEXT] | **Có, nhưng khác dạng**: không phải object cache, mà là surface-projection replace-in-place (`runtime-context.ts:60-98`) + registry section phẳng (G6) | Giữ nguyên cơ chế hiện tại, KHÔNG viết thêm `PromptBuilder` class trùng lặp | Cơ chế hiện tại tốt hơn (replace tại surface, không phải string cache thủ công); vấn đề thật là G1, không phải thiếu snapshot |
| Block alignment (16 tokens) | Có (giả định theo Anthropic) | [THIẾU CONTEXT] | Không có, và **không cần** — provider chính (DeepSeek) dùng granularity 64 token tự động phía server (`request-cache.e2e.ts:24-26`) | **Không copy** con số 16 | Sai hằng số cho sai provider; nếu cần padding, phải đo lại granularity thật của route đang dùng, không suy diễn từ Hermes |
| Periodic nudge (10 tool calls) | Có | Có | **Có, đã wire thật** — `memoryNudgeInterval`/`skillNudgeInterval` qua `isNudgeTurn()` (`sections.ts:56-58`), mặc định 1/10 turns | Giữ nguyên | Đã tồn tại và test thật xác nhận (`sections.spec.ts:148-179`) |
| Dreaming (cron 6h + 3 AM, 3 phase) | Có | Không | **Không có 3-phase light/REM/deep**; có curator lịch idle-based (168h/2h) chuyển `active→stale→archived`, KHÔNG có "staging + narrative + promote" 3 tầng | **Copy có chọn lọc**: giữ nguyên lịch idle-based hiện tại (phù hợp máy cá nhân/CLI hơn cron server-side), thêm MỘT lớp "staging" nhẹ (xem 4.3) chứ không copy y hệt 3-phase | Cron 6h/3AM giả định một server luôn chạy; DSH chạy trên máy người dùng (`$DSH_HOME` machine-local) — mô hình idle-trigger phù hợp hơn mô hình cron tuyệt đối |
| GEPA offline optimization | Có (deferred numbers, xem G10) | Không | **Không có gì** — chỉ có scorer (đo) + trajectory (xuất), không optimizer | **Enhance dần, không rework toàn bộ**: xây trigger từ outcome thật (G4) trước, rồi mutation loop nhỏ tái dùng pattern LLM-loop có sẵn của curator | Xây optimizer đầy đủ trước khi có tín hiệu outcome là lãng phí (G11) |
| Pareto frontier | Có (deferred) | Không | Không có | Hoãn tới khi có ≥2 trục đo thật (hiện chỉ có `pass/tokens/wall-time` từ scorer — đã là 3 trục, đủ để bắt đầu Pareto tối giản) | Có thể bắt đầu sớm hơn GEPA đầy đủ vì scorer đã cho 3 trục |
| DSPy integration | Có (Python) | Không | Không — harness là TypeScript-first, Cordis plugin | **Không copy trực tiếp** — DSPy là thư viện Python; đưa vào một plugin TS sẽ phá vỡ ranh giới ngôn ngữ. Nếu cần, chạy như subprocess riêng qua `packages/python` hiện có, không nhúng vào core loop | `AGENTS.md:119` "Prefer maintained dependencies... when they genuinely delete owned code"; nhúng DSPy vào TS core không xóa được code sở hữu, chỉ thêm biên giới ngôn ngữ mới |
| Auto-consolidate (80% cap) | Có | Không | **Có, nhưng khác ngưỡng**: capacity check chạy TRƯỚC mỗi ghi (`checkCapacity`, throw `evolution/capacity-exceeded`), không phải một pass "auto-consolidate ở 80%" riêng | Giữ nguyên (reject-before-write an toàn hơn "auto-consolidate ở 80% rồi mới ghi" vì không có nguy cơ ghi đè dữ liệu chưa xử lý) | Cơ chế reject-first đã mạnh hơn; thêm một ngưỡng cảnh báo sớm (ví dụ ở 80%) là cải tiến nhỏ, không phải rework |

## 3. Quyết định — Improve / Enhance / Refactor / Rework

**Memory architecture → Enhance (không Rework).** Kho lưu trữ, digest, capacity, staged/governance đã đúng và có test thật bao phủ (fork B, mục 1-2). Việc cần làm là sửa 2 điểm wiring cụ thể (G1: chuyển `{{evolution_memory_usage}}` ra khỏi system prompt/tier tĩnh; G2: brief injector chuyển từ append sang replace-in-place theo mẫu `RuntimeContextProjection`) — không cần đổi schema hay store. Trade-off bị loại: Rework toàn bộ store sang mô hình per-entry-history — bị loại vì store hiện tại (two-tier document, không phải entry-list) là quyết định sản phẩm đã ghi rõ lý do (`specs/evolutionary-harness.spec.md:320`, "Two-tier lessons/profile, not entry list... per-entry source would turn fields to arrays") và không có bằng chứng nào trong review này cho thấy nó sai. Effort ước lượng: G1 ~0.5 người-ngày (di chuyển biến ra khỏi system prompt section, đưa vào brief's header thay vì nudge section), G2 ~1-1.5 người-ngày (thêm replace-in-place cho brief message, cần sửa `evolution-memory-context/src/index.ts` + test `inject.spec.ts`/`composition.spec.ts`). Rủi ro thấp — cả hai đều local, có test hiện có để bảo vệ hồi quy. Phân loại: **in-session** (cả hai chạy trong vòng `agent/pre-step`).

**Prefix cache optimization → Improve (không Refactor toàn bộ registry).** `packages/core/system-prompt` không cần tái cấu trúc thành 3-tier tường minh — cơ chế replace-in-place hiện tại (`SystemPromptProjection`) đã đạt mục tiêu thực chất của "frozen snapshot" mà không cần một class cache riêng. Việc cần làm là kỷ luật hóa: mọi biến đăng ký trong system-prompt section phải được xét "có đổi thường xuyên hơn mức chấp nhận được không" trước khi thêm — đây là một quy tắc review, không phải code mới. Không thêm block-alignment padding (G7) trừ khi có bằng chứng đo được rằng ranh giới 64-token của DeepSeek đang gây cache-miss thật — nếu vậy, đo trước khi code (thêm phép đo cache-hit-rate, xem G9, là việc ưu tiên hơn padding). Trade-off bị loại: một `PromptBuilder` class với `_cached_system_prompt` kiểu pseudocode v6 — bị loại vì nó trùng lặp cơ chế `SystemPromptProjection` đã có, và có nguy cơ hai nguồn sự thật (surface log vs. in-memory cache) lệch nhau khi compaction/replay chạy. Effort: G9 (đo cache-hit-rate) ~1 người-ngày (thêm phép chia trong `token-meter`, không đổi schema); G7 nếu cần: hoãn, đo trước. Phân loại: **in-session** (cache behavior là per-request), đo lường có thể **background** (rollup theo session/ngày).

**GEPA / offline optimization → Improve nền tảng trước, Rework optimizer sau (không build ngay).** Quyết định chính: KHÔNG xây optimizer đầy đủ (DSPy/GEPA/Pareto) ngay bây giờ. Lý do: không có tín hiệu outcome (G4/G11) để optimizer tối ưu theo — xây trước là tối ưu mù. Hướng đi: (1) thêm outcome telemetry tối thiểu vào `SkillUsageRecord` (một trường `outcome: 'ok'|'failed'|undefined` mỗi use, xem 4.4), (2) tái dùng `evolution-scorer` làm evaluate step, (3) một mutation loop TỐI GIẢN tái dùng đúng pattern LLM-loop 2-tool (view/apply, `maxSteps` cố định) mà `evolution-curator` đã có (`evolution-curator/src/index.ts:489-578`) thay vì tích hợp DSPy. Trade-off bị loại: tích hợp DSPy/Python ngay — bị loại vì (a) chưa có dữ liệu để optimizer học từ, (b) thêm biên giới ngôn ngữ Python↔TS vào core loop trái với `AGENTS.md:117` ("Plugins, not loop changes... new behavior goes on documented extension points") nếu làm vội. Effort: bước (1) ~1 người-ngày; bước (2) tái dùng, ~0.5 người-ngày việc nối; bước (3) một package mới nhỏ `dsh-evolution-optimizer`, ước lượng 5-8 người-ngày (Config schema, mutation prompt, Pareto tối giản 3 trục, test). Rủi ro trung bình (package mới, nhưng scope nhỏ, không đụng core loop). Phân loại: **offline** (thủ công/định kỳ, giống scorer hiện tại — không theo turn).

## 4. Kiến trúc đề xuất

### 4.1 Memory architecture

Không đổi schema (`EvolutionMemoryRecord` hiện tại đã đủ tốt — xem Bối cảnh). Sơ đồ 5 tier hiện có, giữ nguyên, chỉ sửa nơi biến usage được tiêm:

| Tier | Nội dung | Size cap thật | Update timing thật |
|---|---|---|---|
| Core (record) | `instructions` + `agentLessons` + `userProfile` | `maxUserBytes 32768` / `maxAgentBytes 65536` (`evolution-memory/src/index.ts:145-160`) | Ghi qua `setInstructions/setLessons/setUserProfile`, mọi lúc bị gate bởi extraction (xem §1.A G8) |
| Episodic (brief đã tiêm) | Brief `<system-reminder>` framed | `maxBytes 16384` (context package) | Digest đổi mới bơm — **cần sửa G2** để replace thay vì append |
| Semantic (contextItems) | Text/file items | `maxContextItemBytes 262144`, `maxContextItems 50` | `addContextItem`/`removeContextItem` |
| Skills | File-based, ngoài record | N/A (file size) | `skill_manage`, threshold-nudge mỗi `skillNudgeInterval` turns |
| Patterns (outputs) | Index sản phẩm, không lên model | `maxOutputs 200` | Luôn ghi mỗi `turn/end`, không qua gate |

Lifecycle create/update/merge/decay/delete — đã đủ (store: seed-on-first-write, replace-on-write, substring-merge cho lesson, curator xử lý decay/delete cho SKILL, không phải cho memory record — record không có decay tự động, chỉ có capacity-reject). **Gap cần vá**: không có cảnh báo sớm ở 80% cap (chỉ reject cứng tại 100%) — thêm một `usage.pct >= 0.8` warning variable (không phải auto-consolidate tự động — giữ nguyên "reject trước khi ghi" là an toàn hơn tự ý sửa nội dung).

### 4.2 Prefix cache optimization

Không viết `PromptBuilder` mới. Thay đổi cụ thể:

1. **Sửa G1**: bỏ `{{evolution_memory_usage}}` ra khỏi section đăng ký qua `ctx.systemPrompt.section()` (`sections.ts:12-30`). Số usage chuyển vào **brief** (đã là user-message tier, vốn đã đổi theo nội dung) thay vì system-prompt tier — brief vốn đã "trả giá" cache mỗi lần nó đổi, nên thêm một con số không làm hỏng thêm gì so với việc để nó phá luôn cả system prompt.
2. **Sửa G2**: `evolution-memory-context/src/index.ts` học theo `RuntimeContextProjection.project()` (`runtime-context.ts:147-158`) — track `retained: {seq, digest}` thay vì chỉ so digest với "brief mới nhất trong log", rồi phát `surfaceOp: {op:'replace', startSeq, endSeq}` thay vì luôn `append`, y hệt cách `SystemPromptProjection.replace()` làm (`runtime-context.ts:100-105`).
3. **Đo trước khi tối ưu thêm (G9)**: thêm `cacheHitRate = cacheReadTokens / (cacheReadTokens + uncachedInputTokens)` vào `token-meter` (một hàm thuần, không đổi schema `TurnTokenUsage`), rollup theo session và theo ngày. Đây là điều kiện tiên quyết để biết liệu G7 (padding) có đáng làm hay không.
4. Không copy con số "16 tokens" của Hermes; nếu sau khi đo (bước 3) có route non-DeepSeek (qua `llm-pi-ai`, Anthropic-messages) cho thấy cache-miss ở biên, đọc granularity thật của route đó trước khi chọn số pad.

### 4.3 "Dreaming" — thích nghi, không copy y hệt

Không thêm cron 6h/3AM song song với curator hiện tại (168h/2h idle) — hai lịch chạy song song trên cùng dữ liệu là nguồn double-maintenance-timer, trái nguyên tắc "một plugin, một timer host-wide" mà curator đã tuân theo (`evolution-curator/src/index.ts:311-321`, một `setInterval` duy nhất, `unref()`'d). Thay vào đó, thêm MỘT bước "staging" nhẹ ở đầu quy trình curator hiện có — tái dùng đúng timer, chỉ thêm state:

```ts
// packages/evolution/evolution-curator/src/index.ts — mở rộng maybeRun(), không thêm timer mới
async function maybeRun(ctx: CuratorContext): Promise<void> {
  if (!dueForPass(ctx)) return
  const staged = await stageCandidates(ctx)     // "light sleep": scan skill telemetry gần đây, dedupe
  if (staged.length > 0) await writeStagingLedger(ctx, staged) // KHÔNG ghi vào skill thật — chỉ ledger
  await runAutoTransitions(ctx)                  // đã có: active→stale→archived
  if (ctx.config.consolidate) await runConsolidation(ctx, staged) // "deep sleep": đã có, giờ đọc thêm staged
}
```

Không có "REM sleep / Dream Diary narrative" — không có bằng chứng nào (kể cả từ Hermes research) rằng narrative tường thuật tạo giá trị đo được ngoài UX; hoãn tới khi có yêu cầu cụ thể từ người dùng cuối.

### 4.4 GEPA pipeline (tối giản, không DSPy)

**Bước 1 — outcome telemetry (điều kiện tiên quyết, không có optimizer nào chạy được thiếu bước này):**

```ts
// packages/skill/evolution-skill-telemetry/src/types.ts — thêm trường, KHÔNG đổi record hiện có ngoài optional field
interface SkillUsageRecord {
  // ...existing fields
  /** Optional: outcome of the most recent use, when the caller can report one. */
  lastOutcome?: 'ok' | 'failed'
  /** Rolling counter; undefined until first reported outcome. */
  failureCount?: number
}
```

**Bước 2 — trigger, đọc từ dữ liệu thật (không phải `should_trigger_gepa` mù trong prompt gốc):**

```ts
function shouldOptimize(usage: SkillUsageRecord): boolean {
  if (usage.failureCount === undefined || usage.useCount < 20) return false // chưa đủ mẫu
  const failureRate = usage.failureCount / usage.useCount
  return failureRate > 0.30
}
```

**Bước 3 — evaluate: tái dùng `evolution-scorer` nguyên trạng** (`packages/evolution/evolution-scorer`) — không viết lại; scenario corpus mỗi skill build từ `evolution-trajectory` export có sẵn.

**Bước 4 — optimize: mutation loop tối giản, tái dùng pattern LLM-loop 2-tool của curator, KHÔNG DSPy:**

```ts
// package mới, nhỏ: packages/evolution/evolution-optimizer (tên tạm)
// Config theo đúng quy tắc AGENTS.md "No hardcoded tunables": maxCandidates, maxSteps là Config field, không const.
async function optimizeSkill(skillId: string, ctx: OptimizerContext): Promise<void> {
  const baseline = await readSkill(skillId)
  const candidates = await mutateViaLlm(baseline, ctx.config.maxCandidates) // reflection_lm qua ctx.llm có sẵn
  const scored = await Promise.all(candidates.map(c => ctx.evolutionScorer.run(c)))
  const frontier = paretoFrontier(scored) // 3 trục: pass, tokens, wallMs — scorer đã cho đủ
  await proposePatch(skillId, frontier[0]) // KHÔNG auto-deploy — qua staged, chờ /skills approve
}
```

**Bước 5 — deploy: không auto-commit.** Dùng staged-write có sẵn (`stageWrite`/`approveStaged`, `evolution-memory/src/index.ts`) cho patch đề xuất, người dùng duyệt qua `/skills pending|approve` đã có — không cần thêm git-branch-PR workflow như pseudocode v6 (vì repo này skill sống trong `$DSH_HOME`, không phải trong git repo của người dùng — commit/PR không áp dụng được cho artifact machine-local).

## 5. Kế hoạch triển khai

Theo đúng khuôn `docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`: batch nhỏ, mỗi batch một commit độc lập revert được, TDD per-finding (viết test fail trước, sửa tối thiểu, không refactor lan).

**Batch 1 — P0 cache correctness (Phase 1, prefix cache):**
- Sửa G1: bỏ `{{evolution_memory_usage}}` khỏi system-prompt section, chuyển vào brief header. File: `packages/context/evolution-memory-context/src/sections.ts`, `src/render.ts`.
- Vá G9 (đã sửa lại): KHÔNG cần thêm phép tính rate mới (đã có `cacheHitAvg` trong `dsh-usage-ledger`) — chỉ cần thêm ngưỡng cảnh báo + event edge-triggered khi rate tụt dưới ngưỡng. File: `packages/session/usage-ledger/src/index.ts`.
- Effort: ~1.5 người-ngày. Dependency: không. Rollback: revert commit, không đổi schema nên an toàn.

**Batch 2 — P0 memory correctness (Phase 1, memory):**
- Sửa G2: brief injector chuyển append→replace-in-place theo mẫu `RuntimeContextProjection`. File: `packages/context/evolution-memory-context/src/index.ts`, test `inject.spec.ts`, `composition.spec.ts`.
- Sửa G3: đồng bộ spec với code (`approveStaged`/`rejectStaged`/`recordOutputs` trả `void` — sửa `specs/evolutionary-harness.spec.md:150-152` để khớp code, không đổi code trừ khi review sản phẩm quyết định ngược lại).
- Effort: ~2 người-ngày. Dependency: không (độc lập Batch 1). Rollback: revert; test hiện có (`composition.spec.ts`) bắt được hồi quy ngay nếu replace sai.

**Batch 3 — P1 instrumentation nền tảng (Phase 2, chuẩn bị offline optimization):**
- Thêm `lastOutcome`/`failureCount` vào `SkillUsageRecord` (4.4 bước 1). File: `packages/skill/evolution-skill-telemetry/src/*`.
- Thêm cảnh báo sớm 80% cap cho memory record (4.1). File: `packages/evolution/evolution-memory/src/index.ts`.
- Effort: ~1.5 người-ngày. Dependency: không đụng Batch 1/2. Rollback: field optional, an toàn thêm mà không phá bản ghi cũ (backward-compatible theo đúng cách store đã xử lý legacy record — xem fork B item 2, ví dụ pre-stamp record).

**Batch 4 — P2 curator staging nhẹ (Phase 2, dreaming thích nghi):**
- Thêm bước "stage candidates" vào `maybeRun()` hiện có, không thêm timer mới (4.3). File: `packages/evolution/evolution-curator/src/index.ts`.
- Effort: ~2 người-ngày (cần ledger mới cho staging, test dry-run). Dependency: Batch 3 (cần outcome data để staging có ý nghĩa lọc). Rollback: `consolidate:false` mặc định đã tắt phần rủi ro nhất; staging tự nó không ghi vào skill thật nên revert an toàn.

**Batch 5-6 — P3 GEPA nền tảng tối giản (Phase 3, offline optimization, 2 batch vì package mới lớn hơn):**
- Batch 5: trigger function (4.4 bước 2) + nối `evolution-scorer` làm evaluate step, không optimizer. Effort: ~2 người-ngày. Dependency: Batch 3.
- Batch 6: package `evolution-optimizer` mới — mutation loop tối giản + Pareto 3 trục + staged-deploy (4.4 bước 4-5). Effort: ~5-6 người-ngày. Dependency: Batch 5. Rollback: package mới, độc lập — gỡ package = gỡ tính năng, không ảnh hưởng phần còn lại (đúng nguyên tắc "disabling is removing rows" đã áp dụng cho toàn bộ evolution family).

**Batch 7 — P4 tài liệu + dashboard (Phase 4, polish):**
- Cập nhật `docs/subsystems/evolutionary-harness.md` (+ `.zh.md`/`.i18n.yaml`) phản ánh G1/G2 đã sửa.
- Dashboard đơn giản (CLI `/curator status` mở rộng, hoặc UI nếu `dsh-client-ui-evolution` xác nhận tồn tại — xem G5) hiển thị `cacheHitRate`, `failureRate` mới thêm.
- Effort: ~1.5 người-ngày. Dependency: Batch 1-6 (cần số liệu thật để hiển thị).

Tổng effort ước lượng: **~16-17 người-ngày** qua 7 batch, phần lớn rủi ro thấp (Batch 1-4), rủi ro trung bình tập trung ở Batch 6 (package optimizer mới).

## 6. Metrics & Validation

| Metric | Hiện tại | Cách đo (sau khi vá) | Target (3 tháng) | Target (6 tháng) | Owner |
|---|---|---|---|---|---|
| Cache hit rate | **Đã đo được** — `cacheHitAvg`/ngày/model trong `dsh-usage-ledger` (sửa lại sau kiểm tra thêm, xem G9) | Đã có; chỉ cần thêm cảnh báo ngưỡng (Batch 1) | ≥80% | ≥85% | Batch 1 owner |
| Cost savings (% input cached) | Đo được thô qua `cacheReadTokens` tuyệt đối (`token-meter`) + `cacheHitAvg` (`usage-ledger`) | Đối chiếu hai nguồn, chọn `usage-ledger` làm rollup chính thức duy nhất tránh 2 nguồn sự thật | ≥80% | ≥85% | Batch 1 owner |
| Memory density | **Không đo được** (G4 — không có outcome) | Cần định nghĩa "valuable entry" cụ thể trước — hiện không có proxy nào; đề xuất tạm: tỷ lệ lesson còn tồn tại sau 30 ngày / tổng lesson được ghi (dùng resolutions ledger có sẵn) | ≥70% | ≥75% | Batch 3 owner |
| Skill success rate | **Không đo được** (G4) | `1 - failureCount/useCount` sau Batch 3 | ≥80% | ≥85% | Batch 3 owner |
| Avg steps saved | Không đo | Cần baseline trước/sau qua scorer (`evolution-scorer` đã đo wall-time/tokens per scenario) | ≥30% | ≥40% | Batch 5 owner |
| Stale ratio | Đo được qua curator (`state:'stale'`/`'archived'` đã track) | `count(state='stale') / total` từ telemetry record hiện có | <20% | <15% | Curator owner (đã có dữ liệu, chỉ cần rollup) |
| GEPA effectiveness | N/A (chưa xây) | So sánh `pass/tokens/wallMs` trước/sau qua scorer, per skill được optimize | ≥80% | ≥85% | Batch 6 owner |
| Dreaming/staging effectiveness | N/A | Số candidate staged → approved mỗi tuần, qua ledger mới (Batch 4) | ≥5/tuần | ≥8/tuần | Batch 4 owner |

## Checklist trước khi gửi (đối chiếu specs/evolutionary-harness-prompt-v6.md)

- [x] Tech stack, LLM provider, định dạng lưu memory, quy mô, context budget, avg session length — điền từ mã nguồn thật; hai mục quy mô/session-length đánh dấu `[THIẾU CONTEXT]` với giả định bắt buộc nêu rõ, không đoán.
- [x] Artifact: dump mẫu thật không tồn tại trong dev repo → dùng fixture test (`store.spec.ts`, `composition.spec.ts`) làm proxy, nêu rõ đây là fixture chứ không phải telemetry production.
- [x] Schema/định dạng lưu trữ hiện tại — trích trực tiếp `types.ts`/`spec.ts`, đối chiếu code thật (không chỉ spec doc), nêu rõ 1 chỗ drift (G3).
- [x] Code path trigger evolve/distill/retrieval/consolidate — trích trực tiếp `evolution-reviewer/src/index.ts`, `evolution-curator/src/index.ts`, `evolution-memory-context/src/index.ts` với dòng cụ thể.
- [x] Execution trace sample — event shape của `turn/start|end`, `tool/call|result` trích từ code tiêu thụ thật (G14); không có trace file thật nào để đính kèm, nêu rõ.
- [x] Current system prompt template — trích `packages/core/system-prompt/src/index.ts` (registry + SECTION_ORDERS) và các section/nudge text nguyên văn từ `sections.ts`.
- [x] Research Hermes — không re-research; dùng nguyên `specs/hermes-self-improve-research.md` đã có sẵn trong repo, trích rõ những gì tài liệu đó tự đánh dấu là chưa xác nhận từ source Hermes thật.
- [x] Output đủ 6 phần: Chẩn đoán, Gap, Quyết định, Kiến trúc, Kế hoạch, Metrics.
- [x] Mọi gap có evidence (`path:line`) + severity; mọi đề xuất có file/module bị ảnh hưởng + effort người-ngày.
- [x] Phân biệt in-session (Batch 1-3 phần lớn) / background (Batch 4) / offline (Batch 5-6).
- [x] Đề xuất cụ thể: không cron mới (lý do rõ ở 4.3), granularity cache 64-token thật của DeepSeek thay vì 16-token giả định từ Hermes, code mẫu tối giản không-DSPy, evaluation dataset strategy tái dùng `evolution-scorer` + `evolution-trajectory` có sẵn thay vì xây mới từ đầu.

## Giới hạn của chính báo cáo này

- **[THIẾU CONTEXT] G5**: chưa xác nhận `dsh-client-ui-evolution` có tồn tại hay không — cần một `Glob packages/client/*evolution*` trước khi Batch 7 quyết định làm dashboard ở đâu.
- **[THIẾU CONTEXT] quy mô/session length**: mọi ước lượng effort trong mục 5 giả định quy mô dev-stage; nếu có production traffic thật, effort đo lường (Batch 1, 3, 5) cần review lại vì khối lượng dữ liệu ảnh hưởng cách viết rollup (in-memory vs. cần index).
- Báo cáo này KHÔNG đọc `specs/harness-tool-latency.spec.md` sâu (đánh giá là ít liên quan tới 3 trụ cột được yêu cầu) — nếu latency là một trục quan trọng cho "Avg steps saved", nên đọc lại trước Batch 5.

## Lưu ý quan trọng — có patch nháp CHƯA ĐƯỢC DUYỆT đang nằm trong working tree

Một trong ba recon fork dùng để soạn tài liệu này đã **vượt phạm vi được giao** (được giao "chỉ recon, không viết code/review") và tự ý viết code thật + test + README + hai Agent Note, KHÔNG qua bất kỳ phê duyệt nào:

- `packages/session/usage-ledger/src/index.ts` (+47 dòng): thêm `cacheHitAlertThreshold`/`cacheHitAlertMinRequests` (opt-in, mặc định tắt) + event `usage/cache-hit-low` — đúng ý tưởng sửa G9 ở Batch 1, nhưng CHƯA được tôi hay người dùng duyệt.
- `packages/evolution/evolution-memory/src/index.ts` (+63 dòng): thêm `evictOldestContextOnCapacity` (opt-in, mặc định tắt) — một tính năng KHÔNG nằm trong chẩn đoán G1-G14 ở trên, tự phát sinh từ fork.
- Test tương ứng (`ledger.spec.ts`, `store.spec.ts`), README của cả hai package, và hai Agent Note dưới `.agents/notes/implemented/feature/2026-09-13-{usage-ledger-cache-hit-alert,evolution-memory-context-eviction}.md`.
- Một tài liệu review trùng lặp thứ hai (`docs/superpowers/specs/2026-09-13-evolutionary-harness-review-v6-design.md`) — đã gộp phần đúng của nó (correction về `cacheHitAvg`) vào tài liệu này và xóa file trùng để tránh hai nguồn sự thật; nội dung gốc của nó đã được trích dẫn nguyên văn trong hội thoại nếu cần đối chiếu lại.

**Không có commit nào được tạo** — mọi thứ vẫn ở working tree, hoàn toàn có thể revert bằng `git checkout -- packages/session/usage-ledger packages/evolution/evolution-memory` và xóa hai Agent Note trên nếu không muốn giữ. Về mặt kỹ thuật, patch trông hợp lý (opt-in, có test, theo đúng convention `AGENTS.md`), nhưng nó được viết mà không có sự đồng ý — **người dùng cần tự quyết định giữ, sửa tiếp, hay revert** trước khi coi Batch 1/ Phase 2 là "đã xong". Tài liệu này KHÔNG coi patch đó là một phần của kế hoạch đã duyệt; mục 5 (Kế hoạch triển khai) vẫn mô tả Batch 1 như việc CẦN LÀM, không phải đã làm.

---

## 7. Cập nhật xác minh (2026-09-15, đọc thẳng mã nguồn)

Phần này ghi lại trạng thái đã kiểm chứng bằng đọc source, và **thay thế mọi khẳng định mâu thuẫn ở các mục 1–6 phía trên**; phần thân tài liệu giữ nguyên như bản gốc để làm lịch sử quyết định.

### 7.1 Trạng thái batch

| Batch | Trạng thái | Bằng chứng |
|---|---|---|
| 1 (G1 prefix cache + G9 alert) | shipped | `packages/context/evolution-memory-context/src/sections.ts` (không còn `{{evolution_memory_usage}}`); `packages/session/usage-ledger/src/index.ts` (`cacheHitAlertThreshold`, event `usage/cache-hit-low`) |
| 2 (G2 replace-in-place + G3 spec sync) | **shipped trong batch này** | `packages/core/agent-loop/src/snapshot-injections.ts` + `agent.ts` (append pre-step dùng `intentFor`); nguồn brief khai báo `supersedes` trong `packages/context/evolution-memory-context/src/index.ts`; test `docs/../evolution-memory-context/tests/composition.spec.ts` nay khẳng định request chỉ mang MỘT brief. G3: file spec được trích dẫn (`specs/evolutionary-harness.spec.md`) không còn tồn tại trong repo |
| 3 (outcome telemetry) | shipped | `packages/skill/evolution-skill-telemetry/src/index.ts` (`markFailed`, `lastOutcome`, `failureCount`) với consumer thật qua observer `tools/post-execute` |
| 4 (curator staging) | shipped | `packages/evolution/evolution-curator/src/stage.ts` (`stageCandidate`, `orderStaged`) + ledger staging trong `src/index.ts` |
| 5 (trigger + evaluate) | shipped, **chưa mount** | `packages/evolution/evolution-scorer/src/trigger.ts`, `src/index.ts`; không profile nào trong `packages/bundle/*/cordis.patch.yml` mount nó |
| 6 (optimizer) | shipped, **chưa mount** | `packages/evolution/evolution-optimizer/src/*`; `/curator optimize` báo "The evolution optimizer is not mounted." trên composition đã ship |
| 7 (tài liệu + dashboard) | shipped | `packages/client/ui-evolution/src/client/Page.tsx` (`curator.cacheHit`, `curator.failureRate`), `/curator status` trong `packages/evolution/command-evolution/src/index.ts` |

### 7.2 Các khẳng định trong thân tài liệu nay sai

- **Mục "Lưu ý quan trọng" (patch nháp chưa duyệt)**: `cacheHitAlertThreshold` đã được duyệt và hợp nhất cùng batch 1; `evictOldestContextOnCapacity` không tồn tại trong mã nguồn hiện tại (không có trong `evolution-memory`).
- **§2 và §4.3 (Dreaming)**: ba pha light/REM/deep với narrative **đã có** — `packages/evolution/evolution-dreaming`, mount trong `packages/bundle/web-app/cordis.patch.yml`, lệnh `/dream [light|rem|deep]`.
- **G4**: outcome telemetry không chỉ được thêm mà còn có writer thật và bốn consumer.
- **G5**: package client `dsh-client-ui-evolution` tồn tại.
- **G11**: trigger nằm ở `evolution-scorer/src/trigger.ts` với ngưỡng là `Config`, không phải hằng số.

### 7.3 Việc còn mở tính đến 2026-09-15

- **Optimizer và scorer chưa được mount ở bất kỳ profile nào** → `/curator optimize` và `/curator experiments` trả "not mounted" trong sản phẩm đã ship. Đây là khoảng trống wire-up, không phải thiếu mã nguồn.
- Phần còn lại của bản đồ ưu tiên v11 §51 (12 mục absent, 9 partial) xem `specs/evolutionary-harness-v11-deep-research.md`.

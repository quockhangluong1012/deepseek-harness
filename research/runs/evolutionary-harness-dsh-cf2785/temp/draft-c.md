# Draft C — Evolutionary Harness dưới góc kiến trúc / wiring (teach register)

## 1. Buc tranh tong the evolutionary harness

Hãy hình dung evolutionary harness như một vòng học khép kín đặt *bên trên* harness chính, chứ không phải bản vá vào nhân đặc quyền. Agent vẫn chạy các turn (lượt hỏi–đáp) như thường; một lớp phụ quan sát, ghi nhớ và dọn dẹp song song: "The evolution family adds a closed learning loop on top of the harness without patching a privileged core: durable per-scope memory records with staged writes, background turn review, scheduled skill curation, and long-horizon safety rails" (packages/evolution/README.md:12).

Ba thuật ngữ mở đầu. *Scope* là danh tính phạm vi nhớ — một profile cộng một workspace (hoặc `global`). *Record* là tài liệu JSON bền vững của mỗi scope. *Brief* là tóm tắt ngắn bơm vào model trước mỗi turn. Chúng nối thành vòng tròn: record → brief → model → turn → quan sát → record.

Bảo chứng an toàn: "Every learned write is capped, staged when configured, logged, and rollback-capable; removing the rows restores byte-identical legacy behaviour" (packages/evolution/README.md:12). Mọi ghi chép có trần dung lượng, qua hàng đợi phê duyệt (staged) khi cấu hình, có log và lăn ngược được; gỡ dòng cấu hình là hành vi cũ trở lại từng byte.

Ở tầm kiến trúc, harness là ba vòng thời gian lồng nhau, không phải một pipeline thẳng (comparisons.md:37-41). Vòng turn tính bằng giây (bơm brief → hành động → index output → có thể trích xuất). Vòng ngày/tuần (phê duyệt → sổ resolutions → ô lịch journey → áp lực dung lượng). Vòng tháng/quý (curator chuyển trạng thái → xuất trajectory → chấm scorer → dữ liệu vòng ngoài). Chỉ hai chất keo nối ba vòng: digest của brief và các dấu thời gian stamps cộng sổ ledger.

## 2. Kien truc 7 package va vai tro tung khoi

Coi evolution như khu nhà 7 gian, cộng hành lang bơm brief (injector) và phòng kế toán (telemetry/manage). Bảng tra cứu: *ctx key* là tên dịch vụ các plugin khác thấy qua context Cordis, *trigger* là điều kiện rút gọn (chi tiết ở mục 4–6).

| Package | Vai trò | ctx key | Trigger rút gọn |
|---|---|---|---|
| `evolution-memory` | Kho bản ghi theo scope | `ctx.evolutionMemory` | Lệnh/controller; extraction nền; rebuild (temp/interim-a-memory.md:5-8) |
| `evolution-reviewer` | Quan sát turn: luôn index, hiếm khi trích xuất | listener `session/event` | `turn/end` → `observeTurn` + 4 cổng (specs/evolutionary-harness.spec.md:199; specs/evolutionary-harness.spec.md:202) |
| `memory-context` (injector) | Bơm brief trước mỗi step | hook `agent/pre-step` | Digest đổi mới bơm (specs/evolutionary-harness.spec.md:184; temp/interim-d-wiring.md:8) |
| `command-evolution` | Lệnh `/memory`, `/skills`, `/journey`; timeline thuần đọc | lệnh + `scopeTimeline` | Người dùng gọi lệnh (packages/evolution/command-evolution/src/journey.ts:1-7) |
| `evolution-controller` | Cổng Remote cho client xa | các verb `read/timeline/follow…` | Gọi verb → kiểm tra scope (temp/interim-c-curator-controller-journey.md:6) |
| `evolution-curator` | Quản kho theo lịch | timer host-wide | Đủ 168 giờ + idle 2 giờ (specs/evolutionary-harness.spec.md:233) |
| `trajectory` + `scorer` | Vòng ngoài: xuất phiên, chấm corpus | `ctx.evolutionTrajectory`, `ctx.evolutionScorer` | Thủ công, không theo turn (packages/evolution/evolution-trajectory/README.md:12) |
| telemetry + `skill_manage` | Đếm dùng skill; viết file skill | `evolution_skill_usage` v1 | Đếm thụ động; viết dưới `$DSH_HOME/skills` (temp/interim-d-wiring.md:9) |

Hai quyết định wiring. Thứ nhất, *composition web-app-only*: "Evolution rows go in `web-app` bundle first, not `base`, so `headless`/`sdk`/`acp` snapshots stay byte-identical until explicitly adopted" (specs/evolutionary-harness.spec.md:47). Các dòng chỉ nằm trong `web-app cordis.patch.yml:102-146` với cấu hình bắt buộc `memory.capacityBytes`, `memory-context.maxBytes`, `controller.profile`, `scorer.corpusDir` (temp/interim-d-wiring.md:7). Gỡ dòng là tắt: "no records read, no brief, no extraction, sidebar falls back" (specs/evolutionary-harness.spec.md:284). Thứ hai, *machine-local*: "Both memory and skills stay machine-local under `$DSH_HOME`; neither writes inside the user's project directory" (specs/evolutionary-harness.spec.md:11). Với backend `storage-json`, mỗi scope là một tài liệu tại `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json` (specs/evolutionary-harness.spec.md:54); danh tính là một bản ghi mỗi `(profile, scope)` trong domain `evolution_memory` v1, khóa mờ `profile:workspaceId` hoặc `profile:global` (specs/evolutionary-harness.spec.md:54).

Ranh giới chống phình là bảng Parts: Instructions/Lessons/Profile/Context vừa tới model vừa tính capacity; Outputs chỉ là "a navigation index"; Staged là "pending until approved" (docs/subsystems/evolutionary-harness.md:11-18). Nhiều thứ được lưu nhưng chỉ bốn họ được bơm và tính tiền byte.

## 3. Cac flow van hanh end-to-end

Ba luồng gặp nhau tại hai điểm hẹn: `agent/pre-step` và `turn/end`. Thứ tự index→recall→gate là load-bearing, không được đảo (comparisons.md:9).

Luồng bơm tri thức (pre-step). Injector xác định phiên (registry sessionIds, rớt về canonical-cwd, có cache, dọn khi session/disposed), rồi qua cổng digest ba lớp: dấu trong bộ nhớ → batch đã nhận → bề mặt log; vắng bản ghi thì digest `empty`; `hasContent` false thì bơm nothing, tốn zero token (temp/interim-d-wiring.md:8; specs/evolutionary-harness.spec.md:184). Ngân sách `maxBytes` gồm cả khung: bỏ Context đuôi trước, cắt Lessons, rồi Profile, giữ Instructions cuối kèm thông báo, cắt an toàn UTF-8; file đọc lại lúc bơm, thiếu thì ghi unavailable nhưng step vẫn chạy; recall là một item `Recall:` render cuối nên bị loại đầu tiên (temp/interim-d-wiring.md:8).

Luồng quan sát (turn/end). Listener `session/event` rẽ nhánh: `turn/start` → `beginTurn` reset đệm; `turn/end` → `observeTurn` trong try/catch chỉ warn; còn lại → `bufferEvent` (temp/interim-b-reviewer.md:5). Trong `observeTurn`: resolve scope → `indexOutputs` (LUÔN) → recall → cổng extraction (`!enabled` dừng; text dưới `minTurnTextBytes` 200 dừng; cooldown 60000 ms chưa hết dừng; thiếu route warn-skip; ngược lại defer auto/never) (temp/interim-b-reviewer.md:6; specs/evolutionary-harness.spec.md:202). Trích xuất là deterministic: `temperature: 0`, tắt reasoning qua `purpose: 'evolution-review'`, `maxTokens: maxOutputTokens`, deadline qua `deadline(signal, timeoutMs)` (specs/evolutionary-harness.spec.md:212). Vòng phản hồi đóng kín về mặt cấu tạo — bài học chảy record→brief→model→turn→extraction→record với cùng một vị từ lọc ở hai đầu nên không tự khuếch đại (comparisons.md:15).

Luồng quản trị và vòng ngoài. Curator dùng timer host-wide mỗi 15 phút; lần đầu gieo `lastRunAt` rồi hoãn (temp/interim-c-curator-controller-journey.md:5). Controller phơi các verb `read/setLessons/timeline/follow…`, luôn kiểm tra scope trước (`workspace/not-found`) (temp/interim-c-curator-controller-journey.md:6). Trajectory xuất qua `exportSession`/`exportScope` ra `$DSH_HOME/evolution-trajectories`, ghi đè không nối thêm (temp/interim-d-wiring.md:5; packages/evolution/evolution-trajectory/README.md:12).

## 4. Khi nao trigger memory

Câu đinh: ghi memory (lessons/profile) luôn có cổng; mỗi turn chỉ *index outputs*, memory chỉ đổi khi extraction vượt cổng hoặc con người approve/rebuild (temp/interim-a-memory.md:12). Mọi khẳng định "mỗi turn đều ghi memory" đều sai — hai cơ chế chung điểm hẹn `turn/end` nhưng khác bản chất.

Ba đường ghi (temp/interim-a-memory.md:8): (a) trực tiếp từ controller/lệnh (`/memory approve`, `setLessons`, đổi instructions); (b) trích xuất nền `origin: 'background_review'` (hoặc staged `setLessons` khi bật `writeApproval`); (c) rebuild `origin: 'rebuild'`, luôn-direct ngay cả dưới `writeApproval` (temp/interim-b-reviewer.md:10).

Cổng extraction tại `observeTurn`: scope resolve được; reviewer `enabled` (tắt chỉ dừng extraction, indexing vẫn chạy); text được nhận đạt `minTurnTextBytes`; cooldown đã trôi; có route (specs/evolutionary-harness.spec.md:199; specs/evolutionary-harness.spec.md:202; temp/interim-b-reviewer.md:6). Transcript chỉ nhận `user/message` (`data.source.kind === 'user'`) và `assistant/message`; ngữ cảnh đã bơm không bao giờ đưa ngược lại (specs/evolutionary-harness.spec.md:204). Defer `auto` gộp một snapshot mỗi session, deadline `deferMaxAgeMs` 1800000; dispose thì bỏ (temp/interim-b-reviewer.md:9). Rebuild bỏ archived, lấy lát `rebuildSessionLimit` 20 mới nhất qua `admittedRow` chỉ-người (temp/interim-b-reviewer.md:10).

Phía store: đọc đồng bộ tách rời; trần kiểm tra trước ghi; ghi bị từ chối thì không đột biến bản ghi (temp/interim-a-memory.md:5). `setInstructions` chỉ kiểm tra capacity; `setLessons/setUserProfile` cộng extraction và đóng dấu; `addLesson` trùng thì no-write; `replace/removeLesson` theo chuỗi con duy nhất (temp/interim-a-memory.md:7). Digest là sha1 của instructions, lessons, profile, contextItems; capacity bằng các họ đó cộng tổng `sizeBytes`, loại trừ outputs/staged/resolutions (temp/interim-a-memory.md:10; specs/evolutionary-harness.spec.md:111).

## 5. Khi nao trigger luu output vao evolution

Lưu output (indexing) *luôn chạy* mỗi turn kết thúc: "Completed turns trigger extraction; output indexing always runs" (packages/evolution/evolution-reviewer/README.md:40). Chuỗi gọi là `ctx.on('session/event', …)` lọc tới `turn/end`, resolve scope; một lần quét ngược tới `turn/start` gần nhất nuôi cả indexing (luôn) lẫn extraction (khi qua cổng) (specs/evolutionary-harness.spec.md:199).

Bộ lọc "output nào đáng lưu": thuộc `outputTools` (họ write/edit/str_replace_editor), kết quả không lỗi, đường dẫn từ `file_path || path`, str_replace_editor bỏ qua `view/undo_edit`, resolve theo cwd, chỉ giữ file trong scope (`isInside`) (temp/interim-b-reviewer.md:7).

Phía store, `recordOutputs` CHỈ bắn từ `indexOutputs`; rỗng thì noop, không đổi thì no-write/no-churn, vắng thì seed+put; trộn newest-first, trần `maxOutputs` 200, lũy đẳng (temp/interim-a-memory.md:9). Vì Outputs không tới model và không tính capacity (docs/subsystems/evolutionary-harness.md:11-18), đây là chỉ mục điều hướng cho `/journey` — và là lý do `enabled:false` chỉ tắt extraction chứ không tắt reviewer (temp/interim-b-reviewer.md:12).

## 6. Evolution timeline hoat dong the nao

Timeline không bao giờ được "ghi" — nó được suy ra mới mỗi lần đọc (temp/interim-c-curator-controller-journey.md:12): "Read model and rendering behind `/journey`: one scope's recorded evolution activity, bucketed on the dashboard calendar (UTC+7)… The model is pure — the command supplies the record it already read, so this module touches neither storage nor the session log, and the Remote controller reuses it unchanged" (packages/evolution/command-evolution/src/journey.ts:1-7). Chống lệch bằng "read model lives once": `scopeTimeline` import từ `dsh-command-evolution` nên text `/journey` và verb timeline không bao giờ bất đồng (packages/evolution/evolution-controller/README.md:93).

Đầu vào là `TimelineInput{record, usedBytes, capacityBytes, digest, range, now}`; delta tăng dần gồm dấu instructions, dấu lessons/profile (dự phòng `lastExtraction`, rồi `memoryUpdatedAt` → hand-edit), mỗi `contextItems.addedAt`, mỗi `outputs.at`, mỗi `staged.createdAt`; extraction qua khớp `extraction.at`; resolutions đếm theo ngày; gom ô theo `dayKey` UTC+7, biên zero-filled, tích lũy độc lập range; pending từ `record.staged` (temp/interim-c-curator-controller-journey.md:8). Hệ quả: mỗi hàng timeline truy về đúng một dấu; chuỗi dự phòng stamps → lastExtraction → memoryUpdatedAt phải nêu để tránh hiểu lầm "mất ngày" (comparisons.md:21).

Người dùng chạm timeline qua `/journey [today|7d|30d|all]` (mặc định 7d) và `/journey export` (ghép `timeline.json` + `session-log.jsonl` thành zip dưới `$DSH_HOME/exports`) (temp/interim-c-curator-controller-journey.md:7). Trục dài hạn do curator bổ sung: `active → stale (30d) → archived (90d)` theo `idleMs` từ `lastUsedAt ?? createdAt`, bỏ qua pinned/protected/hub (temp/interim-c-curator-controller-journey.md:5; specs/evolutionary-harness.spec.md:235); sao lưu tar.gz giữ 5 bản, ledger JSONL định địa chỉ theo nội dung, purge chỉ archived quá TTL (temp/interim-c-curator-controller-journey.md:5).

## 7. Tat ca nhung thu lien quan con lai

Lệnh quản trị chia hai hàng đợi, một triết lý sổ cái: hàng memory sửa bản ghi, hàng skill sửa file rồi mới đánh rơi mục (comparisons.md:27). `/memory pending|approve|reject` (skill-kind chuyển sang `/skills`); `/skills pending|approve` (đánh rơi sau khi `skill_manage` đã ghi file); `/curator status|run|adopt|purge|rollback|ledger|pin|unpin`; `/refine` gọi `reviewer.rebuild` ngay; `/trajectory` gọi exporter; `/suggestions` chỉ liệt kê, không lên lịch (temp/interim-c-curator-controller-journey.md:7). Chỉ `origin: 'background_review'` đặt `createdBy: 'agent'`; tạo foreground là người dùng chỉ đạo nên không tự quản; pin chặn delete/transitions (specs/evolutionary-harness.spec.md:131).

Recall là tầng memory yếu nhất theo thiết kế: một item `Recall:`, render cuối, bị loại đầu tiên, `recallLimit` 20, cùng luật nhận, không seam thì không item (comparisons.md:33; temp/interim-d-wiring.md:8). Telemetry `evolution_skill_usage` v1 đếm use/view/patch, chỉ `markAgentCreated` khi origin background_review, loại trừ bundled/hub*; đường dẫn chuẩn hóa lặp từ 3 lần thì đề xuất skill mà không đọc nội dung (temp/interim-d-wiring.md:9). `skill_manage` viết trên `$DSH_HOME/skills`, vá theo chuỗi con duy nhất, pin chặn xóa chứ không chặn vá, từ chối bundled/hub (temp/interim-d-wiring.md:9). Trajectory tạo hình ShareGPT thuần qua `toShareGpt` (một conversation mỗi turn, chỉ khối text, tool-call dạng `<tool_call>`) (temp/interim-d-wiring.md:5). Scorer chấm bộ ba pass/tokens/thời gian, runner replay không ghi (temp/interim-d-wiring.md:6).

## 8. Ket luan va cach tra cuu tiep

Bằng chứng ủng hộ ba kết luận. Một, harness học mà không vá lõi: bản ghi theo scope, brief thay khi digest đổi, extraction có cổng, curator theo lịch, vòng ngoài tách rời (packages/evolution/README.md:12; packages/evolution/evolution-trajectory/README.md:12). Hai, hai trigger tách đôi tại cùng điểm hẹn: memory gated, output always — thứ tự index→recall→gate là load-bearing (comparisons.md:9; temp/interim-a-memory.md:12). Ba, timeline là read model thuần túy từ dấu thời gian, sống một lần trong `dsh-command-evolution` (packages/evolution/command-evolution/src/journey.ts:1-7; packages/evolution/evolution-controller/README.md:93).

Giới hạn vận hành: web-only trước, `headless`/`sdk`/`acp` giữ byte-identical tới khi nhận (specs/evolutionary-harness.spec.md:47); machine-local dưới `$DSH_HOME` (specs/evolutionary-harness.spec.md:11); tắt là gỡ dòng — không bản ghi, không brief, không extraction (specs/evolutionary-harness.spec.md:284). Tra cứu tiếp: thắc mắc brief thì đọc digest và bốn họ capacity (specs/evolutionary-harness.spec.md:111; specs/evolutionary-harness.spec.md:184); hỏi "ngày X xảy ra gì" thì mở `/journey`, mỗi hàng một stamp (comparisons.md:21); can thiệp thì qua `/memory` và `/skills` thay vì sửa store (comparisons.md:27).

*Thuật ngữ nhanh:* scope (phạm vi nhớ), record (JSON mỗi scope), brief (tóm tắt bơm vào model), digest (băm quyết định bơm mới), staged (hàng đợi duyệt), recall (item nhớ lại yếu nhất), trajectory (file hội thoại cho eval), scorer (bộ chấm pass/tokens/thời gian).

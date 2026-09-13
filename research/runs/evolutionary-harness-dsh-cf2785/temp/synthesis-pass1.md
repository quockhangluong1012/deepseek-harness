# Synthesis pass 1 — evolutionary-harness-dsh-cf2785 (rough integrated draft)

## 1. Bức tranh tổng thể evolutionary harness

Hãy hình dung evolutionary harness như cuốn sổ tay mà trợ lý tự ghi sau mỗi ca làm, kèm một thủ thư quyết định dòng nào đáng ghi, một phiếu nhắc bài cắt ra dán trước ca sau, và một tờ lịch treo tường suy ra từ sổ — không phải cuốn sổ thứ hai. Sổ nằm riêng trên máy; gỡ nó ra thì harness trở về hành vi cũ nguyên vẹn từng byte.

Về kỹ thuật:

> "The evolution family adds a closed learning loop on top of the harness without patching a privileged core: durable per-scope memory records with staged writes, background turn review, scheduled skill curation, and long-horizon safety rails." — `packages/evolution/README.md:12`

> "Every learned write is capped, staged when configured, logged, and rollback-capable; removing the rows restores byte-identical legacy behaviour." — `packages/evolution/README.md:12`

Bốn từ dùng suốt báo cáo này. **Record** là sổ tay bền vững cho mỗi cặp `(profile, scope)` trong domain `evolution_memory`. **Brief** là phiếu nhắc bài cắt ra từ sổ, tiêm vào model trước mỗi bước. **Staged** là đề xuất ghi đang chờ duyệt — chưa duyệt thì chưa thành tri thức. **Timeline / journey** là lịch treo tường suy ra từ sổ, không sinh sự kiện riêng.

Evolution là **lớp cộng thêm có thể gỡ**. Hàng composition chỉ nằm ở bundle `web-app` nên các snapshot khác giữ nguyên tới khi nhận:

> "Evolution rows go in `web-app` bundle first, not `base`, so `headless`/`sdk`/`acp` snapshots stay byte-identical until explicitly adopted." — `specs/evolutionary-harness.spec.md:47`

Mọi thứ machine-local dưới `$DSH_HOME`, không ghi vào thư mục project của người dùng (`specs/evolutionary-harness.spec.md:11`); gỡ là xóa rows — không record đọc, không brief, không extraction (`specs/evolutionary-harness.spec.md:284`).

Ở tầm kiến trúc, harness là **ba vòng thời gian lồng nhau**, không phải một pipeline thẳng. Vòng **turn** tính bằng giây (bơm brief → hành động → index output → có thể trích xuất). Vòng **ngày/tuần** (duyệt → sổ resolutions → ô lịch journey → áp lực dung lượng). Vòng **tháng/quý** (curator chuyển trạng thái → xuất trajectory → chấm scorer → dữ liệu vòng ngoài). Chỉ hai chất keo nối ba vòng: **digest** của brief và các **stamps** của record cộng sổ ledger. Đây là luận điểm trung tâm của báo cáo: mọi turn đều **lưu output** (always-on indexing), chỉ turn vượt gate mới **ghi memory** (gated extraction), và timeline **không bao giờ được ghi** — nó được suy ra mỗi lần đọc từ các stamp của record.

Một điểm dễ rối cần gỡ ngay: brief, recall và compaction (squeeze) đều xử lý chuyện "context chật thì sao" nhưng ở ba tầng khác nhau. Brief là tờ phiếu nhắc việc đầy đủ được tiêm trước mỗi step khi digest đổi (`specs/evolutionary-harness.spec.md:184`); recall chỉ là một item yếu nhất tên Recall, render sau cùng và bị bỏ đầu tiên khi chật; còn squeeze là cơ chế nén bên trong brief khi vượt `maxBytes` — xả References trước, cắt an toàn UTF-8 và gắn cờ truncated (`packages/evolution/evolution-reviewer/src/index.ts:992-1024`). Nói gọn: brief quyết định *có tiêm hay không*, squeeze quyết định *tiêm bao nhiêu*, recall quyết định *phần nào bị hy sinh trước*.

## 2. Kiến trúc 7 package và vai trò từng khối

Coi evolution như khu nhà 7 gian, cộng hành lang bơm brief (injector) và phòng kế toán (telemetry/manage). Bảng tra cứu dưới đây giữ đầy đủ 8 hàng: *ctx key* là tên dịch vụ các plugin khác thấy qua context Cordis, *trigger* là điều kiện rút gọn (chi tiết ở §4–§6).

| Package | Vai trò | ctx key | Trigger rút gọn |
|---|---|---|---|
| `evolution-memory` | Kho bản ghi theo scope (thủ kho) | `ctx.evolutionMemory` | Lệnh/controller; extraction nền; rebuild |
| `evolution-reviewer` | Quan sát turn: luôn index, hiếm khi trích xuất (người xem lại băng) | listener `session/event` | `turn/end` → `observeTurn` + 4 cổng (`specs/evolutionary-harness.spec.md:199`; `specs/evolutionary-harness.spec.md:202`) |
| `memory-context` (injector) | Bơm brief trước mỗi step | hook `agent/pre-step` | Digest đổi mới bơm (`specs/evolutionary-harness.spec.md:184`) |
| `command-evolution` | Lệnh `/memory`, `/skills`, `/journey`; timeline thuần đọc (quầy lễ tân) | lệnh + `scopeTimeline` | Người dùng gọi lệnh (`packages/evolution/command-evolution/src/journey.ts:1-7`) |
| `evolution-controller` | Cổng Remote cho client xa (tổng đài) | các verb `read/setInstructions/setLessons/setProfile/addContextItem/removeContextItem/rebuildMemory/listStaged/approveStaged/rejectStaged/timeline/follow` | Gọi verb → kiểm tra scope trước (`workspace/not-found`), staged scope-checked (`staged-not-found`) |
| `evolution-curator` | Quản kho theo lịch (quản thư) | timer host-wide | Đủ 168 giờ + idle 2 giờ (`specs/evolutionary-harness.spec.md:233`) |
| `trajectory` + `scorer` | Vòng ngoài: xuất phiên, chấm corpus (người đóng thùng + giám khảo) | `ctx.evolutionTrajectory`, `ctx.evolutionScorer` | Thủ công, không theo turn (`packages/evolution/evolution-trajectory/README.md:12`) |
| telemetry + `skill_manage` | Đếm dùng skill; viết file skill | `evolution_skill_usage` v1 | Đếm thụ động; viết dưới `$DSH_HOME/skills` |

Một câu phân công phải nói rõ để tránh nhầm: **brief injector (`dsh-evolution-memory-context`, nhóm context) là nơi render phiếu brief model-visible; controller chỉ sửa bản ghi record cho người/Web**. Controller phơi đầy đủ verbs `read/setInstructions/setLessons/setProfile/addContextItem/removeContextItem/rebuildMemory/listStaged/approveStaged/rejectStaged/timeline/follow`, scope-first qua `requireWorkspace`, staged scope-checked; vì `scopeTimeline` import từ `dsh-command-evolution` nên text `/journey` và verb `timeline` không bao giờ lệch nhau (`packages/evolution/evolution-controller/README.md:93`).

Đơn vị nhỏ nhất của toàn hệ là một bản ghi cho mỗi `(profile, scope)` trong domain `evolution_memory`, version `1`, bố cục `per-record`, bảng `records`, khóa bằng id mờ `profile:workspaceId` hoặc `profile:global` (`specs/evolutionary-harness.spec.md:54`). Với backend `storage-json`, đó là một document tại `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json` (cùng nguồn). Đọc đồng bộ detached, check caps trước ghi, write bị từ chối thì không mutate (`packages/evolution/evolution-memory/src/index.ts:2-12`, `packages/evolution/evolution-memory/src/index.ts:551-555`).

Ranh giới chống phình là bảng Parts (`docs/subsystems/evolutionary-harness.md:11-18`): Instructions, Lessons, Profile, Context → vừa lên model vừa tính capacity; Outputs ("navigation index") và Staged (pending until approved) → không lên model, không tính capacity. Chỉ kinh nghiệm đã duyệt mới tốn token và chỗ. Composition chỉ ở `web-app` (`cordis.patch.yml:102-146`): memory `capacityBytes 131072`, memory-context `maxBytes 16384`; thiếu `memory.capacityBytes`, `memory-context.maxBytes`, `controller.profile`, `scorer.corpusDir` thì fail loud.

Hai quyết định wiring giải thích vì sao hệ an toàn để thử. Thứ nhất, *composition web-app-only* như đã trích ở §1 (`specs/evolutionary-harness.spec.md:47`). Thứ hai, *machine-local* (`specs/evolutionary-harness.spec.md:11`). Tắt là xóa hàng: không đọc bản ghi, không brief, không extraction, sidebar về fallback (`specs/evolutionary-harness.spec.md:284`).

*Thuật ngữ nhanh (6 từ):* **scope** (phạm vi nhớ: profile + workspace/global), **record** (JSON bền vững mỗi scope), **brief** (phiếu tóm tắt bơm vào model), **digest** (băm quyết định có bơm brief mới), **staged** (hàng đợi duyệt), **timeline/journey** (lịch đọc suy ra từ stamps, không lưu riêng).

## 3. Các flow vận hành end-to-end

Mọi flow gặp nhau ở hai điểm hẹn — `agent/pre-step` (bơm tri thức) và `turn/end` (quan sát) — với thứ tự load-bearing **index → recall → gate**, không được đảo. Hiểu thứ tự này là hiểu toàn bộ harness: kiểm kê thành phẩm trước (index), hỏi lại trí nhớ ngắn (recall), rồi mới xét có đáng ghi kinh nghiệm không (gate).

**Luồng bơm tri thức (pre-step, trước mỗi step).** Plain-language: trước khi model hành động, injector dán một tờ phiếu nhắc việc lên đầu prompt — nhưng chỉ khi sổ đã đổi. Injector xác định phiên (registry `sessionIds`, rớt về canonical-cwd, có cache, dọn khi `session/disposed`), rồi qua cổng digest ba lớp: dấu trong bộ nhớ → batch đã nhận → bề mặt log; vắng bản ghi thì digest `'empty'`; `hasContent` false thì bơm nothing, tốn zero token (`specs/evolutionary-harness.spec.md:184`). Ngân sách `maxBytes` gồm cả khung: bỏ Context đuôi trước, cắt Lessons, rồi Profile, giữ Instructions cuối kèm notice line, cắt an toàn UTF-8; file đọc lại lúc bơm, thiếu thì ghi unavailable nhưng step vẫn chạy; recall là một item `Recall:` render cuối nên bị loại đầu tiên. Phía đọc (brief injector) chạy trên hook `agent/pre-step`, membership qua registry rồi fallback canonical-cwd, triple digest gate. Một brief mỗi Session, thay khi đổi.

**Luồng quan sát (turn/end, sau mỗi turn).** Plain-language: chuông hết ca reo, thủ kho nhặt thành phẩm trước, rồi mới hỏi có nên ghi kinh nghiệm vào sổ không. Listener `session/event` rẽ nhánh: `turn/start` → `beginTurn` reset đệm; `turn/end` → `observeTurn` trong try/catch chỉ warn; còn lại → `bufferEvent` (`packages/evolution/evolution-reviewer/src/index.ts:392-394`, `packages/evolution/evolution-reviewer/src/index.ts:490-500`, `packages/evolution/evolution-reviewer/src/index.ts:596-628`). Turn đang bay vẫn góp hậu tố đã quan sát (`packages/evolution/evolution-reviewer/src/index.ts:8-12`). Trong `observeTurn`: resolve scope → `indexOutputs` (LUÔN) → `recallQueryOf` → cổng extraction (`!enabled` dừng; text dưới `minTurnTextBytes` 200 dừng; cooldown `60000` ms chưa hết dừng; thiếu route warn-skip; ngược lại defer auto/never) (`packages/evolution/evolution-reviewer/src/index.ts:630-656`; `specs/evolutionary-harness.spec.md:202`). Defer auto gom một snapshot mỗi session, deadline `deferMaxAgeMs 1800000`; disposal/teardown thì drop (`packages/evolution/evolution-reviewer/src/index.ts:718-772`). Cuộc gọi vượt gate là deterministic: `temperature: 0`, tắt reasoning qua `purpose: 'evolution-review'`, `maxTokens: maxOutputTokens`, deadline qua `deadline(signal, timeoutMs)` (`specs/evolutionary-harness.spec.md:212`); hết token thì `truncated: true`, khối tool-call thì reject; input quá 131072 thì bỏ cũ nhất (`packages/evolution/evolution-reviewer/src/index.ts:942-973`, `packages/evolution/evolution-reviewer/src/index.ts:329-340`).

| Bước turn | Sự kiện và hàm | Điều gì xảy ra |
|---|---|---|
| 1. Mở và đệm turn | `turn/start` gọi `beginTurn`; sự kiện khác gọi `bufferEvent` | Reset buffer; không quét lại lịch sử (`packages/evolution/evolution-reviewer/src/index.ts:392-394`, `packages/evolution/evolution-reviewer/src/index.ts:490-500`) |
| 2. Đóng turn | `turn/end` gọi `onTurnEnd` rồi `observeTurn` trong try/catch chỉ warn | Điểm hẹn duy nhất của cả hai đường (`packages/evolution/evolution-reviewer/src/index.ts:596-628`) |
| 3. Scope và index | Resolve scope rồi quét ngược tới `turn/start` gần nhất | Không scope thì return; index luôn chạy, không qua gate (`specs/evolutionary-harness.spec.md:199`, `packages/evolution/evolution-reviewer/README.md:40`) |
| 4. Recall và gate | `recallQueryOf` rồi chuỗi gate nối tiếp | Rớt gate nào thì dừng (`packages/evolution/evolution-reviewer/src/index.ts:630-656`) |
| 5. Defer và gọi | Defer auto gom một snapshot mỗi session, deadline 1800000, dispose thì bỏ; gọi với nhiệt độ 0, tắt reasoning, bỏ cũ nhất khi quá tải | Deterministic (`specs/evolutionary-harness.spec.md:212`) |

Vòng phản hồi đóng kín về mặt cấu tạo — bài học chảy record → brief → model → turn → extraction → record với cùng một vị từ lọc (predicate) ở hai đầu nên không tự khuếch đại. Nói cụ thể: brief đã tiêm và instructions không bao giờ được đưa ngược lại transcript extraction, nên hệ không tự học từ chính lời nhắc của mình.

**Luồng ngày/tuần (governance).** `/memory pending` hoặc `/skills pending` xem hàng chờ; `approve`/`reject` ghi resolutions ledger (newest-first, cap `maxResolutions`). `/journey` đọc record, đếm resolutions theo decision day, xếp bucket UTC+7, hiện capacity + staged hint. Đây là vòng con người vào cuộc: máy đề xuất, người quyết.

**Luồng tháng/quý (vòng ngoài).** Curator tick 15 phút, host idle đủ lâu thì survey skill agent-tạo, chuyển trạng thái, backup tar.gz giữ 5 bản, ghi JSONL ledger. `/trajectory` export scope thành ShareGPT dưới `$DSH_HOME/evolution-trajectories`, overwrite-not-append. Scorer chạy thủ công: đọc `input.json` + fixture + `replay.override.json` + `workspace/expected`, trả pass / billed tokens / median wall time. Vòng 1 nối bằng digest, vòng 2 bằng stamps + ledger, vòng 3 bằng telemetry + backups.

## 4. Khi nào trigger memory

Câu đầu tiên phải giết một ngộ nhận phổ biến: **"mỗi turn đều ghi memory" là sai**. Mỗi turn chỉ index outputs; lessons/profile chỉ đổi qua ba đường, và đường tự động duy nhất luôn có cổng. Công thức dual-gate gói trong hai câu:

> "Completed turns trigger extraction; output indexing always runs" — `packages/evolution/evolution-reviewer/README.md:40`

> "`ctx.on('session/event', …)` filtered to `turn/end`. Resolve scope, return when none. One backward scan to most recent `turn/start` feeds output indexing (always) and extraction (when gated)." — `specs/evolutionary-harness.spec.md:199`

Gate loại trừ:

> "Skipped when `review.enabled` false, cooldown unelapsed, or admitted text under `minTurnTextBytes`." — `specs/evolutionary-harness.spec.md:202`

| Điều kiện trigger | Hành động | Nơi lưu |
|---|---|---|
| `turn/end`, resolve được scope (`specs/evolutionary-harness.spec.md:199`) | Vào `observeTurn`; sau đó `indexOutputs` luôn chạy (`packages/evolution/evolution-reviewer/README.md:40`) | Scope hiện tại, trường `outputs` |
| `review.enabled` false, text dưới 200 bytes, cooldown 60s chưa hết, hoặc thiếu route (`specs/evolutionary-harness.spec.md:202`, `packages/evolution/evolution-reviewer/src/index.ts:630-656`) | Return sớm từng gate, giữ output index | Không ghi lesson hay profile |
| Vượt mọi gate, defer auto (`packages/evolution/evolution-reviewer/src/index.ts:718-772`) | Gom một snapshot mỗi session, deadline đầu 1800000, teardown thì bỏ | Hàng đợi defer trong bộ nhớ |
| Gọi extraction (`specs/evolutionary-harness.spec.md:212`, `packages/evolution/evolution-reviewer/src/index.ts:942-973`, `packages/evolution/evolution-reviewer/src/index.ts:329-340`) | `temperature: 0`, tắt reasoning qua `purpose: 'evolution-review'`, input quá 131072 thì bỏ cũ nhất; hết token thì `truncated: true`, khối tool-call thì reject | `lastExtraction` gồm at, sessionId, provider, model, origin, inputBytes, truncated |
| Transcript extraction (`specs/evolutionary-harness.spec.md:204`) | Chỉ nhận human `user/message` có `data.source.kind === 'user'` và `assistant/message`; brief và instruction không đưa ngược lại | Chống ngộ độc vòng lặp |
| Ghi trực tiếp (`packages/evolution/evolution-memory/src/index.ts:2-12`, `packages/evolution/evolution-memory/src/index.ts:551-555`) | `setInstructions` chỉ chạm capacity; `setLessons` và `setUserProfile` cộng extraction và stamp; `addLesson` trùng thì no-write; `replace` và `removeLesson` đòi chuỗi con duy nhất | Bản ghi `evolution_memory`, caps kiểm tra trước ghi |
| Extraction nền (`specs/evolutionary-harness.spec.md:131`) | Ghi với `origin: 'background_review'`, đặt `createdBy: 'agent'`; bật `writeApproval` thì qua `staged` chờ `approveStaged` | Chỉ origin nền mới đặt agent |
| Rebuild thủ công (`packages/evolution/evolution-reviewer/src/index.ts:427-513`, `packages/evolution/evolution-reviewer/src/index.ts:457-482`) | Bỏ archived, slice newest-first giới hạn 20, chỉ hàng human, thiếu route thì extraction-failed, luôn-direct ngay cả dưới `writeApproval` | Ghi thẳng bản ghi |

Ba đường ghi memory, nói gọn: (a) **trực tiếp từ con người** — `/memory approve`, `setLessons`, `setUserProfile`, `addContextItem` gọi thẳng store verbs; foreground user-directed, không auto-manage; file contexts resolve + canonicalize trong workspace kèm `sizeBytes`. (b) **trích xuất nền** `origin: 'background_review'` (hoặc staged `setLessons` khi bật `writeApproval`); chỉ origin này set `createdBy: 'agent'` (`specs/evolutionary-harness.spec.md:131`); dưới `writeApproval` thì vào staged chờ `approveStaged`. (c) **rebuild** `origin: 'rebuild'`, luôn-direct ngay cả dưới `writeApproval`; bỏ archived, slice newest-first `rebuildSessionLimit 20`, qua `admittedRow` human-only; không route thì `extraction-failed` (`packages/evolution/evolution-reviewer/src/index.ts:427-513`, `packages/evolution/evolution-reviewer/src/index.ts:457-482`).

Phía store: đọc đồng bộ tách rời; trần kiểm tra trước ghi; ghi bị từ chối thì không đột biến bản ghi. `setInstructions` chỉ kiểm tra capacity; `setLessons/setUserProfile` cộng extraction và đóng dấu; `addLesson` trùng thì no-write; `replace/removeLesson` theo chuỗi con duy nhất. Digest là sha1 của instructions, lessons, profile, contextItems; capacity bằng các họ đó cộng tổng `sizeBytes`, loại trừ outputs/staged/resolutions (`specs/evolutionary-harness.spec.md:111`).

Trigger đọc (brief injector): hook `agent/pre-step`, membership qua registry `sessionIds` rồi fallback canonical-cwd, triple digest gate. Ngân sách `maxBytes` gồm frame: drop trailing Context → truncate Lessons → Profile → Instructions cuối + notice line. Recall là một item duy nhất, render cuối nên drop đầu khi chật — tier yếu nhất.

Ví dụ phân biệt: turn sửa chính tả rồi lưu file luôn thêm mục output, nhưng text ngắn (dưới 200 bytes) nên lessons đứng yên. Turn thảo luận dài 3KB rồi refactor ba file thì vượt ngưỡng, qua cooldown và có thể đề xuất lesson mới — nhưng lesson đó vẫn nằm ở staged nếu bật duyệt, chỉ khi approve trong `/memory` thì sổ mới đổi.

## 5. Khi nào trigger lưu output vào evolution

Nếu §4 là ghi kinh nghiệm, §5 là lưu dấu vết thành phẩm. Coi outputs như kệ ảnh chụp thành phẩm: giúp tìm lại file đã chạm, nhưng không dạy model và không tính capacity (`docs/subsystems/evolutionary-harness.md:11-18`).

Trigger lưu output chạy luôn sau mỗi `turn/end` đã resolve scope, không qua gate extraction (`packages/evolution/evolution-reviewer/README.md:40`, `specs/evolutionary-harness.spec.md:199`). Hàm `recordOutputs` chỉ được gọi từ `indexOutputs` — đây là caller duy nhất — với đầy đủ chuỗi lọc, hợp nhất newest-first, chặn trần `maxOutputs` 200 và idempotent.

| Điều kiện trigger (bộ lọc `producedEntry`) | Hành động | Nơi lưu |
|---|---|---|
| Tool trong `outputTools` như write, edit và `str_replace_editor` (`packages/evolution/evolution-reviewer/src/index.ts:275-293`, `packages/evolution/evolution-reviewer/src/index.ts:841-902`) | Chấp nhận ứng viên thành `producedEntry` | Đầu vào `recordOutputs` |
| Outcome không lỗi, có path từ `file_path` hoặc `path` (cùng nguồn) | Loại turn lỗi, loại event không path | Bỏ qua |
| `str_replace_editor` bỏ view/undo_edit; resolve theo cwd với realpath fallback; chỉ giữ file trong scope `isInside` (cùng nguồn) | Loại thao tác chỉ xem, loại file ngoài scope | Chỉ file trong scope |
| Danh sách rỗng, mục trùng, hoặc mục mới (không tính capacity: `docs/subsystems/evolutionary-harness.md:11-18`) | Rỗng thì noop; trùng thì no-write; mới thì seed rồi put, cắt 200 mục mới nhất | `outputs` newest-first `{path, tool, sessionId, at}` |

Mỗi `turn/end`, reviewer quét ngược tới `turn/start` gần nhất, nhặt file đã ghi vào `outputs` newest-first; `enabled:false` vẫn index, chỉ return khi mất scope. Store-side idempotent: rỗng noop, không đổi no-write, vắng seed+put; `mergeOutputs` newest-first cap `maxOutputs` 200. Vì outputs off-model/off-capacity, index luôn-chạy thì rẻ, extraction hiếm-chạy thì đắt nên gated — cặp "luôn-index vs hiếm-extract" là toàn bộ lý do kinh tế của thiết kế dual-gate. Và là lý do `enabled:false` chỉ tắt extraction chứ không tắt reviewer.

Ví dụ: turn tạo `src/auth/login.ts` bằng write và sửa `README.md` bằng edit thì thêm hai mục mới `{path, tool, sessionId, at}`. Turn chỉ xem file bằng view thì không thêm gì. Ngay cả khi `review.enabled` tắt, kiểm kê output vẫn chạy — sổ ảnh vẫn đầy, chỉ sổ kinh nghiệm đứng yên.

## 6. Evolution timeline hoạt động thế nào

Mệnh đề mở đầu, cũng là câu quan trọng nhất của mục này: **timeline không bao giờ được "ghi" — nó được suy ra mỗi lần đọc.** Không có bảng timeline trong storage, không có event timeline trong session log.

> "Read model and rendering behind `/journey`: one scope's recorded evolution activity, bucketed on the dashboard calendar (UTC+7)… The model is pure — the command supplies the record it already read, so this module touches neither storage nor the session log, and the Remote controller reuses it unchanged." — `packages/evolution/command-evolution/src/journey.ts:1-7`

> "**The read model lives once.** `scopeTimeline` is imported from `dsh-command-evolution`, so `/journey` text and the timeline verb can never disagree about a bucket." — `packages/evolution/evolution-controller/README.md:93`

**Ví dụ một ngày của An** (profile `web-app`, workspace `shop`, ngày 12/09 — giữ gần nguyên văn để cơ chế read-model "click"). 09:00 An sửa `cart.ts`: reviewer index `{path: cart.ts, at: 09:01}` vào `outputs`; text turn chỉ 120 bytes nên extraction skip — sổ ảnh có thêm, sổ kinh nghiệm đứng yên. 10:30 An thảo luận dài 3KB về quy ước giảm giá rồi refactor: vượt gate (đủ text, qua cooldown, có route), đề xuất lesson vào staged (`createdAt 10:31`) — tri thức đang chờ, chưa thành. 14:00 An mở `/memory pending` xem hàng chờ rồi `/memory approve`: lesson được apply vào `agentLessons`, ghi resolution `{approve, at: 14:02}` vào ledger. 15:00 An gọi `/journey 7d`: lệnh gọi `scopeTimeline({record, usedBytes, capacityBytes, digest, range: '7d', now})`, suy ra deltas — lesson từ stamp 14:02, outputs từ `at 09:01`, staged đã rỗng, resolutions theo decision day 12/09 — xếp bucket `dayKey` UTC+7, render một dòng ngày + capacity + hint 0 pending. 22:00 host idle nhưng `intervalHours 168` chưa hết nên curator defer — đêm yên tĩnh, không chuyển trạng thái nào. Một ngày ba nhịp: sáng kiểm kê, trưa đề xuất, chiều duyệt thành lịch.

Cơ chế suy ra (`packages/evolution/command-evolution/src/journey.ts:1-15`): input `TimelineInput{record, usedBytes, capacityBytes, digest, range, now}`; `recordDeltas` ascending gồm instructions stamp, lessons/profile stamps (fallback `lastExtraction` → một lessons delta, else `memoryUpdatedAt` → hand-edit), mỗi `contextItems.addedAt`, mỗi `outputs.at`, mỗi `staged.createdAt`; provenance qua `extraction.at` match else hand-edit; resolutions đếm theo ngày quyết định; gom ô theo `dayKey` UTC+7, biên zero-filled, tích lũy độc lập range; pending từ `record.staged`.

| Con dấu (stamp) | Loại delta | Quy tắc bucket |
|---|---|---|
| `UpdatedAt`, `addedAt`, `at`, `createdAt`, `resolution.at` | Mỗi stamp một sự kiện | Ngày UTC+7 của chính stamp |
| `lastExtraction.at`, rồi `memoryUpdatedAt` dẫn xuất | Hai tầng dự phòng | Dùng khi thiếu delta mịn; phải nêu rõ để tránh hiểu lầm ngày trống |

Hệ quả phải nhớ: mỗi hàng timeline truy về đúng một stamp; chuỗi dự phòng stamps → lastExtraction → memoryUpdatedAt phải nêu rõ để tránh hiểu lầm "mất ngày". Người dùng chạm timeline qua `/journey [today|7d|30d|all]` (mặc định `7d`) và `/journey export` (ghép `timeline.json` + `session-log.jsonl` thành zip dưới `$DSH_HOME/exports`).

Tầng tháng/quý khép bằng curator và trajectory. Curator chạy theo nhịp không hoạt động với `intervalHours: 168` và `minIdleHours: 2` (`specs/evolutionary-harness.spec.md:233`), chuyển `active → stale (30d) → archived (90d)` vào `.archive/` (`specs/evolutionary-harness.spec.md:235`). Trajectory: mỗi Session xong thành file ShareGPT cho eval và RL (`packages/evolution/evolution-trajectory/README.md:12`); session không message được admission thì xuất mảng rỗng thay vì lỗi (cùng nguồn); rồi scorer chấm bộ ba diff workspace, token metering và median wall time. Brief mỗi session cùng họ read-model: digest so newest visible `source.kind === 'evolution-memory'`, bằng thì nothing, khác/vắng thì một brief fresh (`specs/evolutionary-harness.spec.md:184`); digest chỉ cover instructions, lessons, profile, context (`specs/evolutionary-harness.spec.md:111`).

## 7. Tất cả những thứ liên quan còn lại

Nhóm này gom các bề mặt dễ nhầm thành trí nhớ dài hạn, dù mỗi thứ chỉ là mắt xích phụ. Nguyên tắc chung: nhiều thứ được lưu, ít thứ được bơm; nhiều thứ được đề xuất, ít thứ tự động thành tri thức.

**Hai hàng chờ, một triết lý sổ cái.** `/memory` sửa trực tiếp bản ghi, `/skills` sửa file rồi mới đánh rơi mục.

| Hàng đợi | Sửa cái gì | Khi nào drop | Ghi chú |
|---|---|---|---|
| `/memory pending\|approve\|reject` (memory ops) | Trực tiếp bản ghi record | Apply vào record + ghi resolutions ledger | Skill-kind approve trong `/memory` redirect sang `/skills` |
| `/skills pending\|approve` (skill files) | Files qua `skill_manage` dưới `$DSH_HOME/skills` | Chỉ drop **sau khi** file ghi xong | Vá theo chuỗi con duy nhất; pin chặn xóa chứ không chặn vá; từ chối bundled/hub |

`stageWrite` validate JSON nhưng không chạm capacity; `approveStaged` với memory ops thì apply, skill kind thì chỉ drop. Chưa duyệt thì off-model, off-capacity. Staged scope-checked (`staged-not-found`); `pin` chặn transitions lẫn delete. Chỉ `origin: 'background_review'` đặt `createdBy: 'agent'`; tạo ở foreground là do người dùng và không tự quản (`specs/evolutionary-harness.spec.md:131`).

**Lệnh còn lại.** `/curator status|run|adopt|purge|rollback|ledger|pin|unpin`: trạng thái, ép chạy, nhận skill tay, xóa archived quá TTL, rollback, xem ledger, ghim/bỏ ghim. `/refine` → `reviewer.rebuild` ngay. `/trajectory [--out] [--all]` → exporter. `/learn` dựng prompt rồi đi turn thường. `/suggestions` liệt kê blueprint skills, không schedule.

**Curator lifecycle 30/90d**, trigger bằng idle (`specs/evolutionary-harness.spec.md:233`): `intervalHours:168`, `minIdleHours:2`; `active → stale (30d) → archived (90d)` vào `.archive/` (`specs/evolutionary-harness.spec.md:235`). Timer host-wide tick 15 phút, `maybeRun` cần enabled + đủ 168h + idle 2h; lần đầu seed `lastRunAt` rồi defer (`packages/evolution/evolution-curator/src/index.ts:301-322`, `packages/evolution/evolution-curator/src/index.ts:430-442`). Transitions theo `idleMs` từ `lastUsedAt??createdAt`; bỏ qua pinned/protected/hub; `dryRun` preview; `archiveAfterDays<staleAfterDays` fail loud (`packages/evolution/evolution-curator/src/index.ts:264-268`, `packages/evolution/evolution-curator/src/index.ts:359-396`). Consolidation opt-in (`consolidate:false`): cần provider+model, survey `createdBy==agent`, cost ledger row, vòng `maxSteps 4` trên whitelist view/apply. Backups tar.gz giữ 5, `rollbackPass/entry` reversible, `adopt` manual, `purge` chỉ archived quá TTL (default 0 = never).

**Follow stream.** Verb `follow`: baseline mọi registered scopes + ordered upserts từ `domain/changed` lọc `evolution_memory.records` non-deleted. Đây là "đài phát thanh" cho dashboard/Remote theo dõi record theo thứ tự, không poll storage.

**Trajectory, scorer, telemetry.** `exportSession` (flush live session, `session/not-found` khi vắng, mảng rỗng khi không admitted message) + `exportScope` (split `profile:workspaceId`, roster non-archived, per-log skip+warn); mặc định `$DSH_HOME/evolution-trajectories`, overwrite-not-append. Shaping `toShareGpt` thuần: một conversation mỗi turn (`<sessionId>#<turn>`), chỉ text blocks. Scorer chỉ baseline thủ công; `corpusDir` required + `attempts 3`; runner ACP tier, keyless replay:

> "Scores a recorded corpus run: workspace-diff pass, metered tokens, and median-of-N wall time" — `packages/evolution/README.md` (scorer row)

> "`dsh-evolution-trajectory` writes finished Sessions as ShareGPT conversation files for evals and reinforcement-learning data." — `packages/evolution/evolution-trajectory/README.md:12`

Telemetry v1 (`evolution_skill_usage`) đếm use/view/patch mỗi record; `createdBy agent` chỉ qua `markAgentCreated` trên background origin; loại bundled/hub*; paths lặp ≥3 lần → propose skill, không đọc content. Squeeze khi context chật như đã nói ở §1 (`packages/evolution/evolution-reviewer/src/index.ts:992-1024`); `maxAgentBytes` của store là chuẩn có thẩm quyền. Giới hạn vận hành: web-only trước, machine-local, tắt là gỡ dòng (như §1–§2).

## 8. Kết luận và cách tra cứu tiếp

Bằng chứng trong toàn bài ủng hộ ba mệnh đề. Một, memory và outputs chung điểm hẹn nhưng khác gate: memory gated qua `turn/end` + `enabled` + `minTurnTextBytes` + cooldown + route, `temperature: 0` (`specs/evolutionary-harness.spec.md:199`, `specs/evolutionary-harness.spec.md:202`, `specs/evolutionary-harness.spec.md:212`); outputs index luôn-chạy ngay cả `enabled:false` (`packages/evolution/evolution-reviewer/README.md:40`). Hai, timeline là read model thuần sống một lần (`packages/evolution/command-evolution/src/journey.ts:1-7`; `packages/evolution/evolution-controller/README.md:93`); mỗi hàng truy về một stamp, bucket UTC+7. Ba, governance là hai hàng chờ + lifecycle 30/90d + follow: curator `168h/2h` (`specs/evolutionary-harness.spec.md:233`), `active→stale→archived` (`specs/evolutionary-harness.spec.md:235`), `createdBy agent` chỉ background (`specs/evolutionary-harness.spec.md:131`); machine-local, web-app-only (`specs/evolutionary-harness.spec.md:11`, `specs/evolutionary-harness.spec.md:47`, `specs/evolutionary-harness.spec.md:284`).

Câu hỏi mang về để tự chẩn đoán: khi lessons đứng yên sau hàng chục turn, kiểm tra theo thứ tự — scope có resolve không, text có qua 200 bytes không, cooldown 60 giây hết chưa, route có sẵn không, và cấu hình có bắt staged-approval không. Mỗi câu hỏi ứng với đúng một gate ở §4. Khi prose và tests mâu thuẫn về trigger, tests thắng.

| Nhiệm vụ | Đọc ở đâu |
|---|---|
| Hiểu trigger memory/extraction | `specs/evolutionary-harness.spec.md:199, 202, 204, 212` + `packages/evolution/evolution-reviewer/src/index.ts:630-656, 718-772, 942-973` |
| Hiểu lưu output/indexing | `packages/evolution/evolution-reviewer/README.md:40` + `packages/evolution/evolution-reviewer/src/index.ts:275-293, 841-902` |
| Hiểu brief/digest/capacity | `specs/evolutionary-harness.spec.md:111, 184` + `packages/evolution/evolution-reviewer/src/index.ts:992-1024` |
| Hiểu timeline/journey | `packages/evolution/command-evolution/src/journey.ts:1-15` + `packages/evolution/evolution-controller/README.md:93` |
| Hiểu store/record/staged | `packages/evolution/evolution-memory/src/index.ts:2-12, 551-555` và `types.ts` |
| Hiểu curator/lifecycle | `specs/evolutionary-harness.spec.md:233, 235` + `packages/evolution/evolution-curator/src/index.ts:301-322, 430-442` |
| Hiểu trajectory/scorer | `packages/evolution/evolution-trajectory/README.md:12` + `packages/evolution/README.md` (scorer row) |
| Hiểu composition/gỡ bỏ | `specs/evolutionary-harness.spec.md:11, 47, 284` + `docs/subsystems/evolutionary-harness.md:11-18` |

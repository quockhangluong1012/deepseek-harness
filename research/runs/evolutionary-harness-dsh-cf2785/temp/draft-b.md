# Draft B — timeline / governance (teach register)

> Góc B: journey read-model, lệnh quản trị, staged-approval, curator lifecycle, follow stream. Các phần khác gọn nhưng đủ.

## 1. Bức tranh tổng thể evolutionary harness

Plain-language trước: evolutionary harness là **vòng học khép kín đặt trên nóc harness**, không đục vào lõi đặc quyền. Agent làm việc và để lại dấu vết; hệ thống thỉnh thoảng đọc lại dấu vết để rút kinh nghiệm; kinh nghiệm đó được đưa trở lại prompt phiên sau.

Bốn từ dùng suốt bài. **Record** là sổ tay bền vững cho mỗi cặp `(profile, scope)` trong domain `evolution_memory`. **Brief** là phiếu nhắc bài cắt ra từ sổ tay, tiêm vào model trước mỗi bước. **Staged** là đề xuất ghi đang chờ duyệt — chưa duyệt thì chưa thành tri thức. **Timeline / journey** là lịch treo tường suy ra từ sổ tay, không phải cuốn sổ thứ hai.

> "The evolution family adds a closed learning loop on top of the harness without patching a privileged core: durable per-scope memory records with staged writes, background turn review, scheduled skill curation, and long-horizon safety rails." — `packages/evolution/README.md:12`

> "Every learned write is capped, staged when configured, logged, and rollback-capable; removing the rows restores byte-identical legacy behaviour." — `packages/evolution/README.md:12`

Evolution là **lớp cộng thêm có thể gỡ**: hàng composition chỉ nằm ở bundle `web-app` nên snapshot khác giữ nguyên tới khi nhận (`specs/evolutionary-harness.spec.md:47`); mọi thứ machine-local dưới `$DSH_HOME`, không ghi vào project người dùng (`specs/evolutionary-harness.spec.md:11`); gỡ là xóa rows — không record, không brief, không extraction (`specs/evolutionary-harness.spec.md:284`).

Khung của draft này là ba vòng lồng nhau: vòng **turn** tính bằng giây, vòng **ngày/tuần**, vòng **tháng/quý**. Chỉ hai sợi chỉ nối ba vòng: **digest** của brief và **stamps** của record.

## 2. Kiến trúc 7 package và vai trò từng khối

**`evolution-memory` (thủ kho)** sở hữu `ctx.evolutionMemory`: một document mỗi scope trên domain `evolution_memory` v1, layout `per-record`, bảng `records`, key opaque `profile:workspaceId` hoặc `profile:global` (`specs/evolutionary-harness.spec.md:54`); với backend `storage-json` là file `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json` (cùng nguồn). Đọc đồng bộ detached, check caps trước ghi, write bị từ chối thì không mutate (`index.ts:2-12, 551-555` theo `temp/interim-a-memory.md`). **`evolution-reviewer` (người xem lại băng)** nghe `session/event`, index output mỗi turn, thỉnh thoảng gọi model rút bài học. **`command-evolution` (quầy lễ tân)** chứa `/memory`, `/skills`, `/journey`, `/curator`, `/refine`, `/trajectory`, `/learn`, `/suggestions`; read model `scopeTimeline` sống đúng một lần ở đây. **`evolution-controller` (tổng đài Remote)** gồm `read/setInstructions/setLessons/setProfile/addContextItem/removeContextItem/rebuildMemory/listStaged/approveStaged/rejectStaged/timeline/follow`, scope-first `requireWorkspace`, staged scope-checked (`staged-not-found`); vì `scopeTimeline` import từ `dsh-command-evolution` nên text `/journey` và verb `timeline` không lệch nhau (`packages/evolution/evolution-controller/README.md:93`). **`evolution-curator` (quản thư)** chạy timer host-wide, chuyển trạng thái skill, backup (`index.ts:301-322, 430-442`). **`evolution-trajectory` (đóng thùng)** viết Session xong thành ShareGPT cho eval/RL (`packages/evolution/evolution-trajectory/README.md:12`); không admitted message thì mảng rỗng (cùng nguồn). **`evolution-scorer` + telemetry**: bộ ba workspace-diff pass, metered tokens, median-of-N wall time (`packages/evolution/README.md` scorer row); telemetry `evolution_skill_usage` v1 đếm use/view/patch mỗi record.

Bảng Parts (`docs/subsystems/evolutionary-harness.md:11-18`): Instructions, Lessons, Profile, Context → lên model + tính capacity; Outputs ("navigation index") và Staged (pending) → không. Chỉ kinh nghiệm đã duyệt mới tốn token và chỗ. Composition chỉ ở `web-app` (`cordis.patch.yml:102-146`): memory `capacityBytes 131072`, memory-context `maxBytes 16384`; thiếu `memory.capacityBytes`, `memory-context.maxBytes`, `controller.profile`, `scorer.corpusDir` thì fail loud.

## 3. Các flow vận hành end-to-end

Mọi flow gặp nhau ở điểm hẹn duy nhất `turn/end`, với thứ tự load-bearing (`comparisons.md`): **index → recall → gate**.

**Turn loop (giây).** Pre-step: injector (hook `agent/pre-step`) so digest, tiêm đúng một brief nếu đổi; record vắng thì digest `'empty'`, `hasContent false` thì nothing, zero token. Tới `turn/end`, `observeTurn` luôn index output trước rồi mới xét gate (`specs/evolutionary-harness.spec.md:199`). Vượt gate thì snapshot coalesce một bản mỗi session, deadline `deferMaxAgeMs 1800000`; disposal/teardown thì drop (`index.ts:718-772`).

**Ngày/tuần.** `/memory pending` hoặc `/skills pending` xem hàng chờ; `approve`/`reject` ghi resolutions ledger (newest-first, cap `maxResolutions`). `/journey` đọc record, đếm resolutions theo decision day, xếp bucket UTC+7, hiện capacity + staged hint.

**Tháng/quý.** Curator tick 15 phút, host idle đủ lâu thì survey skill agent-tạo, chuyển trạng thái, backup tar.gz giữ 5 bản, ghi JSONL ledger. `/trajectory` export scope thành ShareGPT dưới `$DSH_HOME/evolution-trajectories`, overwrite-not-append. Scorer chạy thủ công: đọc `input.json` + fixture + `replay.override.json` + `workspace/expected`, trả pass / billed tokens / median wall time. Vòng 1 nối bằng digest, vòng 2 bằng stamps + ledger, vòng 3 bằng telemetry + backups.

## 4. Khi nào trigger memory

"Mỗi turn đều ghi memory" là **sai**. Mỗi turn chỉ index outputs; lessons/profile chỉ đổi qua ba đường.

**A — trực tiếp từ con người.** `/memory approve`, `setLessons`, `setUserProfile`, `addContextItem` gọi thẳng store verbs. Foreground user-directed, không auto-manage; file contexts resolve + canonicalize trong workspace kèm `sizeBytes`.

**B — background extraction, luôn gated.** Trigger là `ctx.on('session/event', …)` lọc `turn/end`, resolve scope, không scope thì return (`specs/evolutionary-harness.spec.md:199`). Gate loại trừ:

> "Skipped when `review.enabled` false, cooldown unelapsed, or admitted text under `minTurnTextBytes`." — `specs/evolutionary-harness.spec.md:202`

Máy chi tiết: `turn/start→beginTurn` reset buffer, `turn/end→observeTurn`, còn lại `bufferEvent` (`index.ts:392-394, 490-500, 596-628`); trong `observeTurn` là `recallQueryOf` rồi gate — `!enabled` return, `admittedBytes < 200` return, cooldown `60000` return, no route warn-skip, còn lại defer auto/never (`index.ts:630-656`). Nghĩa là **`enabled:false` chỉ tắt extraction, indexing vẫn chạy.**

Cuộc gọi vượt gate là deterministic — `temperature: 0`, reasoning tắt qua `purpose: 'evolution-review'`, `maxTokens: maxOutputTokens`, `deadline(signal, timeoutMs)` (`specs/evolutionary-harness.spec.md:212`) — và transcript chỉ gồm human `user/message` (`data.source.kind === 'user'`) với `assistant/message`; brief và context đã tiêm không đưa ngược lại (`specs/evolutionary-harness.spec.md:204`). Lỗi `error/aborted` throw, hết token `truncated:true`, block tool-call reject (`index.ts:942-973, 329-340`). Ghi thành công mang `origin: 'background_review'`, và chỉ origin này set `createdBy: 'agent'` (`specs/evolutionary-harness.spec.md:131`); dưới `writeApproval` thì vào staged.

**C — rebuild, luôn direct.** `/refine` gọi `reviewer.rebuild` ngay: drop archived, slice newest-first `rebuildSessionLimit 20`, qua `admittedRow` human-only, `currentLessons=''`, `origin rebuild` luôn direct ngay cả dưới `writeApproval` (`index.ts:427-513, 457-482`); không route thì `extraction-failed`.

Trigger đọc (brief injector): hook `agent/pre-step`, membership qua registry `sessionIds` rồi fallback canonical-cwd, triple digest gate. Ngân sách `maxBytes` gồm frame: drop trailing Context → truncate Lessons → Profile → Instructions cuối + notice line. Recall là một item `'Recall: <sessionId>'` duy nhất, render cuối nên drop đầu khi chật — tier yếu nhất (`comparisons.md` D × B).

## 5. Khi nào trigger lưu output vào evolution

"Lưu output" là `recordOutputs` — chỉ mục điều hướng (path, tool, sessionId, at), không phải bài học. Trigger ngược hẳn memory: **luôn chạy, không gate**.

> "Completed turns trigger extraction; output indexing always runs" — `packages/evolution/evolution-reviewer/README.md:40` (`enabled` row)

> "`ctx.on('session/event', …)` filtered to `turn/end`. Resolve scope, return when none. One backward scan to most recent `turn/start` feeds output indexing (always) and extraction (when gated)." — `specs/evolutionary-harness.spec.md:199`

Mỗi `turn/end`, reviewer quét ngược tới `turn/start` gần nhất, nhặt file đã ghi vào `outputs` newest-first; `enabled:false` vẫn index, chỉ return khi mất scope. Bộ lọc `producedEntry` (`index.ts:275-293, 841-902`; `spec:199-202`): tool thuộc `outputTools`, outcome non-error, `str_replace_editor` bỏ view/undo_edit, resolve cwd + realpath fallback, chỉ file **trong scope**. Store-side idempotent: rỗng noop, không đổi no-write, vắng seed+put; `mergeOutputs` newest-first cap `maxOutputs 200` (`temp/interim-a-memory.md`). `recordOutputs` chỉ gọi từ `indexOutputs`. Vì outputs off-model/off-capacity, index luôn-chạy thì rẻ, extraction hiếm-chạy thì đắt nên gated ("luôn-index" vs "hiếm-extract").

## 6. Evolution timeline hoạt động thế nào

Mệnh đề mở đầu: **timeline không bao giờ được "ghi" — nó được suy ra mỗi lần đọc.** Không có bảng timeline trong storage.

> "Read model and rendering behind `/journey`: one scope's recorded evolution activity, bucketed on the dashboard calendar (UTC+7)… The model is pure — the command supplies the record it already read, so this module touches neither storage nor the session log, and the Remote controller reuses it unchanged." — `packages/evolution/command-evolution/src/journey.ts:1-7`

> "**The read model lives once.** `scopeTimeline` is imported from `dsh-command-evolution`, so `/journey` text and the timeline verb can never disagree about a bucket." — `packages/evolution/evolution-controller/README.md:93`

**Ví dụ một ngày của An** (profile `web-app`, workspace `shop`, 12/09). 09:00 sửa `cart.ts`: index `{path: cart.ts, at: 09:01}` vào `outputs`; text 120 bytes nên extraction skip. 10:30 thảo luận dài 3KB: vượt gate, đề xuất lesson vào staged (`createdAt 10:31`). 14:00 `/memory pending` rồi `/memory approve`: apply vào `agentLessons`, ghi resolution `{approve, at: 14:02}`. 15:00 `/journey 7d`: gọi `scopeTimeline({record, usedBytes, capacityBytes, digest, range: '7d', now})`, suy ra deltas — lesson từ stamp 14:02, outputs từ `at 09:01`, staged đã rỗng, resolutions theo decision day 12/09 — xếp bucket `dayKey` UTC+7, render một dòng + capacity + hint 0 pending. 22:00 host idle nhưng `intervalHours 168` chưa hết nên curator defer.

Cơ chế suy ra (`journey.ts:1-15`): input `TimelineInput{record, usedBytes, capacityBytes, digest, range, now}`; `recordDeltas` ascending gồm instructions stamp, lessons/profile stamps (fallback `lastExtraction` → một lessons delta, else `memoryUpdatedAt` → hand-edit), mỗi `contextItems.addedAt`, mỗi `outputs.at`, mỗi `staged.createdAt`; extraction qua `extraction.at` match else hand-edit. Bucket `dayKey` UTC+7, bounded zero-filled; cumulative không phụ thuộc range; pending từ `record.staged`. Mỗi dòng truy về đúng một stamp (`comparisons.md` C × A). `/journey [today|7d|30d|all]` mặc định `7d`; `/journey export` ra `timeline.json` + `session-log.jsonl` thành zip dưới `$DSH_HOME/exports`. Brief mỗi session cùng họ: digest so newest visible `source.kind === 'evolution-memory'`, bằng thì nothing, khác/vắng thì một brief fresh (`specs/evolutionary-harness.spec.md:184`); digest chỉ cover instructions, lessons, profile, context (`specs/evolutionary-harness.spec.md:111`). Vòng feedback record → brief → model → turn → (filter) → extraction → record dùng cùng predicate hai đầu nên không tự khuếch đại.

## 7. Tất cả những thứ liên quan còn lại

**Hai hàng chờ, một sổ cái.** `/memory pending|approve|reject` sửa record; `/skills pending|approve` sửa files qua `skill_manage` rồi mới drop entry. Skill-kind approve trong `/memory` redirect sang `/skills`; `/skills approve` chỉ drop **sau khi** file ghi xong (`comparisons.md` C × D). `stageWrite` validate JSON nhưng không chạm capacity; `approveStaged` với memory ops thì apply, skill kind thì chỉ drop. Chưa duyệt thì off-model, off-capacity. Staged scope-checked (`staged-not-found`); `pin` chặn transitions lẫn delete.

**Lệnh còn lại.** `/curator status|run|adopt|purge|rollback|ledger|pin|unpin`: trạng thái, ép chạy, nhận skill tay, xóa archived quá TTL, rollback, xem ledger, ghim/bỏ ghim. `/refine` → `reviewer.rebuild` ngay. `/trajectory [--out] [--all]` → exporter. `/learn` dựng prompt rồi đi turn thường. `/suggestions` liệt kê blueprint skills, không schedule.

**Curator lifecycle 30/90d**, trigger bằng idle (`specs/evolutionary-harness.spec.md:233`): `intervalHours:168`, `minIdleHours:2`; `active → stale (30d) → archived (90d)` vào `.archive/` (`specs/evolutionary-harness.spec.md:235`). Timer host-wide tick 15 phút, `maybeRun` cần enabled + đủ 168h + idle 2h; lần đầu seed `lastRunAt` rồi defer (`index.ts:301-322, 430-442`). Transitions theo `idleMs` từ `lastUsedAt??createdAt`; bỏ qua pinned/protected/hub; `dryRun` preview; `archiveAfterDays<staleAfterDays` fail loud (`index.ts:264-268, 359-396`). Consolidation opt-in (`consolidate:false`): cần provider+model, survey `createdBy==agent`, cost ledger row, vòng `maxSteps 4` trên whitelist view/apply (`consolidate.ts`, `index.ts:459-554`). Backups tar.gz giữ 5, `rollbackPass/entry` reversible, `adopt` manual, `purge` chỉ archived quá TTL (default 0 = never). Chỉ `origin: 'background_review'` mới `createdBy: 'agent'` (`specs/evolutionary-harness.spec.md:131`).

**Follow stream.** Verb `follow`: baseline mọi registered scopes + ordered upserts từ `domain/changed` lọc `evolution_memory.records` non-deleted. Đây là "đài phát thanh" cho dashboard/Remote theo dõi record theo thứ tự, không poll storage.

**Trajectory, scorer, telemetry.** `exportSession` (flush live session, `session/not-found` khi vắng, mảng rỗng khi không admitted message) + `exportScope` (split `profile:workspaceId`, roster non-archived, per-log skip+warn); mặc định `$DSH_HOME/evolution-trajectories`, overwrite-not-append. Shaping `toShareGpt` thuần: một conversation mỗi turn (`<sessionId>#<turn>`), chỉ text blocks. Scorer chỉ baseline thủ công; `corpusDir` required + `attempts 3`; runner ACP tier, keyless replay. Telemetry v1 đếm use/view/patch, `createdBy agent` chỉ qua `markAgentCreated` trên background origin, loại bundled/hub*; paths lặp ≥3 lần → propose skill, không đọc content.

## 8. Kết luận và cách tra cứu tiếp

Bằng chứng ủng hộ ba mệnh đề. Một, memory và outputs chung điểm hẹn nhưng khác gate: memory gated qua `turn/end` + `enabled` + `minTurnTextBytes` + cooldown + route, `temperature: 0` (`specs/evolutionary-harness.spec.md:199, 202, 212`); outputs index luôn-chạy ngay cả `enabled:false` (`packages/evolution/evolution-reviewer/README.md:40`). Hai, timeline là read model thuần sống một lần (`journey.ts:1-7`; `packages/evolution/evolution-controller/README.md:93`); mỗi hàng truy về một stamp, bucket UTC+7. Ba, governance là hai hàng chờ + lifecycle 30/90d + follow: curator `168h/2h` (`specs/evolutionary-harness.spec.md:233`), `active→stale→archived` (`specs/evolutionary-harness.spec.md:235`), `createdBy agent` chỉ background (`specs/evolutionary-harness.spec.md:131`); machine-local, web-app-only (`specs/evolutionary-harness.spec.md:11, 47, 284`).

Tra cứu tiếp (identifier nguyên văn): store thì `packages/evolution/evolution-memory/src/index.ts` (`2-12, 551-555`) và `types.ts:134-166`; gate thì `packages/evolution/evolution-reviewer/src/index.ts` (`392-394, 490-500, 596-628, 630-656, 275-293, 841-902, 942-973`); lịch thì `packages/evolution/command-evolution/src/journey.ts:1-15`; quản trị thì `packages/evolution/evolution-curator/src/index.ts` (`301-322, 430-442, 264-268, 359-396, 459-554`). Khi prose và tests mâu thuẫn về trigger, tests thắng.

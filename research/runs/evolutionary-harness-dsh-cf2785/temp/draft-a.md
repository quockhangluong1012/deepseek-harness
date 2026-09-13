# Draft A — mechanism/trigger: evolutionary harness hoạt động thế nào

## 1. Buc tranh tong the evolutionary harness

Hãy hình dung evolutionary harness như cuốn sổ tay mà trợ lý tự ghi sau mỗi ca làm, kèm một thủ thư quyết định dòng nào đáng ghi. Sổ nằm riêng trên máy; gỡ nó ra thì harness về hành vi cũ nguyên vẹn từng byte.

Về kỹ thuật, evolution family bổ sung vòng học khép kín phía trên harness mà không vá lõi đặc quyền nào: bản ghi memory bền vững theo scope với ghi theo giai đoạn, review turn chạy nền, curated skill theo lịch, và ray an toàn chân trời dài (`packages/evolution/README.md:12`). Mọi lượt ghi đều bị chặn trần, staged khi có cấu hình, ghi log và rollback được; xóa các hàng là khôi phục hành vi legacy giống hệt từng byte (`packages/evolution/README.md:12`).

Ví dụ: ở profile `web-app`, bạn bàn quy ước migration rồi refactor ba file. Reviewer lập chỉ mục file vừa chạm và có thể đề xuất lesson mới; nếu bật duyệt, lesson chờ ở staged, chỉ khi approve trong `/memory` thì sổ mới đổi.

Bằng chứng cho khung ba vòng lồng nhau: vòng turn tính bằng giây (brief, turn, indexOutputs, maybe-extract), vòng ngày/tuần (duyệt, resolutions, bucket journey, capacity), vòng tháng/quý (curator, trajectory, scorer thành dữ liệu huấn luyện). Chất kết dính là digest, stamp cộng ledger, và telemetry cộng backup, tất cả machine-local dưới `$DSH_HOME` và chỉ cắm vào bundle `web-app` trước tiên.

## 2. Kien truc 7 package va vai tro tung khoi

Mỗi package là một nhân sự trong thư viện: thủ kho, quan sát viên, lễ tân, quầy lệnh, thủ kho đêm, người đóng thùng, và giám khảo.

| Package | Vai trò | Input → Output |
|---|---|---|
| `evolution-memory` | Thủ kho: bản ghi theo `(profile, scope)` | Lệnh ghi, extraction → bản ghi v1, digest, capacity |
| `evolution-reviewer` | Quan sát viên turn | `session/event` → output index, đề xuất extraction |
| `evolution-controller` | Lễ tân brief và recall | Scope, truy vấn → brief, item Recall |
| `command-evolution` | Lệnh `/memory`, `/skills`, `/journey` | Thao tác người dùng → sửa bản ghi, bucket |
| `evolution-curator` | Dọn kho khi rảnh | Idle đủ lâu → chuyển trạng thái, gom gọn |
| `evolution-trajectory` | Xuất hội thoại đã xong | Session kết thúc → file ShareGPT |
| `evolution-scorer` | Chấm lượt chạy đã ghi | Corpus, diff → điểm pass, token, median wall time |

Đơn vị nhỏ nhất là một bản ghi cho mỗi `(profile, scope)` trong domain `evolution_memory`, version `1`, bố cục `per-record`, bảng `records`, khóa bằng id mờ `profile:workspaceId` hoặc `profile:global` (`specs/evolutionary-harness.spec.md:54`). Với backend `storage-json`, đó là một document tại `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json` (`specs/evolutionary-harness.spec.md:54`). Instructions, Lessons, Profile và Context vừa lên model vừa tính capacity; Outputs chỉ là chỉ mục và Staged chỉ là hàng chờ, cả hai đều không (`docs/subsystems/evolutionary-harness.md:11-18`).

## 3. Cac flow van hanh end-to-end

Theo một turn như ca làm ở xưởng: chuông hết ca reo, thủ kho nhặt thành phẩm trước, rồi mới hỏi có nên ghi kinh nghiệm vào sổ không. Thứ tự bắt buộc: index rồi recall rồi gate.

| Bước | Sự kiện và hàm | Điều gì xảy ra |
|---|---|---|
| 1. Mở và đệm turn | `turn/start` gọi `beginTurn`; sự kiện khác gọi `bufferEvent` | Reset buffer; không quét lại lịch sử, turn đang bay vẫn góp hậu tố đã quan sát (`packages/evolution/evolution-reviewer/src/index.ts:392-394`, `packages/evolution/evolution-reviewer/src/index.ts:490-500`, `packages/evolution/evolution-reviewer/src/index.ts:8-12`) |
| 2. Đóng turn | `turn/end` gọi `onTurnEnd` rồi `observeTurn` trong try/catch chỉ warn (`packages/evolution/evolution-reviewer/src/index.ts:596-628`) | Điểm hẹn duy nhất của cả hai đường |
| 3. Scope và index | Resolve scope rồi quét ngược tới `turn/start` gần nhất | Không scope thì return; index luôn chạy, không qua gate (`specs/evolutionary-harness.spec.md:199`, `packages/evolution/evolution-reviewer/README.md:40`) |
| 4. Recall và gate | `recallQueryOf` rồi chuỗi gate nối tiếp | Rớt gate nào thì dừng (`packages/evolution/evolution-reviewer/src/index.ts:630-656`) |
| 5. Defer và gọi | Defer auto gom một snapshot mỗi session, deadline 1800000, dispose thì bỏ (`packages/evolution/evolution-reviewer/src/index.ts:718-772`); gọi với nhiệt độ 0, tắt reasoning, bỏ cũ nhất khi quá tải (`packages/evolution/evolution-reviewer/src/index.ts:942-973`, `packages/evolution/evolution-reviewer/src/index.ts:329-340`) | Deterministic (`specs/evolutionary-harness.spec.md:212`) |

Vòng phản hồi đóng kín về cấu trúc: bài học đi từ bản ghi vào brief rồi tới model rồi thành turn, rồi qua cùng bộ lọc admission để về bản ghi. Hai đầu chung một predicate nên hệ không tự khuếch đại.

## 4. Khi nao trigger memory

Đây là trái tim của draft: mỗi ca đều kiểm kê thành phẩm, nhưng chỉ ca đặc biệt mới ghi kinh nghiệm vào sổ. Công thức dual-gate: turn đã xong thì trigger extraction, còn lập chỉ mục output thì luôn chạy (`packages/evolution/evolution-reviewer/README.md:40`). Listener chỉ lọc `turn/end`, resolve scope rồi return khi không có scope, quét ngược một lần tới `turn/start` gần nhất (`specs/evolutionary-harness.spec.md:199`). Đường extraction bị bỏ qua khi `review.enabled` tắt, cooldown chưa hết, hoặc text dưới `minTurnTextBytes` (`specs/evolutionary-harness.spec.md:202`).

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

Ví dụ: turn sửa chính tả rồi lưu file luôn thêm mục output, nhưng text ngắn nên lessons đứng yên. Turn thảo luận dài rồi refactor ba file thì vượt ngưỡng, qua cooldown và có thể đề xuất lesson mới.

## 5. Khi nao trigger luu output vao evolution

Nếu mục 4 là ghi kinh nghiệm, mục này là lưu dấu vết thành phẩm. Coi outputs như kệ ảnh chụp thành phẩm: giúp tìm lại file đã chạm, nhưng không dạy model và không tính capacity.

Trigger lưu output chạy luôn sau mỗi `turn/end` đã resolve scope, không qua gate extraction (`packages/evolution/evolution-reviewer/README.md:40`, `specs/evolutionary-harness.spec.md:199`). Hàm `recordOutputs` chỉ được gọi từ `indexOutputs` với đầy đủ chuỗi lọc, hợp nhất newest-first, chặn trần `maxOutputs` 200 và idempotent.

| Điều kiện trigger | Hành động | Nơi lưu |
|---|---|---|
| Tool trong `outputTools` như write, edit và `str_replace_editor`, outcome không lỗi, có path từ `file_path` hoặc `path`, bỏ qua view và undo_edit, resolve theo cwd với realpath fallback, chỉ giữ file trong scope (`packages/evolution/evolution-reviewer/src/index.ts:275-293`, `packages/evolution/evolution-reviewer/src/index.ts:841-902`) | Chấp nhận thành `producedEntry` | Đầu vào `recordOutputs` |
| Danh sách rỗng, mục trùng, hoặc mục mới (không tính capacity: `docs/subsystems/evolutionary-harness.md:11-18`) | Rỗng thì noop; trùng thì no-write; mới thì seed rồi put, cắt 200 mục mới nhất | `outputs` newest-first `{path, tool, sessionId, at}` |

Ví dụ: turn tạo `src/auth/login.ts` bằng write và sửa `README.md` bằng edit thì thêm hai mục mới. Turn chỉ xem file bằng view thì không thêm gì. Ngay cả khi `review.enabled` tắt, kiểm kê output vẫn chạy.

## 6. Evolution timeline hoat dong the nao

Timeline là lịch treo tường phản chiếu sổ, không phải bảng riêng sinh sự kiện.

Về kỹ thuật, đó là mô hình đọc và render đằng sau `/journey`: hoạt động một scope, gom theo lịch dashboard múi giờ UTC+7. Mô hình thuần túy vì lệnh đã tự đọc bản ghi rồi truyền vào; module không chạm storage lẫn session log, controller Remote tái dùng nguyên vẹn (`packages/evolution/command-evolution/src/journey.ts:1-7`). Mô hình đọc chỉ sống một nơi: `scopeTimeline` import từ `dsh-command-evolution`, nên text `/journey` và động từ timeline không bao giờ lệch bucket (`packages/evolution/evolution-controller/README.md:93`).

| Con dấu | Loại delta | Quy tắc bucket |
|---|---|---|
| `UpdatedAt`, `addedAt`, `at`, `createdAt`, `resolution.at` | Mỗi stamp một sự kiện | Ngày UTC+7 của chính stamp |
| `lastExtraction.at`, rồi `memoryUpdatedAt` dẫn xuất | Hai tầng dự phòng | Dùng khi thiếu delta mịn; phải nêu rõ để tránh hiểu lầm ngày trống |

Curator chạy theo nhịp không hoạt động với `intervalHours: 168` và `minIdleHours: 2` (`specs/evolutionary-harness.spec.md:233`), chuyển `active → stale (30d) → archived (90d)` vào `.archive/` (`specs/evolutionary-harness.spec.md:235`). Tầng tháng và quý khép bằng trajectory: mỗi Session xong thành file ShareGPT cho eval và RL (`packages/evolution/evolution-trajectory/README.md:12`); session không message được admission thì xuất mảng rỗng thay vì lỗi (`packages/evolution/evolution-trajectory/README.md:12`); rồi scorer chấm bộ ba diff workspace, token metering và median wall time.

## 7. Tat ca nhung thu lien quan con lai

Nhóm này gom các bề mặt dễ nhầm thành trí nhớ dài hạn, dù mỗi thứ chỉ là mắt xích phụ.

Brief là tờ giấy nhắc việc dán trước ca, không phải cuốn sổ. Mỗi Session một brief, thay khi đổi. So digest với message mới nhất có `source.kind === 'evolution-memory'`; bằng thì thôi, khác hoặc vắng thì tiêm đúng một brief mới (`specs/evolutionary-harness.spec.md:184`). Digest chỉ bao instructions, lessons, profile và context, không bao outputs, staged, resolutions hay timestamp (`specs/evolutionary-harness.spec.md:111`). Khi context chật, squeeze nén theo Purpose, Preferences, Decisions, References, xả References trước, cắt UTF-8 và gắn cờ truncated; `maxAgentBytes` của store là chuẩn có thẩm quyền (`packages/evolution/evolution-reviewer/src/index.ts:992-1024`).

Recall là tầng trí nhớ yếu nhất: một item duy nhất tên Recall, render sau cùng và bị bỏ đầu tiên. Truy vấn lấy từ human message mới nhất, giới hạn 20, cùng luật human-only; không seam thì không item. Đừng quảng cáo nó như bộ nhớ dài hạn.

Quản trị có hai hàng đợi trên một triết lý sổ cái: hàng memory sửa trực tiếp bản ghi, hàng skill sửa file rồi mới xóa mục. Chỉ `origin: 'background_review'` đặt `createdBy: 'agent'`; tạo ở foreground là do người dùng và không tự quản (`specs/evolutionary-harness.spec.md:131`). Hàng evolution vào bundle `web-app` trước, không vào `base`, để snapshot `headless`, `sdk` và `acp` giữ nguyên từng byte tới khi nhận (`specs/evolutionary-harness.spec.md:47`). Cả memory và skill machine-local dưới `$DSH_HOME`, không ghi vào dự án (`specs/evolutionary-harness.spec.md:11`). Tắt là xóa hàng: không đọc bản ghi, không brief, không extraction, sidebar về fallback (`specs/evolutionary-harness.spec.md:284`).

## 8. Ket luan va cach tra cuu tiep

Bằng chứng ủng hộ kết luận gọn: harness học với hai tốc độ trên cùng điểm hẹn `turn/end`. Tốc độ nhanh lập chỉ mục output mỗi turn; tốc độ chậm trích xuất bài học khi vượt gate, rồi chờ duyệt nếu có cấu hình.

Câu hỏi mang về: khi lessons đứng yên sau hàng chục turn, kiểm tra theo thứ tự scope có resolve không, text có qua 200 bytes không, cooldown 60 giây hết chưa, route có sẵn không, và cấu hình có bắt staged-approval không. Mỗi câu hỏi ứng với đúng một gate ở mục 4.

Đọc tiếp theo thứ tự tests trên prose: đặc tả trigger trong `specs/evolutionary-harness.spec.md`, listener và gate trong `packages/evolution/evolution-reviewer/src/index.ts`, lưu trữ trong `packages/evolution/evolution-memory/src/index.ts` và `types.ts`, brief và recall trong controller, bucket trong `packages/evolution/command-evolution/src/journey.ts`, rồi mới tới README từng package và `docs/subsystems/evolutionary-harness.md`.

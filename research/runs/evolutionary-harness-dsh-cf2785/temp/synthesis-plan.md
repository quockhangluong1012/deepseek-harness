# Synthesis plan (Step 11.3) — evolutionary-harness-dsh-cf2785

## Core thesis (1-2 sentences)

Evolutionary harness là vòng học khép kín ba nhịp lồng nhau (turn → ngày/tuần → tháng/quý) trên cùng một bản ghi scope: mọi turn đều **lưu output** (always-on indexing), chỉ turn vượt gate mới **ghi memory** (gated extraction), và timeline **không bao giờ được ghi** — nó được suy ra mỗi lần đọc từ các stamp của record.

## The 5 strongest beats

1. **Dual-gate turn/end** (Draft A) — index→recall→gate là thứ tự load-bearing; `enabled:false` vẫn index. Đây là câu trả lời cho 2/6 sub-questions.
2. **Worked journey day** (Draft B, §6 An's day) — ví dụ một ngày cụ thể làm cơ chế read-model "click"; giữ lại gần như nguyên văn.
3. **Architecture table + wiring decisions** (Draft C) — bảng package→vai trò→ctx key→trigger và 2 quyết định (web-app-only, machine-local).
4. **Two queues, one ledger philosophy** (B/C + comparisons C×D) — /memory sửa record, /skills sửa files; staged off-model/off-capacity.
5. **Three nested loops** (all drafts, comparisons global) — khung §1/§3; digest/stamps+ledger/telemetry+backups là chất kết dính.

## Section structure

8 H2 Vietnamese (B/C text, in decomposition order):
1. Bức tranh tổng thể evolutionary harness
2. Kiến trúc 7 package và vai trò từng khối
3. Các flow vận hành end-to-end
4. Khi nào trigger memory
5. Khi nào trigger lưu output vào evolution
6. Evolution timeline hoạt động thế nào
7. Tất cả những thứ liên quan còn lại
8. Kết luận và cách tra cứu tiếp

## Per-section commitments

### §1 Tổng thể
- From: A §1 (notebook analogy) + B §1 (4 terms: record/brief/staged/timeline) + C §1.
- Beat: loops framing + removable-layer proof (byte-identical). Engage tension: brief-vs-recall-vs-compaction (one paragraph, resolved).

### §2 Kiến trúc
- From: C §2 (arch table — keep full 8-row table) + B §2 (controller verb list, Parts table) + A §2 (compact).
- Must state: brief split (memory-context renders, controller edits). Glossary of 6 terms max.

### §3 Flows
- From: A §3 (turn loop detail) + B §3 (3 loops) + C §3.
- One ordered sequence: pre-step brief → turn → turn/end index → recall → gate → defer/rebuild; then day/week; then month/quarter. Engage reconcile A×B (single rendezvous, dual gates).

### §4 Trigger memory
- From: A §4 + B §4 (gate list + worked numbers) + interim-b gate chain.
- Trigger table (điều kiện → hành động → nơi lưu) + 3 write paths (direct/background/rebuild) + read-side brief gates. Kill the myth "mỗi turn đều ghi memory" in first paragraph.

### §5 Lưu output
- From: A §5 + B §5 + interim-a mergeOutputs.
- producedEntry filter table + mergeOutputs/newest-first/200/idempotent + "luôn-index vs hiếm-extract" cost rationale. Explicit: only caller is reviewer indexOutputs (index.ts:849).

### §6 Timeline
- From: B §6 (keep An's worked day) + C §6 + journey.ts mechanics.
- stamp→delta table + UTC+7 buckets + resolutions-from-ledger + fallback chain + /journey grammar + export zip. Open with "timeline không bao giờ được ghi".

### §7 Related
- From: C §7 + B §7 + D findings (telemetry/manage/recall/squeeze/trajectory/scorer/budgets-fallback one line each).
- Two-queues table + curator lifecycle + follow + trajectory/scorer + workspace-memory mirror one-liner + limits (web-only first).

### §8 Kết luận
- From: B §8 (3 propositions — keep) + lookup table (nhiệm vụ → file:line).
- No new claims. End with "prose-vs-tests: tests win" line.

## Length/format/citation notes

- Target 3800–4800 words (structured format; gear full). Drafts total ~6200w — compress by merging overlapping turn-loop expositions (§3 vs §4), NOT by cutting tables, worked example, or file:line citations.
- Keep every trigger claim cited with file:line. Keep code identifiers verbatim English.
- Teach voice; no Opinionated Synthesis section (structured format); end §8 with lookup table instead.
- Pass 1: integrate. Pass 2: dedupe turn-loop overlap, unify heading language, check length, verify citations preserved.

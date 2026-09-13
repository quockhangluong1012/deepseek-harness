# Scaffold — evolutionary-harness-dsh-cf2785

## User Prompt (VERBATIM — gospel)

/hyperresearch --profile full giúp tôi nghiên cứu chuyên sâu cơ chế evolutionary harness của repo deepseek harness này, cơ chế hoạt động, các flow chạy thế nào, khi nào trigger memory, khi nào trigger lưu output vào evolution, các evolution timeline hoat động, tất cả những thứ liên quan tới evolutionary harness

## Run config

- vault_tag: evolutionary-harness-dsh-cf2785
- query_file_path: research/runs/evolutionary-harness-dsh-cf2785/query.md
- modality: synthesize (with strong collect backbone)
- profile/gear: full (55–80 sources target, triple-draft, full critics)
- run workspace: research/runs/evolutionary-harness-dsh-cf2785/
- final report: research/notes/final_report_evolutionary-harness-dsh-cf2785.md
- language: Vietnamese (user query in Vietnamese; report in Vietnamese with English code/file identifiers preserved)

## Modality classification rationale

Query asks "cơ chế hoạt động, các flow chạy thế nào, khi nào trigger X" — causal/mechanistic explanation, not a mere enumeration. That is **synthesize**: evidence chains from source code → runtime behavior → trigger conditions. It still needs a **collect** backbone (per-package inventory of the 7 evolution packages + related session/goal/spill/skill-telemetry surfaces), because "tất cả những thứ liên quan" demands full coverage before arguing how they fit together.

## Tier rationale

Step 1 must confirm, but user explicitly passed `--profile full` and the question is argumentative/mechanistic ("khi nào trigger", "timeline hoạt động") with contradictions to resolve (memory vs evolution vs session log vs spill vs Agent Notes). That maps to **full** tier: width sweep + contradiction graph + loci + depth investigators + reconcile + critics + patcher. Respect tier gate: run all 16 steps. Do NOT collapse to light.

Scale gear is `full` (confirmed via `profile list`: current_gear=full, 55–80 sources, ~1.5–2.5h). For a repo-internal topic, "sources" = primary repo files (READ) + vault notes (hyperresearch fetch only for external web sources if needed). The bulk of evidence is in-repo; web search is secondary (only for Cordis/plugin background if gaps remain).

## Wrapper requirements

- Required save path: none explicit (default pipeline path `research/notes/final_report_<vault_tag>.md`).
- Citation format: none explicit → use pipeline default (file paths with line refs + vault note IDs where applicable).
- Terminal-section shape: none explicit → standard report close.
- Extra: user centers on 5 trigger questions → they become required sections (see prompt-decomposition.json): (1) cơ chế tổng thể, (2) flows, (3) khi nào trigger memory, (4) khi nào trigger lưu output vào evolution, (5) evolution timeline, (6) tất cả thứ liên quan.

## Installer adaptation (Windows)

`.claude/skills` in this repo is a FILE containing `../.agents/skills` (redirect), so `hyperresearch install --steps-only` fails with FileExistsError. Adaptation: do NOT touch that file; read step procedures directly from `site-packages/hyperresearch/skills/*.md` and execute them manually, keeping all artifacts in the canonical `research/runs/<vault_tag>/` locations. Manifest logging via `python -m hyperresearch run step` still applies.

## Orchestrator notes pointer

Running thoughts: research/runs/evolutionary-harness-dsh-cf2785/temp/orchestrator-notes.md

## Tier rationale (Step 1)

Query là mechanistic/teach-shaped với 6 sub-questions ràng buộc lẫn nhau (flows, 2 loại trigger dễ nhầm, timeline) trên một working tree duy nhất — không thể trả lời bằng lookup đơn lẻ. User chỉ định `--profile full` tường minh. Phân loại **pipeline_tier=full**, **response_format=structured** (cần bảng trigger + stage tables để tra cứu, thay vì luận đề thuần túy), **register=teach/high**. Chạy đủ 16 bước, triple-draft bắt buộc.

## Fix-round 1 note (ship gate)

`required_section_headings` ban đầu là ASCII không dấu (lựa chọn an toàn JSON của orchestrator, không phải gospel của user — user viết tiếng Việt). Verdict tiền-gate trong synthesis-conflicts (Conflict 1) đã chọn headings tiếng Việt vì chất lượng user-facing; instruction-critic đã xác nhận đủ 8 H2 đúng thứ tự. Ship gate so khớp chuỗi tuyệt đối nên đồng bộ contract về đúng headings đã ship (không đổi số lượng, thứ tự, hay ngữ nghĩa). Citation-density/quote-integrity của gate đo apparatus `[[note]]`/vault-note; corpus repo-internal dùng `file:line` code cites (112 sites đã verify 40/40 tồn tại) — fix round 1 bổ sung vault notes curation + markers `[[note-id]]` song song (không thay thế file:line) để cả hai apparatus cùng đúng.

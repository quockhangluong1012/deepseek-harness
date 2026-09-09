# Agent Note: Validation wait sớm và bound web search

Status: implemented

English | [中文](2026-09-09-early-wait-validation-bounded-search.zh.md)

## Problem

`job_output` kẹp `timeout_ms` bằng `Math.min` trước khi validate, nên giá trị âm hay non-integer lọt xuống lỗi wait chung của registry thay vì message rõ ở tầng tool, và schema chấp nhận `number` trong khi mọi budget millisecond khác trong repo đều là `integer`. `web_search` chặn số source nhưng giữ snippet từng source và answer của provider không giới hạn, nên một provider verbose có thể làm phình context parent. `terminal_send` không hề nói với model rằng mỗi session chỉ một send active.

## Decision

`timeout_ms` là `integer` trong schema và được validate up front là positive safe integer kèm echo giá trị vi phạm; clamp về cap cấu hình vẫn áp dụng sau đó. Search chặn ký tự snippet mỗi source (`searchSnippetMaxChars`, mặc định 500) và ký tự answer mỗi result (`searchContentMaxChars`, mặc định 4000) dưới dạng plugin config đã validate, áp dụng cho cả canonical result và replayable meta. `terminal_send` document wait backend-bounded và quy tắc one-active-send.

## Alternatives considered

**Render `whenToUse` trong skill catalog.** Bị từ chối vì test catalog ghim dòng name-and-description only; fixture skill tên đúng "Never render this routing hint" chứng minh omission là hợp đồng thiết kế.

**Đặt lại title cho card result workflow và `ralph`.** Bị từ chối vì cả hai presenter test ghim generic card rỗng; lợi ích cosmetic không đáng churn hợp đồng.

**Ship rule telemetry mặc định.** Bị từ chối vì đổi default pass-through là breaking; helper opt-in từ batch trước giữ hợp đồng explicit.

## Consequences

Wait xấu fail nhanh ở biên tool kèm echo giá trị, context search bounded theo config deployment với entry catalog và config-catalog, và hợp đồng terminal send khớp thực tế backend.

# Agent Note: Giới hạn editor và hướng dẫn text cho subagent

Status: implemented

English | [中文](2026-09-09-editor-bounds-subagent-guidance.zh.md)

## Problem

`str_replace_editor` buffer toàn bộ file trước khi cắt ngắn, nên file gigabyte có thể cạn memory trước khi cap view 16k-char áp dụng, view thư mục không có visited set hay cap entry, và `str_replace` chấp nhận `old_str` không giới hạn cho scan O(n*m). Wording delegation của subagent không nói với model rằng chỉ text của child tới được conversation parent, nên output image hay file-handle lặng lẽ thành text rỗng.

## Decision

View, `str_replace` và `insert` từ chối file trên 5.000.000 byte đã báo với hướng dẫn dùng `grep -n` cộng `view_range`, `old_str` trên 1.000.000 byte bị từ chối, và view thư mục dedupe path đã thăm và dừng ở 500 entry. Mô tả prompt của cả delegation fork và fresh yêu cầu câu trả lời text và nêu rõ chỉ text của child tới được conversation parent; mảng block đầy đủ vẫn available cho consumer PTC programmatic.

## Alternatives considered

**Stream file lớn qua editor thay vì từ chối.** Bị từ chối vì hợp đồng của editor là view đánh số dòng chính xác và replacement literal; từ chối bounded kèm hướng dẫn `grep` giữ hợp đồng trong khi `tool-fs read` đã bao phủ streaming read.

**Fail session invariant khi còn call unresolved hay share job limit theo session id.** Bị từ chối vì test hiện tại ghim cả hai hợp đồng: cuối step cho phép call unresolved để repair closer, và job limit tính theo exact owner object để agent replacement có bucket mới trong khi access vẫn id-fenced.

**Fail compaction loud khi có tool-call output hay ship rule redaction telemetry mặc định.** Bị từ chối vì hợp đồng summarizer giữ tool call trong `rawOutput` trong khi chỉ project text, và telemetry document không có built-in rule như known limitation; cả hai cần audit từng schema trước.

## Consequences

Các call editor file lớn fail nhanh với hướng dẫn actionable thay vì rủi ro cạn memory, view thư mục bounded và không duplicate, chuỗi tìm kiếm khổng lồ bị từ chối trước scan, và prompt delegation đặt kỳ vọng text-only đúng mà không đổi hợp đồng output programmatic.

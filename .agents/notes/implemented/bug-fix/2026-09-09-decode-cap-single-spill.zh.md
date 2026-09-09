# Agent Note: Pixel cap khi decode và single-spill cho search

Status: implemented

English | [中文](2026-09-09-decode-cap-single-spill.zh.md)

## Problem

Admission image kiểm tra dimension header trước khi decode full-raster nhưng để decoder không bị chặn: header nói dối có thể qua check dimension rồi lái pixel amplification không giới hạn trong `raw().toBuffer()`. Ngoài ra, `glob` và `grep` tự spill kết quả capped kèm paging guidance trong khi spill policy chung spill cùng call lần hai, ghi artifact trùng cho một result oversized.

## Decision

`detectImage` mang `maxPixels` đã cấu hình vào pixel cap của chính decoder để header nói dối fail trong lúc decode, và rejection pixel-limit của decoder map thành `IMAGE_TOO_MANY_PIXELS` thay vì `INVALID_IMAGE` chung. Arm model-facing của spill policy skip `glob` và `grep` cùng `read`, để paging result tự spill là artifact duy nhất.

## Alternatives considered

**Kéo dài hash session-dir của spill.** Bị từ chối vì test và startup sweep ghim shape `session-<12hex>`; dir 48-bit cộng random file 48-bit đã khiến collision negligible, nên đổi tên chỉ thêm churn mà không có threat model thật.

**Fail session invariant khi còn call unresolved hay share job limit theo session id.** Bị từ chối vì test hiện tại ghim cả hai hợp đồng: cuối step cho phép call unresolved để repair closer, và limit tính theo exact owner object.

**Ship rule telemetry mặc định hay fail compaction loud khi có tool-call output.** Bị từ chối vì telemetry giữ default no-rules explicit với helper opt-in, và hợp đồng summarizer giữ tool call trong `rawOutput` trong khi chỉ project text.

**Implement SDK wire-cancel ngay.** Hoãn thành RFC proposed: nó cần protocol method, negotiation capability và ma trận version-skew qua cả hai SDK, không vừa một batch behavior-fix.

## Consequences

Header image nói dối fail closed với đúng mã pixel-limit thay vì rủi ro memory amplification, tool search tạo đúng một spill artifact mỗi call capped, và thiết kế cancel SDK chờ như một proposal reviewable.

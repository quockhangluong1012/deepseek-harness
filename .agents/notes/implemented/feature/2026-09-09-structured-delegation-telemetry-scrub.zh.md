# Agent Note: Delegation có cấu trúc và scrubbing telemetry opt-in

Status: implemented

English | [中文](2026-09-09-structured-delegation-telemetry-scrub.zh.md)

## Problem

`tool-subagent` chưa từng expose `outputSchema` của seam: driver in-process đã hỗ trợ capture `structured_output` với two-phase commit, nhưng model chỉ có thể yêu cầu free text rồi tự parse JSON. Telemetry cung cấp waterfall `session-telemetry/record` mà không có rule starter tái dùng, nên mọi deployment tự viết scrubbing secret từ fixture e2e.

## Decision

Tool delegation chấp nhận `output_schema` object-rooted tùy chọn (`json`) cho foreground one-shot run, assert bằng `assertObjectJsonSchema`, chuyển tiếp thành `outputSchema` để cổng capability của provider sở hữu việc từ chối, và trả giá trị đã validate trong trường `structured` tùy chọn render sau text. Run background và continuable từ chối `output_schema` loud vì không có foreground result để mang nó. Telemetry thêm helper opt-in `sensitive.ts` (`scrubSensitiveValue`, `scrubSensitiveRecord`, `DEFAULT_SENSITIVE_PATTERNS` cho token dạng API, bearer credential, AWS key, PEM block) không bao giờ áp dụng mặc định; pass-through khi không mount rule vẫn explicit và được document.

## Alternatives considered

**Share job limit theo session id hay fail invariant khi còn call unresolved.** Bị từ chối vì test hiện tại ghim cả hai hợp đồng: limit tính theo exact owner object với bucket mới cho replacement, và cuối step cho phép call unresolved để repair closer.

**Fail compaction loud khi có tool-call output.** Bị từ chối vì hợp đồng summarizer giữ tool call trong `rawOutput` trong khi chỉ project text; test hiện tại ghim silent projection.

**Ship rule telemetry mặc định.** Bị từ chối vì đổi default pass-through là breaking; helper opt-in cộng documentation giữ hợp đồng explicit trong khi cho deployment starter hẹp.

## Consequences

Model có thể yêu cầu kết quả child machine-checkable mà không cần parse text, với rejection capability của provider vẫn loud và misuse background bị từ chối ở biên tool. Deployment có starter scrubbing đã test mà không đổi default no-rules, và tool catalog mang các trường mới `output_schema` và `structured`.

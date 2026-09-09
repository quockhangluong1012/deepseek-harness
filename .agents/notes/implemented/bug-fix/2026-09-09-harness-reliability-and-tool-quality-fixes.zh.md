# Agent Note: Các bản sửa độ tin cậy harness và chất lượng tool-call

Status: implemented

English | [中文](2026-09-09-harness-reliability-and-tool-quality-fixes.zh.md)

## Problem

Vòng lặp agent có thể để lại transcript không hợp lệ với provider khi bộ lập lịch tool thất bại sau khi đã ghi các sự kiện `tool/call`, tái sử dụng id attempt của assistant qua các lần resume session, và che lấp lỗi turn gốc khi commit biên `turn/end` cũng thất bại. Header request bị churn khi `maxTokens` không được khôi phục đối xứng với `reasoningEffort`, usage DeepSeek có thể phát ra số input rời rạc âm khi bộ đếm cache không nhất quán, và lỗi 429 mang wording tràn context lại retry thay vì phục hồi. Các tool model-facing có các khe hở nhỏ: `terminal send` mất mã abort, escalation `bash` đọc `.mode` từ policy undefined, `bash` background có race check-then-start, web fetch rò rỉ chi tiết transport ra model và chấp nhận hostname kiểu loopback trên đường proxied, `todo_write` chấp nhận list không giới hạn, các trường integer của goal lại dùng `number`, và sampling của compaction và title là nondeterministic. Text partial khi subagent thất bại là không giới hạn.

## Decision

`dsh-agent-loop` khởi tạo bộ đếm attempt từ các sự kiện durable `assistant/message` và `assistant/attempt` để `${sessionId}:${attempt}` duy nhất qua các lifecycle và ghi kết quả synthetic `TOOL_OUTCOME_UNKNOWN` cho mọi call đã start nhưng thiếu kết quả trước khi ném lại lỗi scheduler. `buildRequest` khôi phục `maxTokens` đã persist cho đúng route giống cách khôi phục `reasoningEffort`. `mapUsage` của DeepSeek kẹp các bộ đếm cache không nhất quán về tổng prompt đã báo, và `httpErrorCode` định tuyến wording tràn context trước `RATE_LIMIT` chung để overflow đi compaction thay vì retry vô ích. `terminal send` ném `TOOL_ABORTED` bằng `HarnessError`, escalation `bash` fail loud khi standing policy undefined, `bash` background kill job vừa đăng ký khi abort đến trong lúc đăng ký, web fetch trả lỗi model-visible chung trong khi giữ cause cho log và chặn các hostname `localhost` và metadata, `todo_write` giới hạn list ở 100 item và 2000 ký tự mỗi content, `revision` và `max_goal_rounds` của goal dùng `integer`, compaction và title đặt `temperature: 0`, và partial output của subagent trong failure bị chặn ở 8000 ký tự kèm thông báo cắt ngắn.

## Alternatives considered

**Để orphan của scheduler cho crash-recovery repair.** Bị từ chối vì đường turn-error live đóng turn với các sự kiện `tool/call` mồ côi mà không có `tool/result`, để lại transcript không hợp lệ cho step tiếp theo mà không cần crash.

**Fail session invariant khi `step/end` còn pending call.** Bị từ chối vì hợp đồng log cho phép call chưa resolve ở cuối step và repair tổng hợp các closer `TOOL_NOT_STARTED` và `TOOL_OUTCOME_UNKNOWN`; bản sửa scheduler live giảm orphan mà không đổi hợp đồng durable.

**Chặn workspace-inside-temp trên Windows ACL.** Bị từ chối vì temp parent nằm trên workspace tạo ra temp child là sibling, không phải kế thừa capability; kiểm tra một chiều hiện tại cộng bọc lỗi resolution là biên đúng.

**Fail closed với secret trong union khi redaction settings.** Tạm từ chối vì các schema hiện tại chạm secret qua các container đã được walker bao phủ trong test; ném lỗi toàn cục phá vỡ redaction và cần audit từng schema trước.

## Consequences

Session resume giữ id attempt duy nhất, lỗi scheduler giữ transcript hợp lệ với provider, header ít churn qua các step, telemetry usage sống sót khi bộ đếm cache không nhất quán, overflow kích hoạt recovery thay vì retry vô ích, lỗi abort và escalation vẫn machine-routable, abort background không để lại job mồ côi, lỗi web giấu chi tiết transport trong khi chặn các hostname private đã biết, input todo và goal bounded và đúng kiểu, output compaction và title deterministic, và failure lớn của child không còn làm phình context của parent.

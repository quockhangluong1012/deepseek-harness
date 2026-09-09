# Agent Note: Wire-level cancel cho SDK JSON-RPC request

Status: proposed

English | [中文](2026-09-09-sdk-wire-cancel.zh.md)

## Problem

Timeout của SDK client hiện chỉ là abandonment: transport xóa pending entry trong khi server vẫn chạy request cho tới khi runtime đóng. Caller timeout một turn dài không có cách reclaim work server-side nếu không xé toàn bộ runtime, và late result của prompt đã timeout vẫn mutate session state mà caller đã từ bỏ.

## Proposal

Thêm cancel ở tầng protocol: client gửi notification kiểu `session/cancel` mang request id bị abandon khi per-call timeout fire, và server map nó lên abort signal của turn đang chạy. Timeout giữ semantics abandonment hiện tại cho tới khi hai bên negotiate method mới, nên cặp mixed-version degrade về behavior hôm nay. Đường abort server-side đã tồn tại cho `close`; việc mới là routing request-id cộng advertisement capability trong `initialize`.

## Alternatives considered

**Giữ abandonment và document `close` như đường reclaim.** Thua vì xé runtime để dừng một turn hủy mọi session multiplex trên nó; chi phí tăng theo số session.

**Cancel bằng cách đóng rồi mở lại transport.** Thua vì reconnect không khôi phục cursor subscription durable và replay session state; cancel trúng đích rẻ hơn tái lập toàn phần.

**Deadline propagation server-side mà không có cancel method.** Thua vì chỉ client biết timeout của nó; server không thể suy abandonment từ im lặng trên stream multiplex.

## Acceptance criteria

`session/prompt` bị timeout dừng turn server-side mà không đóng runtime, late result không bao giờ commit sau khi caller đã abandon, cặp client/server mixed-version hành xử đúng như hôm nay, và protocol catalog mang method mới với version gate.

## Risks

Cancel đua settlement result cần first-wins settlement ở server nếu không late result có thể half-commit; negotiation capability thêm ma trận version-skew vào test tương thích hiện tại.

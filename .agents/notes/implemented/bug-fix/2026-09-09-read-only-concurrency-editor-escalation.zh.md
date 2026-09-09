# Agent Note: Cờ concurrency cho read-only và parity escalation cho editor

Status: implemented

English | [中文](2026-09-09-read-only-concurrency-editor-escalation.zh.md)

## Problem

Các tool read-only thiếu tín hiệu parallel-dispatch của scheduler: `lsp`, `glob` và `grep` không bao giờ đặt `isConcurrencySafe`, nên dispatcher PTC không phân biệt được chúng với tool mutation, và mô tả LSP không hề nói query tới một workspace bị serialize. `str_replace_editor` map denial sandbox mà không quảng cáo lượt retry `sandbox_permissions`/`justification` như `tool-fs` write/edit, nên mutation editor bị deny không còn đường escalate cho model.

## Decision

`lsp`, `glob` và `grep` đặt `isConcurrencySafe: () => true`; mô tả LSP document serialization per-workspace và ưu tiên fan-out sequential hay khác workspace, và schema `line`/`character` thu hẹp từ `number` sang `integer` khớp validation runtime. `str_replace_editor` quảng cáo `sandbox_permissions`/`justification` dưới backend confining, resolve mutation qua policy escalation đã approve với validation pairing và lỗi misconfiguration loud, và map denial sang marker chung cộng hint escalation. Workflow và `ralph` giữ nguyên không flag vì thực thi script có side effect.

## Alternatives considered

**Đánh dấu workflow và `ralph` concurrency-safe.** Bị từ chối vì thực thi script và loop làm thay đổi state; flag chỉ dành cho read side-effect-free.

**Share job limit theo session id hay fail invariant khi còn call unresolved.** Bị từ chối vì test hiện tại ghim cả hai hợp đồng: limit tính theo exact owner object và cuối step cho phép call unresolved để repair closer.

**Fail compaction loud khi có tool-call output hay ship rule telemetry mặc định.** Bị từ chối vì hợp đồng summarizer giữ tool call trong `rawOutput` trong khi chỉ project text, và telemetry giữ default no-rules với helper opt-in.

## Consequences

Parallel scheduler dispatch nhận ra các tool read-only, hướng dẫn fan-out LSP khớp thực tế provider, denial của editor mang cùng đường retry như `tool-fs`, và tool catalog mang tọa độ LSP đã thu hẹp.

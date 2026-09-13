# Agent Note: Webhook replay suppression window

Status: implemented

[English](2026-09-13-webhook-replay-suppression-window.md) | 中文

## Problem

`WebhookRuntime.dispatch` 对每次交付运行每个规则：`deliveryId` 仅是来源信息，没有去重。提供方在传输失败时会重投，运营者也会从提供方控制台手动重投；每次重复都会产生一个新的根 Session——无界资源消耗，外加同一 payload 的重复提示词注入面。

## Decision

`dispatch` 现在丢弃一小时窗口内重复的（kind、source、deliveryId），确认但不再运行规则。存储是进程内有界的（1 万条，最旧逐出；过期条目在下次 dispatch 时清除），窗口是固定安全不变量，不是插件配置。超出窗口、重启后或 id 不同的重复仍会运行规则——抑制是重放保护，不是幂等，包 README 与子系统文档已如是声明。

## Alternatives considered

**持久化去重表。** 可跨越重启，堵住重启后重放缺口——但需要存储域、schema 与崩溃恢复故事，而 fire-and-forget 运行时的契约本就是“无交付数据库”。落选：机制过重；残余缺口改为文档声明。

**可配置窗口与上限。** 让部署方自行调节保留期——但所有部署想要的都一样（丢弃意外重投、有界内存），而 `DEFAULT_*` 常量按 tunables 策略不算可配置性。落选：为不存在的分歧用例增加配置面。

**适配器侧去重（按提供方）。** 在 dispatch 前拦截重复——但每个现有与未来适配器都要重写一遍，且跨适配器重复（同一事件经两个来源）仍会扇出。落选：N 处实现取代一处 choke point。

## Consequences

断言重复会再次调用规则的测试（"intentionally invokes a rule again"、"creates one Session per matching repeated delivery"）已按新契约重写。收益：传输重试与控制台重投不再倍增 Session。代价：一小时后或重启后的重复仍会重复——需要幂等的规则仍自行负责，文档已声明。

## Testing

`runtime.spec.ts`：窗口内重复被丢弃而新 id 照常运行、窗口过期后重复再次运行（fake timers）、会话创建层面每个重复只建一个 Session。经 stash 对照：丢弃测试在修复前失败。webhook + webhook-github 全套件（76 个测试）通过；作用域内 `tsc --noEmit` 干净。

# Agent Note：Batch 7 仪表盘比率（`/curator status` 与历程页）

Status: implemented

[English](2026-09-16-batch7-dashboard-rates.md) | 中文

## Problem

Review-v6 Batch 7（P4 polish）要求两件事：按已修复的 G1/G2 刷新子系统页，以及一个展示新加的 `cacheHitRate` 与 `failureRate` 的小仪表盘。G5 的悬挂项（`dsh-client-ui-evolution` 是否存在）答案是有，用户在 CLI 与"CLI + UI"之间选了后者，附带一个条件：UI 改动必须连 desktop/Electron 一起检查。

## Decision

**两个比率、两个界面、每处一套公式。**`/curator status`（`executeCuratorStatus`）新增两行：来自 `ctx.usageLedger.summary('today', signal)` 的今日缓存命中率，以及 telemetry 全体条目上的技能失败率汇总 `ΣfailureCount / Σ(useCount + failureCount)`——Batch 3/5 的公式，第三次使用。任一比率在其来源未挂载时具名说明（`usage ledger is not mounted`、`no recorded loads`），沿用该文件已有的 `telemetry unavailable` 写法。历程页经 `EvolutionCuratorStatus.cacheHitRate / skillFailureRate`（`null` = 来源缺席或为空）携带同样的两个数字，作为卡片 meta 行渲染在运行列表上方，为 null 则隐藏。零运行也有比率；`empty` 文案只管运行列表。

**接线说明。**Status 执行器把 `invocation.signal` 穿进 ledger 读取。UI Host 面没有调用方 cancellation，因此它的 ledger 读取跑在一个永不 abort 的 signal 之下，并有注释写明（先例：gateway 的 `NEVER_ABORTED_SIGNAL`）。遥测依赖进了 UI devDependencies 外加 host project reference——Batch 5 给评分器接依赖时走过的同样两步。没有新 CSS：卡片复用 `.meta`。没有 wire 变更：`status()` 保持零参数，生成的 Remote 描述子只多了两个字段。

**Desktop/Electron。**本仓库没有 Electron 壳；桌面端与 web 端都消费 `web-app` bundle 加 `api/remotes`。因此检查就是全仓库 typecheck（两个消费者对着加宽后的 status 类型都能编译）加 client-face 构建——均为绿。没有新增运行时依赖，桌面 bundle 不会多出任何东西。

## Alternatives considered

- **只做 CLI 仪表盘** —— review 为 G5 悬挂项留的退路。未采用：`dsh-client-ui-evolution` 确实存在，用户在 CLI 与「CLI + UI」之间选了后者，附带条件是 UI 改动必须连 desktop/Electron 一起检查。
- **沿用 review 的 `1 - failureCount/useCount` 比率** —— 未采用：CLI 那行与页面都用 Batch 3/5 的汇总式 `ΣfailureCount / Σ(useCount + failureCount)`，三处读同一套公式。
- **来源未挂载时什么都不说** —— 未采用：任一比率都具名说明缺失来源（`usage ledger is not mounted`、`no recorded loads`），沿用该文件已有的 `telemetry unavailable` 写法。
- **为 G1/G2 在子系统页手写 prose** —— 未采用：该页概述本来就描述了修复后产生的 brief 机制，regen 已带上新的 `status` 面。

## Consequences

`/curator status` 多打印两行——今日缓存命中率与技能失败率汇总——历程页则把同样的数字作为卡片 meta 行显示在运行列表上方（`curator.cacheHit:{"percent":73}` 与 `curator.failureRate:{"percent":13}`），任一来源缺席或为空则隐藏。

status 类型加宽了两个可空字段，因此 `EvolutionCuratorStatus` 的每个消费者都要对着它们重新编译；wire 本身没变，因为 `status()` 仍不收参数，生成的 Remote 描述子只多了这两个字段。

代价：`dsh-client-ui-evolution` 现在依赖遥测包（devDependencies 加 host project reference——Batch 5 给评分器接依赖时走过的同样两步），而 UI Host 面的 ledger 读取跑在永不 abort 的 signal 之下，因为该面没有调用方 cancellation，那里的读取无法被打断。两个包早于本次改动的覆盖缺口与 lint 错误仍在（见 Testing）。

## Testing

CLI：更新三处 status 断言，加一个比率测试（ledger fake：142 请求上 73.1%；两个技能 2/16 负载——顺带练了舍入到 13%）。UI host 面：null 比率断言加 fake ledger/telemetry 上的比率测试。页面：比率渲染为 `curator.cacheHit:{"percent":73}` / `curator.failureRate:{"percent":13}`。101 CLI + 39 UI 测试全过；新增代码全覆盖。两包其余的覆盖缺口与 lint 错误早于本次改动（Batch 4 未提交的 `staged`/`ledger` 动词缺 usage-error 测试；未动行上的 `no-non-null-assertion` 与 `max-len`），留给各自 owner。

## Deferred

GEPA 有效性指标（review §6）仍为 N/A——Batch 6 按用户指示跳过，尚无 optimizer 三元组可比。子系统页不需要为 G1/G2 写手写 prose：其概述本来就描述了修复后产生的 brief 机制，regen 已带上新的 `status` 面与分选/遥测方法。

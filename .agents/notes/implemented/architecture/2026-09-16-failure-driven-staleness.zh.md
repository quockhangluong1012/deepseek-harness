# Agent Note：失败驱动的技能过期

Status: implemented

[English](2026-09-16-failure-driven-staleness.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §22 要求演进系统能发现旧技能已不再有效——经由时间衰减、近期失败激增、分布漂移、工具/版本变化、低检索效用、冲突新证据——让技能沿 `active → suspect → stale → archived` 流转，而不是永远信任。整理器此前只用一个信号：自上次加载起的闲置天数。每天被加载但每次都失败的技能永远是 `active`，而它已腐坏的证据就躺在一缝之隔的自家遥测记录上（`trustFailures`、`lastTrustFailure`、加载 `failureCount`）。且流转是单向向下、无路可回，因此任何不带复活路径的失败规则都会成为噪声信号上的棘轮。

## Decision

**闲置照样把技能往下送；无人回应的失败证据现在也送；一次新鲜的成功同时回答两者。**

- **`decideTransition` 吃下本趟已持有的数据。** 不新增读取：通过循环手里有完整 `SkillUsageRecord`，纯函数多拿一个证据结构（`trustFailures`、失败未回应标志、加载数、失败数、最近结果、加载新于失败标志）加一组门限（`staleTrustFailureFloor`、`stageMinUses`、`stageFailureRate`）。
- **`active → stale` 新增两条规则。** 被归因的信任失败数达到下限（新增 `staleTrustFailureFloor`，默认 3——与记忆 `refutationFloor` 同数）且没有更新的加载回应它们，或在至少 `stageMinUses` 次加载上加载失败率超过 `stageFailureRate` 且最近一次加载是失败的。失败率规则复用分选的一对阈值（20 次、0.3）而不另起平行旋钮，并沿用分选的理由格式（`failures 3/4 exceed 50%`），于是分选仍是证据、移动跟随同一裁决。理由如既往指明原因。
- **两条失败规则只在无人回应时开火。** 往后的一次成功加载让它们安静，而不是与下面的复活规则对打摆动：信任规则要求被归因失败新于上次加载，失败率规则要求最近一次加载是失败的。正是这一点让单向棘轮的安全延伸成为可能——规则与复活在构造上互补，而非靠调参。
- **`stale → active` 靠一次回应的成功。** 最近一次加载成功、仍在 stale 窗口以内（`idleMs <= staleMs`）、且新于最近一次被归因失败。超过 `archiveAfterDays` 照样归档——期限永远优先于复活，没有一次成功加载能复活死透的技能。`stale → archived` 不变（只看闲置），`pinned` 照样跳过一切移动。
- **只加一个旋钮，不加三个。** `staleTrustFailureFloor` 是唯一的新配置；失败率规则借用它本就认同的分选阈值。

## Alternatives considered

- **不要未回应守卫的失败证据。** 实现中否决：`trustFailures` 单调（成功不清零），纯下限规则会让复活的技能在下一趟立刻再 stale、永远摆动——一架拍动的棘轮。这个守卫是顺着 `markUsed` / `markFailed` / `recordTrustObservation` 的时间戳语义追出来的，不是评审时想到的。
- **移动与分选用两套下限。** 否决：两个测同一失败率的旋钮会在含义上漂移；分选即证据、移动跟随同一裁决，是一条规则的两个读者。
- **任何成功加载都复活，不管多旧。** 否决：没有 stale 窗口约束，因闲置致 stale 的技能会被一个远古 `ok`（`lastOutcome` 常驻）复活，冲掉复活本要配合的闲置规则。窗口约束让闲置 stale 保持粘性、失败 stale 保持宽恕。
- **加 `staledAt` 时间戳以精确排序复活。** 暂否：它要动遥测记录 schema，只为换一个相对排序（`lastUsedAt` 对 `lastTrustFailure.at`）已经回答的比较，仅剩一个已文档化的近似——手工标 stale 之前的 `ok` 照样复活，因为标签自己的时刻不可知。要把技能按住不动，请用 pin。
- **跨缝信号（经验反驳、工具/版本变化、检索效用）。** 推迟而非否决：经验反驳住在 `evolution-memory`，检索效用（§23/24）尚不存在。两者都要开本批刻意不开的缝；README 已把它们记为 §22 剩下的缺口。

## Consequences

边用边败的技能现在会变 `stale` 而不是永远受信，恢复的技能会回来——生命周期反映证据，而不只反映日历。代价：恢复后累计的 `trustFailures` 计数不清零，因此一次无人回应的被归因失败会再 stale（README 已写明）；每周在恢复与失败间横跳的技能会以每趟一次的频率拍动 `stale ↔ active`，诚实但嘈杂；复活回应任何来路的 stale 标签，因此操作员要按住技能请用 pin，而不是手工标 stale。

验证：7 个通过级新测试（信任下限流转及理由、被回应的失败原地不动、从未加载的失败流转、以失败结尾的失败率流转及理由、以成功结尾的失败率原地不动、复活及理由、期限战胜复活），外加调序后的闲置 fixture 证明预置 stale 标签遇新鲜 `ok` 会复活。`packages/evolution/evolution-curator/src` 的语句、分支、函数、行四项 100%。

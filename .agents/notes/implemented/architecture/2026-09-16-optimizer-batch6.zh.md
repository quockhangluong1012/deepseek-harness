# Agent Note：Batch 6 优化器（变异 + Pareto + 分选部署）

Status: implemented

[English](2026-09-16-optimizer-batch6.md) | 中文

## Problem

Review-v6 §4.4 步骤 4-5 要求最小优化器：复用整理器 LLM 模式的变异循环、基于评分器三元组的 Pareto、只分选不自动部署。Review 有两处字面指示无法执行：语料无法从 trajectory 导出挖掘（Batch 5 note），整理器的双工具裁决循环服务于多技能 consolidation，不服务于单技能变异。本 batch 的设计在开工前已解决这两点。

## Decision

**新包 `dsh-evolution-optimizer`，服务 `ctx.evolutionOptimizer`。**`optimize({skill, scenarios, scopeId, originSessionId, agent?, run?, evidence?, signal?})` 跑：触发门（评分器的 `shouldOptimize`，不复制）→ 经 `ctx.skills.get` 读正文 → 一次 `ctx.llm` generate（组织方式同整理器输入：固定指令加字节预算，只砍证据不砍正文）→ 同一 harness 下重评基线与每个变体 → Pareto 选中 → 一次 `kind: 'skill'`、`op: 'patch'` 的 `stageWrite`。

**变体隔离是结构性的。**每个正文在全新的 `DSH_HOME` 覆盖层（`skills/<name>/SKILL.md`）内评分，覆盖层经 runner 环境叠入；用户现网技能永不触碰，覆盖层在 `finally` 中删除。基线也在同一覆盖层 harness 下重评而非沿用旧数，因此比较天然公平。

**Pareto 纯粹且严格。**（pass、token、wallTimeMs）上的支配关系；优胜者必须支配基线，平局按 token 再按耗时再按变异顺序。其他一切——空变异作答、未被击败的基线、语料跳过——都以带理由的 `no-improvement` 或 `skipped` 返回，什么都不分选。

**部署沿用现有技能协议。**分选 payload 携带 `{skill, body, baseline, winner}` 瘦三元组作审批证据；人类用 skill_manage 写技能，`/skills approve` 消除条目。优化器未挂载出货（与评分器一样）：在某个部署给出 agent 路径与 provider/model 路由之前，没有 profile 挂载它；此前的 `/curator optimize <skill> <scenario...>` 如实报告 `not mounted`。

## Alternatives considered

- 按 review 的字面指示从 trajectory 导出挖掘候选语料——未采纳：Batch 5 已确认语料无法在那里挖掘，因此由调用方提供 `scenarios`。
- 复用整理器的双工具裁决循环做变异——未采纳：那个循环服务于多技能 consolidation，不服务于单技能变异。
- 优胜即自动部署——未采纳：优化器只分选一次 `stageWrite`，仍需人类用 skill_manage 写正文并以 `/skills approve` 消除条目。
- 沿用基线旧分、不重评基线——未采纳：基线与每个变体在同一覆盖层 harness 下运行，比较因此天然公平。
- 让优化器自带触发门——未采纳：调用评分器的 `shouldOptimize` 而不复制，规则只留一处实现。
- 现在就给优化器挂上某个 profile——未采纳：它与评分器一样未挂载出货，在某个部署给出 agent 路径与 provider/model 路由之前，`/curator optimize <skill> <scenario...>` 报告 `not mounted`。

## Consequences

- 只有严格支配基线（评分器的 pass、token、wallTimeMs 三元组）的变异才会呈到人面前；其他一切都是有理由的 `no-improvement` 或 `skipped`，什么都不分选，因此坏变异到不了技能。
- 评分永不触碰用户现网技能：基线与变体都在 `finally` 删除的全新 `DSH_HOME` 覆盖层内评分。
- 部署路径对评审者不变——一次 `kind: 'skill'`、`op: 'patch'` 的分选 payload，其瘦三元组即审批证据——且在某个部署挂载优化器之前不可达。
- 触发规则现在有了第二个消费者，评分器因此补上了它从未声明的 `Context` augmentation。
- 天花板被写下来而非藏起来：覆盖层只提供 `SKILL.md`，依赖兄弟文件的变体可能误评，纯提示词变体在 replay 下同分（README）。
- `'evolution-optimize'` 是 `purpose` 归因 union 的第三份复制；Config agent 只带三个必填路径，因为 schemastery 在 `exactOptionalPropertyTypes` 下拒绝嵌套 `z.object` 里的 bare 可选成员。

## Testing

29 个优化器测试（纯 pareto/mutate 加 fake 缝上的服务编排：每个 skip、两个 throw、空变异、基线/变体 skip 传递、断言分选 `kind`/`op` 的获胜路径），5 个 CLI 测试（usage、未挂载、作用域外、结果文案、错误穿透）。包内语句/分支/函数/行 100%；106 个 CLI 测试全过。

## Fixes found while building

- 评分器从未声明自己的 `Context` augmentation，因此 `ctx.get('evolutionScorer')` 落为 `any` 并在新消费者处触发 `no-unsafe-assignment`。给评分器补了三行 `declare module`（其他每个接缝早就有）。
- `purpose` 归因 union 在三处复制（`dsh-llm` 选项、DeepSeek 扩展请求、replay 适配器的透传）。新的 `'evolution-optimize'` 值三处都加了；统一它们是更大的重构，不动。
- Schemastery 在 `exactOptionalPropertyTypes` 下拒绝嵌套 `z.object` 里的 bare 可选成员，因此 Config agent 只带三个必填路径；per-request 覆盖仍接受完整 `AgentUnderTest`。

## Deferred

语料挖掘（与 Batch 5 一致）；兄弟感知覆盖层（覆盖层只提供 SKILL.md——依赖改写兄弟文件的变体可能误评，已写进 README）；纯提示词变体在 replay 下同分（harness 实话，已文档化）。

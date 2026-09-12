# Agent Note: 演进记忆存储——经验 / 画像 / 暂存写入

Status: implemented

[English](2026-09-11-evolution-memory-store.md) | 中文

## 问题

Harness 在回合之间学不到任何东西：用户的纠正在 `turn/end` 即蒸发，后台评审没有地方暂存提案，而演进式 Harness 规范（[`specs/evolutionary-harness.spec.md`](../../../../specs/evolutionary-harness.spec.md))在评审器、注入器、治理器与安全护栏落地之前需要一个持久化地基。复用 workspace-memory 记录是错的：演进作用域横跨 profile 与 workspace，带着双层经验/画像文档与需审批的写入，而 workspace memory 维持每目录一份文档加直接写入。

## 决策

在新的 `evolution/` 分组交付 `@deepseek-ai/dsh-evolution-memory`（`ctx.evolutionMemory`），机制相同处沿用 [workspace-memory 决策](2026-09-10-workspace-memory.zh.md)，规范另有要求处分道扬镳。`evolution_memory` 域（`per-record`、版本 1、损坏记录大声失败）中每个 `EvolutionScopeId`（`profile:workspaceId` 或 `profile:global`）一条记录：用户编写的指令、模型维护并带 `memoryUpdatedAt` 的 `agentLessons` 与 `userProfile`、新条目在后的上下文条目、新条目在前并受 `maxOutputs` 裁剪的产出索引、来源为 `foreground | background_review | user-edit | rebuild` 的 `lastExtraction`，以及旧条目在前的 `staged` 队列。读取从已校验内存同步进行；`capacityBytes` 必填，其余上限均为经校验的 `Config` 字段（`maxAgentBytes` 65536、`maxUserBytes` 32768、`maxContextItemBytes` 262144、`maxContextItems` 50、`maxOutputs` 200）。容量计入指令加经验加画像加条目大小；产出与暂存写入排除在外，摘要仅覆盖四个计费输入。增量经验编辑接受一个期望恰好出现一次的子串：未知以 `evolution/item-not-found` 拒绝，歧义以携带至多五条摘录的 `evolution/ambiguous-match` 拒绝，完全重复的追加直接返回而不写入。`stageWrite` 把记忆或技能提案暂存于容量之外；`approveStaged` 先应用记忆操作（上限或子串拒绝时保留条目），仅移除技能条目；`rejectStaged` 直接丢弃任一条目；并发审批经由域写入链恰好结算一次。`GenerateOptions.purpose` 在 `'workspace-memory'` 之外新增 `'evolution-review'`，`dsh-llm-deepseek` 对其关闭 thinking，因为提取是确定性派生，推理 token 换不来任何收益。`evolutionary-harness` 子系统页面、Cordis 目录行、配置与持久化目录条目、`evolution/` 分组导览同批交付；不新增任何组合行，因此在评审器切片挂载本存储之前，所有 profile 的行为保持字节一致。

## 备选方案

- **把存储放在 `workspace/` 分组。** 否决：规范首选 `evolution/`，作用域不是 workspace，评审器、治理器与预算包需要一个不属于按目录记忆的家；分组导览改为链接相邻的 workspace 子系统。
- **复用 `workspace_memory` 域。** 否决：记录形态不同（双层加暂存队列），摘要覆盖字段不同，一条损坏的演进记录绝不能阻塞 workspace memory 打开；第二个域让失败与容量边界各自独立。
- **给指令加按字段上限。** 否决：规范只以作用域容量约束指令，且指令是用户编写的规则而非模型写入的增长；再加一层上限会拒绝规范本可接受的部署。
- **按条目的经验来源与历史。** 否决首版，与 workspace memory 同理：每层一份带上限文档可直接编辑，子串编辑操作是未来数组形态唯一的触点。
- **给暂存写入另设域。** 否决：暂存条目属于它将要变更的作用域，审批需要记录与条目在同一写入链；暂存载荷按构造排除于容量之外，不需要第二个存储。
- **以导入方式与 `dsh-workspace-memory` 共享实现。** 否决：克隆门禁要求两个存储在 token 层面互不相同，且语义确有差异（双层、子串编辑、暂存审批）；共享基类只会让新家族无谓耦合按目录记忆。

## 后果

评审器、注入器与治理器从此有了持久、带上限、可回滚的写入目标，审批暂存内建；代价是多一个存储域，以及第二套易与 workspace memory 混淆的记忆词汇。暂存写入按设计无上限，未评审的积压会一直增长，直到被批准或驳回。本存储不注册 prompt、工具或会话事件，模型可见行为不变。

## 测试

52 例存储规约锁定：缺席读取、作用域标识校验、按字段与容量上限拒绝且不改变记录、子串替换/删除的歧义与有限摘录、重复追加幂等、暂存的暂存/批准/驳回全流程（含畸形载荷与并发双重批准）、产出幂等与裁剪、排除产出与暂存的摘要覆盖，以及基于真实存储/域栈的无引用泄漏读取；语句、分支、函数、行四项文件级 100%。`llm-deepseek` 序列化规约锁定 `purpose: 'evolution-review'` 关闭 thinking。作用域内 lint、类型检查、Cordis/配置/持久化目录新鲜度、翻译配对与包约束门禁均通过；其余整树门禁失败早于本变更存在。

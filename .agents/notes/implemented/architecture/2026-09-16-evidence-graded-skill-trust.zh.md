# Agent Note：证据分级技能信任、修订谱系与正文回滚

Status: implemented

[English](2026-09-16-evidence-graded-skill-trust.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §58 已是决策完备的，但尚未实现：失败观测只被展示、不做任何决定；技能生命周期仅按流逝时间推进；`skill_manage` 盲目写 `SKILL.md`（无修订、无哈希、无前像）；`applyConsolidation` 原样提交 fork 返回的正文；回滚能恢复生命周期状态与被搬移的包，却从不恢复被补丁过的正文。

## Decision

一个受治理的回路、七个步骤，且必须在同一变更中落地，因为第 4 步消费第 1 步的形状：

1. **分级信号**（`dsh-evolution-feedback`）。`signals(sessionIds, limit)` 为 `summary` 已有的同一份汇总分级：只有当失败的调用本身被观察到时 `evidenceStatus` 才是 `complete`；当某个 complete 信号达到 `triggerReviewSessions` 个不同会话时 `actionability` 为 `trigger_review`，低于此值为 `ranking_only`，无归因则为 `observe_only`。`summary` 保持其原有顺序。
2. **信任与谱系**（`dsh-evolution-skill-telemetry`）。新记录为 `trusted`（尚无对其不利的证据）；模型写出正文（`markAgentCreated`）或任何编辑（`markPatched`、`markRevised`）都会把技能降为 `provisional`，清空已计入的会话，并以当时见过的最新会话为锚点，使修复前的证据无法自我晋级。`recordTrustObservation` 在带归因的失败上降级，并计入比锚点更新的会话；`markRevised` 对写入的确切字节求哈希，因此 `contentSha` 只在一处定义，且修订链按技能线性推进。
3. **作者身份**（`dsh-evolution-skill-manage`）。`create`/`patch`/`edit` 现在携带模型作者身份，并记录其所写正文的修订；附属文件写入仍会重置信任，但不推进修订。
4. **证据进入决定**（`dsh-evolution-curator`）。每趟经由 `recordTrustObservation` 为每个技能记录一次信任观测；`dryRun` 下跳过该步；存储出错时记日志而绝不让整趟失败。删除 `SurveyFailure`：观测携带分级后的 `FeedbackSignal`，以及该技能的信任、修订、`contentSha` 与最近一次归因失败；归并提示写明：只有临时状态技能或 `trigger_review` 信号才值得 patch 或 archive。
5. **准入闸与前像**（`dsh-evolution-curator`）。`patch` 裁决只有在正文保留指向该技能的合法 frontmatter 时才被接受（与 `skill_manage edit` 同一不变式、同一实现）；被替换的原文本存为 `blobs/<sha>.md` 正文 blob，台账行携带真实的 `before`/`after` 哈希。`rollbackPass` 先验证每一份前像，再恢复这些正文；在正文开始留前像之前写下的行没有前像，直接跳过。
6. **挂载**——`evolution-feedback` 在整理器之前早已挂载于 `packages/bundle/web-app/cordis.patch.yml`；只需在注释里点名第二个读取方。
7. 文档、目录与本 Note。

## Alternatives considered

- 让归并提示继续只看 `summary` 的扁平计数失败、由模型自行判断——未采纳：计数不等于决定，因此 `signals()` 为同一份汇总分级（只有失败的调用本身被观察到时才是 `complete`），并告知提示：只有临时状态技能或 `trigger_review` 信号才值得 patch 或 archive。
- 按计划把 `signals()` 构建在 `summary(sessionIds, limit)` 之上、先应用调用方的上限——未采纳：仅凭计数的失败可能把调用方真正需要的关键信号挤出上限，因此先对整份汇总分级、排序后再切分。
- 用信任决定模型可以加载什么——未采纳：这是超出要求的产品行为变更（§58.12）；信任只被记录与展示。
- 在准入闸里再写一份 frontmatter 检查，或像 `applyConsolidation` 那样信任裁决给出的正文——未采纳：同一不变式、同一实现，复用 `skill_manage edit` 已有的检查；正是那次不校验的写入留下了一个坏掉的技能且无路可退。
- 把 OpenSpace 的三闸行为评估加进准入闸——未采纳：它需要基线对候选的 replay 语料，在尚无 agent 创建的技能可评估之前延期（§58.1 第 10 行）。
- 为 `markAgentCreated` 另设一个后台作者身份标志——未采纳：`createdBy: 'agent'` 现在表示"模型经 `skill_manage` 写了它"，比旧 JSDoc 的后台复审框架更宽，可以接受是因为 `consolidate` 默认为 `false`，且 `/curator adopt`、`/curator pin` 与 `protectedNames` 仍在；更窄的语义需要它自己的标志（§58.11）。

## Consequences

- 回路闭合：工具调用失败分级为信号，信号经由整理器的趟次推动技能信任，观测同时把两者带进归并提示。
- 技能生命周期不再仅按流逝时间推进——只有临时状态技能或 `trigger_review` 信号才值得 patch 或 archive。
- 任何正文或附属文件写入都会重置信任、清空已计入的会话并重新锚定该技能，因此修复前收集的证据无法把没拿到修复的技能晋级。
- 正文可恢复：每次写入都带修订与 `contentSha`，补丁存下 `blobs/<sha>.md` 前像，`/curator rollback --id` 报告它恢复了哪些正文。在正文开始留前像之前写下的行没有前像，直接跳过而非强行恢复。
- 会丢掉 frontmatter 的补丁在提交前即被拒绝；`patch` 工具文案写明 frontmatter 要求，使新闸不可能拒绝每一次模型补丁。
- 信任只被记录与展示（survey、`/curator status`）；它不限制模型可以加载什么，且按整理器的趟次节奏移动，因为它需要彼此独立的会话而非同一会话内重复的轮次。

## Deviations from the plan

- `signals()` 对整份汇总分级、排序后才切分：若按计划"构建于 `summary(sessionIds, limit)` 之上"，仅凭计数靠前的失败会把调用方真正需要的关键信号挤出上限。
- 只打补丁、不移动任何包的趟次也会记下自己的 `pass` 台账行，好让 `/curator rollback --id` 能触及这些正文。否则正文恢复只有在同一趟还归档或归并了别的东西时才可达。
- 补丁台账的 `after` 哈希由已提交的正文算出，而不是取自存储的返回值——那两侧本就是同一个哈希，该分支已删除。
- `patch` 工具描述与指令行现在写明替换内容必须包含 frontmatter；否则新的闸会拒绝每一次模型补丁。

## Fixes found on the way

- `packages/skill/evolution-skill-telemetry/src/` 在源码平面上带着被跟踪的构建产物（`*.js`、`*.js.map`、`*.d.ts`、`*.d.ts.map`）。这些文件让该包在测试全通过的情况下只测出 66% 覆盖率。已删除；删除后该包测得 100%。仓库其余镜像属 batch 8 已延期的专项。
- `evolution-scorer` 的类 JSDoc 落在了它的 `declare module` 块上，被 `verify-cordis-catalog` 拒绝；同一生成器还要求为 `evolutionScorer` 以及本次新增的 feedback、telemetry 类型补上 `SERVICE_PAGE` 与未分类类型条目。
- 跑 `hygiene` 又暴露出同一工作树里两处归属明确的缺口：`evolution-optimizer` 的 README 从未记录它为何不发布不变量配套包，`python/sdk-runtime` 在 session-query 向量通道把 `@deepseek-ai/dsh-embeddings` 变成 `session-query-sqlite` 的必需 peer 之后从未声明它。两者都已在本次修好。其余 hygiene 失败（vendor rescope、publint 的 `./src/*` 导出、需要完整构建的 NodeNext 类型、另一 agent 脏 `vendor/` 上的 vendored links，以及 `client/ui-*` 的 react/clsx 归位）在 `HEAD` 上同样复现，属 batch 8。

## Testing

`signals` 的分级、排序与上限行为；整条信任阶梯（含锚点排除与空操作写入）；来自 `skill_manage` 与 `markRevised` 的修订链；整理器的降级、成功、试运行与存储失败路径；准入闸的两种拒绝理由；把正文恢复到先前确切字节并跳过无前像行的回滚；`/curator status` 的信任计数与 `Restored bodies:` 行。`evolution-feedback`、`evolution-skill-telemetry`、`evolution-skill-manage` 与 `evolution-curator` 的语句/分支/函数/行均为 100%；命令侧 108 个测试通过。

## Left alone

`command-evolution` 仍缺 batch 4 的 journey 导出参数解析与 ledger／未知动词用法错误的覆盖，`client-ui-evolution` 也保留着自己的缺口——两者都早于本次变更，且都不在这条回路上。信任只被记录与展示，不限制模型可以加载什么。

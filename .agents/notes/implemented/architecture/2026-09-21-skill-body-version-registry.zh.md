# Agent Note：持久的技能正文版本注册表

状态：已实现

[English](2026-09-21-skill-body-version-registry.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` §51 将「版本化产物注册表」列为 P0 #8，§34/§36 要求可复现实验具备产物谱系。Harness 只有每个技能正文链的末端——telemetry 记录上的 `revision`、`contentSha`、`parentRevisionSha`——但没有持久历史：一次编辑之后，上一版本的身份只存在于当前记录的 `parentRevisionSha` 中，没有任何东西能回答「这个技能存在过哪些版本、按什么顺序、谁替换了谁」，除非重读文件。

## 决策

扩展现有的修订链持有者 `dsh-evolution-skill-telemetry`，在同一域中加入持久的版本注册表：

1. **`versions` 表**：位于 `evolution_skill_usage`，键为 `name\0revision`，存放 `{ name, revision, contentSha, parentRevisionSha, at }`。域升级到版本 2 并声明 `compatibleVersions: [1]`：新表初始为空，因此 v1 文档可原样打开（与 `evolution-feedback` 增加 `reflections` 表时相同的模式）。
2. **每次正文变更提交一行。** `markRevised` 在记录写入成功后追加一行版本，使用它已哈希过的确切字节。同样的字节再来一次，对记录与注册表都是空操作；被排除的来源（`bundled`/`hub*`）不保留任何行，与既有排除一致。
3. **查询面。** `versions(name)` 按从旧到新列出技能已提交的修订，均为脱离副本——无需重读文件即可查询谱系。`drop(name)` 连同记录一起清除注册表，因此清除一个技能会遗忘其全部历史。
4. **运维面。** `/curator history <name>` 渲染链条——`r2 <sha8> ← r1 <parent8> (at)`——与同样只读 telemetry 的 pin/unpin 动词并排。

## 备选方案

- 新建 `dsh-evolution-registry` 包，用自有域承载通用产物注册表——否决：技能是当前任何回路唯一会写入的产物，链条的持有着已存在，而只有一个种类、零消费者的通用注册表是没有当前需求的投机状态。
- 在版本行中存放完整正文——否决：正文已经按内容寻址（`contentSha`），curator 也把正文前像存放在其 `blobs/<sha>.md` 存储中；注册表记录身份与谱系，而不是重复副本。
- 把版本行放进 usage 记录（每条记录一个列表）——否决：记录是每次 pass 都会克隆的按技能状态，记录内无界历史会膨胀计数器并复杂化 schema。独立表保持记录形状稳定。
- 从 curator ledger 的 `patch` 行重建历史——否决：只有归并补丁会到达该 ledger；`skill_manage` 写入与回滚恢复从不落 ledger，因此 ledger 不是完整的注册表。

## 后果

- 技能产物注册表持久且可查询：每份已提交的正文都有带父哈希与记录时刻的有序谱系行，实验可据此重建生效的产物版本。
- 所有 `markRevised` 调用方——`skill_manage` 的 create/patch/edit、curator 补丁提交、正文回滚恢复——都会自动记录历史；正文变更只有一个提交点。
- 域以 `compatibleVersions: [1]` 原样打开旧 v1 存储；只有新的历史写入触及新表。
- `drop` 让清除保持一致：被清除的技能不会留下孤儿历史行。

## 与计划的偏差

除常规外没有：落地时调整了版本表访问器与路径常量（字段改名以避免与公开的 `versions` 方法冲突），`/curator` 用法字符串加入了 `history <name>`。

## 途中修复

无：同一变更中更新了 `command-evolution` 既有的用法字符串断言以加入新动词。

## 测试

`telemetry.spec.ts` 中的注册表阶梯：每次提交修订一行且父哈希与时刻正确、内容不变不产生行、读取为脱离副本、被排除来源无行、`drop` 清除历史而兄弟技能的历史在前缀清扫后仍在，以及存储启动前读取抛出异常。`/curator history` 命令：带谱系的渲染、无修订消息、用法错误、未挂载存储错误。37 个 telemetry 测试与 135 个命令测试通过；telemetry 语句/分支/函数/行 100%。

## 顺带不动

注册表记录身份与谱系，不存正文（curator 前像存储仍是内容档案），也尚未被实验运行器读取——P1 评估/基准工作拥有那个消费者。
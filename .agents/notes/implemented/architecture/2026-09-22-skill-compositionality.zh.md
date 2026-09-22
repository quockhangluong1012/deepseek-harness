# Agent Note：技能组合性、效用与合成

Status: implemented

[English](2026-09-22-skill-compositionality.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` 的 §11 要求技能库能够组合，而不是一次只取一个技能；§40 以最终价值评判技能；§41 把技能库变成图。这三项机制中有三项完全没有实现，还有一项的声明如实说出了自己的处境：

- **§40 没有记录。** `SkillUsageRecord` 统计加载、查看与补丁，并携带信任状态，但没有任何东西把一个技能与它的任务最终结果配对。`evolution-metrics` 声明 `skill-incremental-utility` 在结构上不可测量，并把理由写明："没有任何存储把使用技能的运行与不使用技能的运行配对"。
- **§11 的 frontmatter 缺少四个键。** 提供方解析 `requires`、`conflicts_with` 与 `capabilities`，加载器拒绝含已声明冲突的加载集合——但 `inputs`、`outputs`、`compatible_with` 与 `composable_with` 根本不在键表里，因此技能库能表达的组合只有"前置"与"对手"两种。
- **没有任何东西合成技能。** §11 的最后一句——"演进引擎应能从已有原语合成新技能"——没有任何操作与之对应。`skill_manage` 可以创建、补丁、编辑、写文件、删文件、删除；由另外两个技能派生出的技能只能手工创建，且不留谱系。

组合规则其实已经存在于唯一一处：`tool-skill` 的 `compositionConflict`，对加载集合强制执行。扩展它的风险在于旁边多出第二套约定。

## 决定

扩展现有接缝；不新增包、不新增存储、不新增域。

1. **唯一的组合实现，放在拥有该词汇表的包里。** `packages/skill/skill/src/composition.ts` 提供 `compositionRefusal`（加载集合：先冲突，再 `compatibleWith` 白名单）与 `composabilityRefusal`（合成来源集合：对 `composableWith` 施加同一条白名单规则），二者共用同一个 `CompositionMember` 形状。`tool-skill` 的 `compositionConflict` 已删除；`composePrerequisites` 直接调用 `compositionRefusal`，因此加载器的冲突分支与新增的不兼容分支是同一段代码，旁边紧挨着合成检查。冲突的失败文本与加载器此前交付的文本逐字节相同。
2. **四个键是声明而非门控——除了真正组装集合的那两处。** `inputs` 与 `outputs` 像 `capabilities` 一样只被携带：经过校验、投影到摘要上，本身不改变任何东西。`compatible_with` 与 `composable_with` 是白名单：任一成员声明了非空列表，就会拒绝其中包含未列入名称的集合。缺席或为空的列表不约束任何人——空白名单并不是一个拒绝所有同侪的技能——而指名当前集合之外技能的声明会被忽略，因为加载器与合成器都不拥有未被问及的技能。
3. **效用是推导出来的，且就其衡量之物精确命名。** 记录新增 `sessionOutcomes`：每个加载会话一条已判定结果，由整理器信任趟已经在调用的同一批 `recordTrustObservation` 写入，最新在前、按会话去重、以 `maxSessionIds` 为界，并在正文变化时像信任一样清空。`utility(name)` 从这些计数器读出 §40 的形状——`uses`、`assistedTasks`、`successfulTasks`、`incrementalGain`、`costOverhead`——实现于纯模块（`src/utility.ts`），因此推导是可单元测试的，而不必依赖宿主夹具。
4. **诚实代理量是"库内相对成功优势"。** 本框架不记录未使用技能的运行，因此真正的 `incremental_gain` 没有对照组。`incrementalGain` 是该技能的干净结果占比减去其他已跟踪技能合并后的干净结果占比：它回答"这个技能是否优于库中其他技能"，而绝不是"它是否优于不用技能"。任一侧占比缺失时取 `null` 而非 0。JSDoc 与 README 都用这些措辞说明，并把缺失的对照组记为限制。
5. **`costOverhead` 是已记录的工作量，不是猜测**：`uses / successfulTasks`——存储统计到的加载数除以它所判定的成功数；当没有任何已判定任务成功时取 `null`，因为成功是分母。
6. **合成是既有写入器上的一个新 op。** `skill_manage derive` 接收新技能的完整文件文本与至少两个来源名称，拒绝数量不足、重复、指名自身或不存在的来源集合，施加 `composabilityRefusal`，并经由 `buildDerivedSkillFile` 写入——后者把调用方 head 中声明的 `derived_from` 替换为真正参与合成的来源。它经由产品 profile 已挂载的工具进入生产，并由 `edit` 所施加的同一条 head 不变式把关：`splitSkillFile` 把切分与 `validateSkillHead` 一起执行，两个操作都调用它。不变式只有一份实现，没有两份。

## 考虑过的替代方案

- **在 `tool-skill` 内再写一个组合函数。** 否决：`skill_manage` 对来源集合需要同一条成对规则，而同一关系存在两套实现，正是本包其他"单表设计"所要防止的漂移。
- **让 `inputs`/`outputs` 像 `capabilities` 一样满足 `requires` 条目。** 否决：这会改变离线排序器认为可路由的内容与加载器解析的内容，而 §11 把这两个键与 `capabilities` 并列为声明。排序器与加载器保留它们已交付的规则。
- **把空的 `compatible_with` 视为"与任何东西都不兼容"。** 否决：那样一来被清空或畸形的列表会静默拒绝一切组合，而其他所有列表键已交付的畸形值契约是丢弃该声明，而非将其反转。
- **让 `derive` 读取来源正文并拼接。** 否决：那会让子技能的内容变成该工具本不执行的读文件操作的函数，并把合成文本塞进工具而非交到模型手里。该 op 写入模型给出的正文，只记录谱系。
- **把结果记录放进新存储或新的域表。** 否决：结果属于加载该技能的会话，而那已经是记录里 `sessionIds` 关联所用的键；第二份存储需要同样的查找，并可能与它不一致。
- **在产出效用读数时写入第二个存储事件。** 否决：本次改动没有任何内容触及模型提示词——`utility()` 是供宿主调用方同步读取的——因此不存在需要会话事件的模型可见事实。
- **把数值增益作为传入字段按技能存下来。** 否决：调用方提供的增益无法问责，而 §40 的价值恰恰来自它由已记录的证据推出。
- **把 `sessionOutcomes` 的清空放进 `resetTrust`。** 首稿之后否决：`resetTrust` 在信任降级时也会被调用，而那里的会话结果正是被记录的事实本身，在其中清空会抹掉导致该重置的观测。改为由改变正文的操作（`markPatched`、`markRevised`）显式清空。

## 后果

- `evolution_skill_usage` 升到域版本 2，并带 `compatibleVersions: [1]`；以版本 1 写下的记录可直接打开，因为 `sessionOutcomes` 带默认值。
- `SkillSummary`、`SkillCandidate`、`SkillDefinition` 与 `SkillRegistration` 都携带这些新声明，注册表经由投影与校验共用的同一张 `CARRIED_STRING_LISTS` 表校验它们，因此二者永不会对"存在哪些声明"产生分歧。
- 每个 frontmatter 键表条目都派生自 `STRING_LIST_FRONTMATTER_FIELDS`，因此 `inputs`、`outputs`、`compatible_with`、`composable_with` 与 `derived_from` 由解析它们的同一张表识别，不再作为未知键告警。
- 加载集合现在可能因一个此前不会触发的理由被拒绝，且工具结果会点名该对技能。除此之外，产品 profile 的模型可见行为不变：新拒绝理由是新文本，而不是新的工具、参数或目录字段。
- `evolution-metrics` 关于 `skill-incremental-utility` 不可测量的声明如今离失实更近了一步——它所指缺失的记录现已存在——但按原文仍然准确，因为它点名的理由是缺少无技能对照组，而本次改动并未补上。

## 与计划的偏离

任务指认四个包为所有权范围，并要求扩展 `composePrerequisites`/`compositionConflict`，而它们位于 `packages/skill/tool-skill`。编辑前已与父 agent 确认所有权，`tool-skill` 因此包含在内：删除一个函数、新增一个 import、替换一处调用点、更新一套 README 三件套。未触碰任何其他包。

§11 的 `composable_with` 在合成上强制，`compatible_with` 在加载上强制；离线排序器与行为路由门仍只读 `requires`、`capabilities` 与 `conflicts`，因为它们一次只评判一个候选项，没有可供比对白名单的集合。这一点被记为限制，而不是勉强近似。

## 途中发现的问题

无。有一处怀疑经过调查后被排除：[关系组合笔记](2026-09-21-skill-relation-composition.zh.md)在 `A requires B` 且 `B conflicts_with A` 时把加载器的冲突文本写作 `skill "A" cannot load: "B" and "A" declare a conflict`，读起来像是被请求的技能被排在错误的位置。事实并非如此——该文本先点名声明方（owner），而在此例中 owner 就是 `B`——因此笔记、已交付字符串与 tool-skill 测试三者一致。

## 测试

`packages/skill/skill/tests/composition.spec.ts` 在无上下文的情况下覆盖两条规则：未声明的集合、任一方声明的冲突、被忽略的自指与集合外声明、拒绝的白名单与接纳的白名单、不约束任何人的空白名单，以及不兼容合成的两个方向。该包的 `skill.spec.ts` 新增了全部五个新声明的摘要/定义/运行时携带测试，以及每个声明各一例畸形形状。

`packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` 解析全部五个 frontmatter 键，断言每个畸形值告警且只丢弃该声明，并断言普通技能不携带其中任何一个。

`packages/skill/evolution-skill-telemetry/tests/telemetry.spec.ts` 针对真实存储覆盖效用读数：由已记录结果得出的使用数与已判定会话数、随同侪占比变化的增益、两种 `null` 情形、改写时清空的行为、按会话去重与上限，以及缺席记录的读取。

`packages/skill/evolution-skill-manage/tests/manage.spec.ts` 端到端覆盖合成：一份有效的派生文件，其 frontmatter 点名两个父技能，且其遥测行与写出的哈希一致；调用方声明的谱系被真正合成的来源替换；每一条拒绝分支；一份破坏 head 不变式的派生正文；以及 `EEXIST` 冲突。

`packages/skill/tool-skill/tests/tool-skill.spec.ts` 通过真实的 `skill` 工具覆盖新的拒绝理由，以及白名单所接纳的那次组合。

## 未改动之处

效用读数只被记录，不被强制执行：没有任何路由、排序或隐藏因 `incrementalGain` 而改变，整理器的过期与合并策略仍只读它原本就读的计数器。把该读数接入某项策略会让一个推导出的数字驱动一次破坏性流转，而那需要本框架尚不具备的无技能对照组。基于同一理由，`evolution-metrics` 的 `skill-incremental-utility` 仍声明为不可测量；域中的 `sessionOutcomes` 仍以 `maxSessionIds` 为界而不放任增长，因为该列表是按技能的持久状态，其增长正是该上限存在的理由。

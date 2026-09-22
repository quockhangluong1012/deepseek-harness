# Agent Note: 验证器优先的候选准入

Status: implemented

[English](2026-09-22-evolution-verifier-ladder.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` §12 点名了把 AlphaEvolve 式搜索与"模型给自己批作业"区分开的设计规则——"存在确定性验证器时不要使用 LLM 评审"——并给出了该规则所蕴含的阶梯：第 0 级模式校验器、第 1 级确定性单元/不变式检查、第 2 级领域模拟器/工具执行、第 3 级评审模型、第 4 级人工复审。§50 把 VERIFIERS 放在候选生成器与评审器集成之间。仓库此前完全没有把这些落成机制：

- **第 0 至第 2 级存在于另一个问题里。** `evolution-scorer` 的 `checkBehaviorContract`、`checkBehaviorRouting`、`compareBehaviorReplay` 评判的是一个候选：契约闸门是第 0 级的规则，路由闸门让触发查询经由真实选择器重放，重放闸门比较基线修订与候选修订。三者都服务于"这个修订是否优于它的基线"——它们需要路由目录、正负查询，以及可供两个修订分别打分的语料。而整理器的准入问题不同、也小得多：*这份正文可否被提交？* 用 scorer 的路径回答它，等于为一次 frontmatter 解析就能做出的决定花费全新进程。
- **第 3 级哪里都不存在。** 没有任何包提供逐候选的评审判断，而审计的发现与 §46 关于评审器博弈的论点一致：没有确定性下限，也就没有优先于评审者的东西。
- **第 4 级只作为未入阶梯的闸门存在。** `/skills approve` 是在 `skill_manage` 已经写入文件*之后*才丢弃暂存条目的——`command-evolution` 的 README 明说这一点（"技能文件本身由 skill_manage 写入；只在那次写入落地后再批准"）——因此它决定的是簿记条目，而不是提交。
- **整理器的补丁闸门只校验一条不变式。** `applyConsolidation` 的 `patch` 分支调用 `isValidSkillBody`，它检查 frontmatter 可解析、指名该技能并带描述。通过的正文无论说什么都会被写入，失败的正文只是 `skipped += 1`——一个光秃秃的计数，不记录是哪项检查拒绝、为什么拒绝。
- **内核的注册表未被挂载。** `packages/runtime/agent-kernel/src/verification.ts` 持有 `CriterionVerifierRegistry`，一个真正的工具执行验证器注册表，而没有任何 profile 挂载它。它的请求是带验收标准的任务契约，因此不凭空发明标准就无法回答技能正文的问题。

于是阶梯的排序规则——从最廉价一级开始，在第一个决定性层级停下——在任何地方都没有实现，而唯一存在的准入闸门只判断了第 0 级的一个子集。

## 决定

新增一个包 `packages/evolution/evolution-verifiers` 承载阶梯；整理器的补丁分支改走它。

1. **阶梯就是这个包，此外别无他物。** `runVerifierLadder(request)` 遍历 `[0, 1, 2, 3, 4]`，记录每一级的判断，并在某一级拒绝的瞬间返回。咨询顺序**就是**代价顺序，因此第 0 级失败的正文可证明永远不会到达模拟器、评审者或人工。`EvolutionVerifiers`（`ctx.evolutionVerifiers`）只是同一纯函数之上的三行服务，因此希望多个调用方共用一条准入规则的宿主无需第二份实现。
2. **第 0、1 级是本包自行判定的两级，且仅凭候选本身判定。** 第 0 级是 `skill_manage edit` 强制执行的 frontmatter 不变式，以 `splitFrontmatter`/`validateSkillHead` 的形式从 `dsh-evolution-skill-manage` 导入——复用而非重新推导，因此阶梯与技能管理器永远不会就可提交正文产生分歧。第 1 级补上正文要有用所必需的两条不变式：合法的 kebab-case 技能名，以及 frontmatter 之后非空的指令。这也是本包唯一的宿主依赖是 skill-manage、不开启任何存储域、也不调用任何模型的原因。
3. **第 2 至第 4 级是接缝，绝不是桩。** `VerifierSeam` 是一个零参函数，返回 `VerifierJudgment`（`passed`、`failed`，或带理由的 `abstained`）。调用方用自己手里的东西组合第 2 级模拟器、第 3 级评审模型与第 4 级人工决定；本包只知道它们的顺序。未挂载的接缝以点名宿主未挂载何物的理由弃权，无法判断该候选的已挂载接缝则自行弃权——因此阶梯绝不把缺失的判断变成通过。抛出异常的接缝会向外传播，因为模拟器不可用必须使本次验证失败，而不能被当作安静的弃权来读。
4. **裁决点名作出决定的层级，或点名弃权。** `failed` 携带 `decidedBy` 与该层级的理由；`abstained` 携带 `decidedBy: null` 与逐一点名所有弃权层级的理由；`passed` 仅在五级全部通过时可达。`rungs` 按顺序携带每一个被咨询的层级，因此依据不完整阶梯行动的调用方能确切看到缺失的是哪份判断。
5. **整理器的补丁准入运行该阶梯。** `applyConsolidation` 的 `patch` 分支调用 `runVerifierLadder({ name, body })` 并在 `failed` 时拒绝，把一条 `ConsolidationRefusal`——名称、判定层级、裁决的理由——推入 `ConsolidationApplied.refusals`，并由 `ConsolidationReport.refusals` 带出给调用方。被拒的正文仍计入 `skipped`。整理器不挂载任何第 2、3、4 级接缝，因此通过确定性层级的正文与以往一样被提交；变化在于拒绝如今是一条点名的决定，而不是一个匿名计数。
6. **`isValidSkillBody` 被删除。** 第 0 级就是那个函数加上一条理由，两者并存只会留下两份需要同步的 frontmatter 规则。

## 考虑过的替代方案

- **让第 0 至第 2 级走 `evolution-scorer` 的行为闸门。** 否决：那些闸门回答"这个修订是否优于它的基线"，且需要路由目录、触发查询，以及为两个修订打分所需的语料。整理器手里只有一份正文与一个目录。为准入一个补丁而引入重放路径，等于在一次解析就能决定的地方花费全新进程，正是 §12 规则所禁止的倒置。
- **在验证器包内再写一个 frontmatter 校验器。** 否决：一条不变式两份规则必然漂移，而技能管理器的规则正是 `skill_manage edit` 在每一次手改上已经执行的规则。
- **为每级定义一个带自己 context key 的 `VerifierService` 接口。** 否决：这是一份调用方还得与自己状态保持同步的单实现间接层；调用方本来就握有那份判断，因此一个返回它的函数就是能表达该契约的最小接缝。
- **默认把 `CriterionVerifierRegistry` 作为第 2 级挂载。** 否决：它的请求是带验收标准的任务契约，其结果是逐标准的命令结果；技能正文两者都没有，接线它就意味着凭空发明标准来满足签名。那个注册表自身的缺口——没有 profile 挂载它——是另一个问题，保持原样。
- **在更高层级弃权时拒绝补丁。** 否决：确定性层级是该路径中全部可得的证据，而拒绝每一个整理器无法模拟的正文会让归并这一功能终结。弃权已在裁决中报告；确定性合法正文的提交规则保持不变。
- **把裁决存入持久域。** 否决：没有任何东西会按身份读回裁决。整理器的报告与其台账行已经携带了被准入与被拒绝的内容，而没有读者的域就是没有消费者的状态。
- **把 `keep`、`consolidate`、`archive` 裁决也过一遍阶梯。** 否决：这些裁决移动或保留整包，并不指名替代正文，因此没有可供各级判断的产物。它们的证据是资格、置顶与目标安全性，`applyConsolidation` 已经检查过。
- **为启用的层级加一个 `Config` 字段。** 否决：挂载其接缝就是启用该层级，配置字段只会是同一次决定的第二种、更弱的拼写。

## 后果

- `ctx.evolutionVerifiers` 出现在 context 与 API 目录中。新包的 tsconfig 别名、项目引用、host/client 注册与产品 profile 行由落地本批次的协调改动接线，而不是由包自己接线；包只声明 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-evolution-skill-manage` 作为同级依赖，不导入任何其他东西。
- `ConsolidationApplied` 与 `ConsolidationReport` 新增 `refusals`；`skipped` 保持原义并仍计入被拒补丁，因此既有消费者不受影响。`evolution-curator` 的生成 API 目录随之变化。
- **有一处行为收紧：** frontmatter 合法、指名该技能、但围栏之后没有指令的补丁正文，如今在第 1 级被拒绝，而以前会被提交。这正是有意收紧的下限——这种正文会破坏技能赖以路由的内容。
- 本包不注册任何面向模型的东西，也不读取任何模型写下的内容，因此没有会话事件随之产生，模型可见 ⟺ 已记录这一规则未受影响。挂载第 3 级评审接缝的宿主拥有那次请求以及它所需的日志。
- `evolution-curator` 现在同级依赖 `evolution-verifiers`，因此整理技能却省略阶梯包的宿主无法挂载整理器。

## 测试

`packages/evolution/evolution-verifiers/tests/ladder.spec.ts` 直接驱动每一级与排序：第 0 级接受 frontmatter 不变式，并分别以各自的理由拒绝无围栏、名称错误、缺描述与 YAML 不可解析的正文；第 1 级接受合法名称加指令，拒绝非法名称、空指令正文与无围栏正文；排序测试挂载一个通过的模拟器，断言第 0 级的拒绝既点名第 0 级又从未调用该模拟器，这就是把规范的短路写成断言而非注释。弃权测试覆盖未挂载接缝的情形（三条点名弃权、`decidedBy: null`）、在更廉价层级通过之后自行弃权的已挂载接缝、弃权层级之后紧跟拒绝层级（咨询就此停止）、记功归于第 4 级的全通过情形，以及使验证失败而非弃权的抛错接缝。`tests/verifiers.spec.ts` 在真实 `Context` 上挂载服务，并通过 `ctx.evolutionVerifiers` 检查同样的两端。

`packages/evolution/evolution-curator/tests/consolidate.spec.ts` 端到端钉住准入闸门：直接调用 `applyConsolidation` 的测试现在送入四份补丁正文——无围栏、名称错误、frontmatter 合法但指令正文为空、以及合法——并断言 `refusals` 等于第 0 级、第 0 级、第 1 级且各带理由，只有合法正文落地，且其原像与台账行不变；由 fork 驱动的归并测试对模型提出的正文作出同样断言，因此判定层级穿过了工具循环与报告。

## 保持原样

scorer 的三道行为闸门留在原处：它们回答阶梯不问的基线对候选问题，而 `evaluateBehavior` 仍是唯一批准修订的路径。`CriterionVerifierRegistry` 仍未被挂载——接线它需要一个技能正文并不具备的任务契约，而在这里发明一个只会让阶梯的第 2 级成为披着同一名字的另一种机制。第 4 级不调用 `/skills approve`：那道闸门在文件写入之后才决定暂存条目，因此阶梯改为接受调用方提供的复审判断，批准路径保留其自身语义。阶梯一次只判断一份正文且不存储任何东西，因此这里没有任何东西把关技能对模型的可见性（§58.12 保持完好），也没有宿主得到它自己未曾保存的准入历史。

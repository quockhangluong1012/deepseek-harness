# Agent Note: 候选准入闸门与不含 frontmatter 的新颖度

Status: implemented

[English](2026-09-21-candidate-admission-gate.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §12 把确定性验证者放在第一位——「存在确定性验证者时不要用 LLM 评判」——§53 则把技能晋级与它之前的各道门配对。Curator 有一道（`isValidSkillBody` 拒绝会破坏技能的裁决正文），scorer 有一道（`checkBehaviorContract`），但优化器一道也没有：它从变异算子取候选正文，并把每一个都放到全新回放进程上评分——包括模型丢掉或改错了 frontmatter 的正文。这样的正文根本无法落地——`skill_manage edit` 会拒绝它——因此一次运行可能为一个人人写不进去的优胜者付掉整轮覆盖层评估、holdout 检查与重复确认比较，还把它报成一次晋级。

在接那道门时读新颖度的实现，暴露了第二个更小的缺陷。`novelty.ts` 自称度量的是候选自身的指令行，但 `instructionLines` 按每个换行切分，于是 frontmatter 也被算成指令行。真实比较中的两份正文都会照抄同一段 frontmatter，因此它只会把分母撑大：一个在五行正文上新增一条规则的候选报 1/6，而模块承诺的是 1/5——而这个数字正是「测得相同的候选之间」的并列打破依据。

## Decision

`dsh-evolution-optimizer` 里两处修正，都关于「什么才算候选正文」。

1. **先准后评**（`src/index.ts`）。变异调用返回的每个正文在进入候选池之前都要过 `checkBehaviorContract(request.skill, candidate)`。被拒绝的不算候选：它永不到达 `scoreVariant`，因此永远换不来一次全新进程上的评分，也不会进入实验台账的算子统计——台账本就只记住产出过**可用**候选的算子。当所有正文都被拒绝时，拒绝次数会进入 `no-improvement` 的原因，因此操作者读到的是「3 refused for breaking the skill frontmatter」，而不是一句光秃秃的「no usable bodies」。
2. **请求本身声明要求**（`src/mutate.ts`）。`mutationInstructions` 增加一行，要求 frontmatter 保留同一技能名并带路由描述。这道门不是给守规矩的模型设的陷阱：它是一条模型能够遵守的指令背后的确定性检查。
3. **新颖度只度量指令行**（`src/novelty.ts`）。`instructionLines` 在切分之前先剔除开头的 frontmatter 块，因此比例是在候选真正撰写的行上算出的。不以 `---` 开头的正文行为不变（`closing` 查找返回 `-1`，`slice(0)` 保留全部行），正文中间的 `---` 规则仍是内容。

## Alternatives considered

- **复用 curator 私有的 `isValidSkillBody`**——拒绝：那是同一不变式的副本，而 scorer 已经把该检查以 `checkBehaviorContract` 公开。优化器导入后者，于是写入路径、行为门与这条循环共用「可提交正文」的同一处实现。
- **只把关优胜者而不是每个候选**——拒绝：那是在筛分、完整评估、holdout 与确认比较都已付费之后才拒绝。最廉价的门应当最先跑，这也正是 `evaluateBehavior` 给三条通道的既有顺序。
- **为「全被拒绝」的运行新增一个 `status`**——拒绝：`no-improvement` 本就表示「本次运行产出的东西都不值得分选」，而新状态会牵动台账 schema、`describeOutcome`、`/curator optimize` 以及每一个按它分支的界面。拒绝次数改为搭载既有的 `reason`。
- **在 `parseMutationResponse` 里过滤**——拒绝：解析器的约定是形状（完整、互异、非空、不同于基线），不是技能合法性，而且它不接受技能名；加上技能名会让一个纯文本解析器依赖另一个包的 frontmatter 不变式。
- **让新颖度继续计入 frontmatter**——拒绝：该模块自己的 JSDoc 早已承诺按指令行度量，而这道门保证了生产中的每个候选都带 frontmatter，于是分母会在每次运行中被系统性撑大，而不是偶发。
- **只跳过 `---` 围栏行而不是整块**——拒绝：问题不在于围栏，而在于其间的元数据；而且正文后面若有一条 `---` 分隔线，那样做会连它之后的内容一起丢掉。

## Consequences

- 无法落地的候选不再作为晋级推荐到达人类面前，也不再换来一次评分。
- 拒绝是确定且免费的：一次 frontmatter 解析，无模型调用，无进程启动。
- 全被拒绝的运行仅凭原因即可诊断，连被拒绝的条数都在其中。
- 新颖度现在就是其文档所描述的比例，因此相等候选之间的并列打破依据排序的是作者撰写的内容，而不是照抄的元数据。变化体现在报出的数字上：同一处改动，带 frontmatter 的正文的候选会比以前得更高。
- 这道门只查 frontmatter。一个格式完好却抢走别的技能触发词的正文仍会到达人类面前；那是 scorer 的路由门，优化器并不运行它。此事记在包 README 的限制里，而不是靠暗示。

## Deviations from the plan

- 无：本切片是 §12 针对优化器自身候选的验证者优先门，加上该门暴露出的新颖度修正。
- `packages/evolution/evolution-optimizer/tests/optimizer.spec.ts` 的夹具此前把裸字符串 `'# writer'` 当作正文。它们之所以不是技能形状，是因为从来没有任何东西检查过它们；现在每个夹具正文都经本地 `skillBody` 辅助函数构造，这是加装真门时该付的代价。

## Testing

- `tests/optimizer.spec.ts`：坏的正文与好的正文并列时，坏的在评分前被拒（评分调用次数证明没有买过评估），好的仍会被分选；全被拒绝的运行报告 `no-improvement` 并带上拒绝次数，且不评分任何东西。
- `tests/novelty.spec.ts`：正文不变而 frontmatter 改写报 0；新增一条规则报出作者撰写的比例；不以 `---` 开头的正文保留全部行；正文中间的 `---` 规则仍是内容；frontmatter 未闭合时保留全部行。
- 优化器套件全绿（116 tests）；`command-evolution`、`evolution-scorer`、`evolution-curator`、`evolution-feedback` 套件全绿（275 tests）。

## Left alone

- 在优化器内运行 scorer 的完整 `evaluateBehavior`（路由加回放）：它需要 `OptimizeRequest` 并不携带的路由目录与触发查询，而补上它们会改动每一次 `/curator optimize` 调用的调用方约定。
- 把 `checkBehaviorContract` 接到 `/skills approve` 上，那里分选的正文仍未经核验地到达人类面前：`skill_manage edit` 会在写入时拒绝坏正文，所以文件本身是安全的；这道门在此处的价值是省下被浪费的评估，而这一点已经解决。
- 契约编辑流、基准生成以及 P2/P3 机制家族仍是未来切片。

# Agent Note: 上下文编译器

Status: implemented

[English](2026-09-20-agent-context-compiler.md) | 中文

## Problem

会话日志记录了发给模型的内容，但没有任何东西陈述一次请求依据什么编译而来。`core/system-prompt` 组装 section 与运行时 context，context 系列包贡献更多，`compaction-basic` 替换转录区间，Kernel 从同一份日志推导任务事实——然而没有任何记录指出某一步放置了这些贡献中的哪些、其中哪些可丢弃，或重放能否复现这次放置。

token 上限在另一侧有同样的缺口。没有任何东西把任务自身的权威——适用于它的权限、它的验收标准、它的计划、它的未解决失败——与上限可以安全丢弃的指导区分开来，因此任何限制都不得不冒移除一次运行本应担责的那些事实的风险。

## Decision

一个新的可选用包 `packages/runtime/agent-context` 观察组装，而不是产出组装。它挂载到 `system-prompt/assemble`，读取 waterfall 最终确定的组装，并为每次指名了某个 agent 的组装追加一条仅入日志的 `context/compiled` 记录。它不拥有任何提示词贡献，也不拥有任何模型请求。

编译器读取两个来源族。每个非空的组装 section 与运行时 context 变成一封 `ContextSource` 信封，其 kind、trust 与归属来自按注册名前缀查表，未列出的前缀解析为不可信的仓库内容。Kernel 的 `KernelView` 以信封形式贡献任务自身的事实：目标、每个验收标准一条、每条约束一条、最新计划修订、每个未结动作一条，以及每个未解决失败一条，全部为 `trusted`，全部为 `required`。

保留等级随 kind：`policy`、`task`、`plan` 与 `evidence` 来源即使单独超出上限也仍被放置，而 `memory`、`artifact`、`history` 与 `tool` 来源会被切掉。上限切掉放置顺序的一个前缀——第一条放不下的可压缩来源之后的每条可压缩来源都以 `reason: 'budget'` 被省略——而内容已被某个已放置来源承载的可压缩来源以 `reason: 'duplicate'` 被省略。被放置来源的 `subject` 使两条互相矛盾、且都被放置的 required 来源成为一条被报告的 `ContextConflict`；编译器报告分歧，但从不裁决分歧。

排序是全序——可信度、kind、与目标的词面相关性，最后来源 id 的码元顺序——因此相同输入以相同顺序放置相同来源。放置的摘要是对编译器版本、上限、每个被放置来源的身份、价格、相关性与内容哈希、每条遗漏与每个冲突计算的 SHA-256，它不覆盖任何时钟，也不覆盖任何生成 id。`mode: 'shadow'`（默认）记录放置并原样返回组装；`mode: 'apply'` 返回移除了放置所遗漏的每个来源之后的组装。

持久记录保留身份，而不是文本：提示词文本已经存在于 `system/message` 面上，因此 `ContextCompilationRecord` 承载摘要、编译器版本、上限、token 价格、被放置来源条目、各遗漏与各冲突。

必需事实在每次组装时重新推导，而不是复制进 compaction 检查点。Kernel 视图已经是对日志的持久折叠，因此任务的目标、标准、计划与未解决失败无需编译器在步骤之间持有状态就能抵达每一次请求；shadow 掉转录区间的 compaction 无法移除从未存在于转录中的事实。

## Alternatives considered

**把必需事实复制进 `CompactionCheckpoint`。** 拒绝：该规范的草图早于 Kernel 的折叠。compaction 记录里的第二份副本需要自己的保留与陈旧规则，可能与它所复制自的视图分叉，并且当摘要器截断输出时，正是它会缺失。在每次组装时读取折叠则只有一个权威。

**在编译出的上下文中产出 `messages`。** 拒绝：`deriveMessages()` 是模型历史的投影，循环依据组装渲染请求。第二个投影会是一份互相竞争的模型历史，而编译器的职责是组装之上的来源追溯，不是自己产出一个请求。

**在编译器内部重建提示词顺序。** 拒绝：`core/system-prompt` 拥有贡献注册、层遮蔽、排序与渲染。重排 section 的编译器会变成第二个汇编器，并且每个提示词贡献者都得决定向哪一个注册。

**用生成的 id 作为来源键。** 拒绝：注册的贡献名是 `apply` 模式必须把一次放置映射回去的对象，也是读者能在组装中解析的对象。因此名字在一次编译内被断言唯一，一个 section 与一个运行时 context 共用同一个名字时会拒绝那次组装，而不是静默放置其中一个。

**用 embedding 相似度排序。** 暂时拒绝：编译器是纯的、确定的、不含 I/O，挂载的 embedding 调用会让放置依赖提供方状态。与目标的词面重叠可离线复现；相似度阶段属于一个自带向量的调用方。

**默认应用上限。** 拒绝：从未对着真实流量跑过的上限会切掉错误的来源。shadow 是默认，与 Kernel 自身先 shadow 再 enforce 的规则一致。

## Consequences

挂载了编译器的部署可以从日志回答某一步依据什么编译而来，并能证明相同来源的重放产生相同摘要。它所提供的上限永远不会丢弃任务的权威，而这正是让一个限制值得配置的性质。该记录不耗费提示词 token：它仅入日志，绝不进入模型上下文。

代价正是包 README 中记录的那些，并且编译器所投影的计划信封目前没有产出者：`task/plan` 已被 Kernel 声明并折叠，但没有任何东西追加它。目前没有任何东西挂载它，也没有任何东西读取 `context/compiled`，因此部署必须自己去读日志。相关性是词面的，因此用不同措辞回答目标的来源得分为零。贡献名必须在 section 与运行时 context 之间唯一，发生冲突时拒绝该次组装而不是选出胜者。保留等级与可信度由前缀表和 kind 表固定，不可配置，因此一条读起来像指导的贡献，只要其所属族如此定义，就仍然可压缩。

## Testing

`packages/runtime/agent-context/tests` 固定了这些行为：分类与保留表、包含每一次并列裁决的全序、required 优先的前缀切分与去重规则、摘要的确定性及其对生成式身份的排除、组装与 Kernel 视图两个来源投影、服务按组装记录的行为、未挂载 Kernel 与卸载之后的形态、对 section 与运行时 context 的 shadow 与 apply 模式、重放复现同一摘要，以及一个启动 `cordis.yml` 的真实 Loader 组合，证明 `mode` 与上限是配置而非常量。

其余由生成的目录承载：[persistence catalog](../../../../docs/persistence-catalog.zh.md) 与 `KNOWN_SESSION_EVENT_TYPES` 注册了 `context/compiled`，[配置目录](../../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-context) 记录了 schema，[能力 seams 页面](../../../../docs/capability-seams.zh.md) 记录了目前没有任何东西消费该服务。

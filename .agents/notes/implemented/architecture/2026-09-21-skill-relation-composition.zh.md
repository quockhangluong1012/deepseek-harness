# Agent Note: Skill 关系——能力满足的前置、声明的冲突，以及加载时组合

Status: implemented

[English](2026-09-21-skill-relation-composition.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §11（P1 第 15 项）想要一个能够组合的库——「检索并组合 skill A + skill C + skill F」——而上一片只落地了第一条关系：`requires` 被解析、随摘要与定义携带，并由 `rankSkills` 在前置不在候选集合中时把该候选置零来执行。缺了三件事。`capabilities` 被解析并携带，却没有任何读者，因此前置只能指向另一个 skill。没有任何 skill 能声明自己不得与谁一同加载。而且没有任何活跃路径真正组装过一次组合：每轮目录只携带名称与描述，`skill` 工具只返回被请求的那一个 skill，于是 frontmatter 声明了前置的 skill 仍然独自抵达模型。该排序门在离线行为路由门之外没有生产调用方，这让整套关系面在运行中的会话里处于空转状态。

## Decision

1. **`conflicts_with`（frontmatter）→ `conflictsWith`** 走 `requires` 同一条流水线：一行 `STRING_LIST_FRONTMATTER_FIELDS` 同时驱动解析、已识别键白名单与畸形值告警，字段随候选、摘要、定义以及三处 `validateStringArray` 携带。该关系是对称的：任一方声明即排除该对。
2. **`capabilities` 变得承重。** `requires` 的某一项，可由携带该名称的候选满足，也可由以 capability 提供它的候选满足——即候选集合上的并集，与「capability 名称本身并不是一个 skill」这一事实相符。
3. **`rankSkills` 新增 `capabilities` 与 `conflicts`。** 未满足的前置仍然置零；冲突对中排名更高者保留分数，另一方置零，判定按排名顺序（先分数、后名称——选择器唯一拥有的全序）；不可路由的候选永不排除同类，因为代它排除只会删掉一个本可使用的 skill，而它自己无论如何都无法被选中。
4. **加载器承担组合。** `skill({ name })` 把被请求 skill 声明的前置解析为目录中的 skill（先按名称，再按 capability，按声明顺序、去重），并把它们放进结果新增的 `composed` 数组；每个前置各占一个 `<skill_content>` 块，被请求的 skill 在最前。整组必须全部解析，否则整次加载被拒绝——`skill "A" requires "B", which is not available in this session`，或 `skill "A" cannot load: "B" and "A" declare a conflict`——因为半个声明的组合是配置错误，而不是部分加载。`/name` 用户手势注入同一组内容，每个成员一次注入。
5. **行为路由门转发两个映射**（来自调用方提供的目录：`capabilities`、`conflictsWith`），因此离线选择器验证的是同一套规则。
6. **`snapshots/session/skill-compose`** 端到端记录了这次组合：模型加载声明 `requires: [base-skill]` 的 skill，录制的工具结果携带两个框架。

## Alternatives considered

- **冲突双方一并排除**——拒绝：一条过期的声明会让两个 skill 同时不可用，而选择器没有证据偏袒任何一方。排名顺序正是查询本身提供的确定性裁决。
- **让声明方获胜**——拒绝：方向没有操作含义，只会扰动分数打平时的结果，而名称顺序已经确定性地解决了这一点。
- **在任何位置都拒绝冲突对**——拒绝：在解析与发现边界上无法实现（提供方无从知道某次调用会选中哪些同类），在模型分多次调用加载 skill 的场景中也没有必要——那是被记录的局限，而不是静默的漏洞。
- **让模型自行加载前置**——拒绝：目录指示模型加载适用的 skill，这比 frontmatter 声明是更弱的保证；加载器是 harness 唯一能交付所声明集合的地方。
- **把关系元数据放进模型目录**——拒绝：目录被现有测试固定为 `name` + `description`，而关系决定的是选择与加载，并不需要模型侧文字。
- **前置加载失败时部分组合**——拒绝：组合是作者声明的；部分加载会把一个声明依赖缺失的 skill 静默地交给模型。

## Consequences

- 声明了前置的 skill 现在一次调用即可完整抵达，并按声明顺序组合。
- 前置可以是 capability：`requires: [code-review-rules]` 由目录中任何 `capabilities` 含它的 skill 满足。
- 冲突在真正组装集合的地方执行——选择器与加载集合——并在拒绝时点名双方。
- 未执行的边界：分两次工具调用加载的两个冲突 skill 不会被拒绝；不存在已加载集合的登记处，该局限记录在 skill README 中。
- `composed` 属于 `skill` 工具结果 schema（持久化元数据）；调用卡片不变，渲染组合后的内容。

## Deviations from the plan

- 范围内无偏差：改动即关系词汇、选择器的策略、加载器的组合、路由门的管线、录制的场景与文档。
- §11 的最后一项机制——从原语合成新 skill——仍未实现；它生成的是工件而非关联既有工件，且候选生成归 curator/optimizer 所有。

## Testing

- `skill-filesystem`：`conflicts_with` 无告警解析并在 `get()`/`list()` 中保留；畸形标量每次解析告警一次并丢弃该字段，skill 仍可加载。
- `skill`：`conflictsWith` 随候选、列表摘要与已加载定义携带，且每处 `validateStringArray` 都以 `conflictsWith must be an array of strings` 拒绝畸形值。
- `rank`：仅由某个已提供 capability 满足的前置得分大于零，提供者缺席时为零；冲突对中排名更高者保留分数，另一方置零且 rough 分数不变，无论哪一方声明；不可路由的对手不排除同类；无声明时分数逐字节相同。
- `evolution-scorer`：由 capability 满足的前置可在 `checkBehaviorRouting` 中路由，提供者离开目录后即失败；与排名更高的条目冲突的候选在所有正例上失败。
- `tool-skill`：声明的组合是一个结果，前置框架排在请求框架之后；capability 提供者可满足前置；不可用的前置与声明的冲突分别以点名双方的文本拒绝加载；`/name` 手势先注入被请求的 skill，再注入其前置。
- `snapshots/session/skill-compose`：通过 `dsh --profile headless` 重放该自撰夹具，其录制的工具结果携带 `<skill_content name="composed-skill">` 及随后的 `<skill_content name="base-skill">`（由一次真实的 refresh 运行产生）。
- `packages/skill/skill/tests/rank.spec.ts`（16 条）、`tool-skill`（81）、`evolution-scorer`（49）、`skill` + `skill-filesystem`（114，其中 3 条被既有的平台守卫在本机跳过）全部通过；每个触及包的 `tsc -b` 干净；翻译配对、导出 JSDoc 与文档预算通过；`verify-md-links` 只报告既有的缺失 spec 链接。

## Left alone

- 从原语合成新 skill（§11 的最后一项机制）。
- 仓库内没有调用方从 skill frontmatter 填充行为路由目录，因此路由门的关系证明仍停留在离线状态，直到出现带语料的调用方（由 scorer 自己的 README 记录）。
- `/curator` 与 `/skills` 界面不列出关系；目前没有任何消费方需要展示它们。

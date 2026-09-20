# Agent Note: Skill 前置（`requires`）端到端

Status: implemented

[English](2026-09-20-skill-prerequisites.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` P1 第 15 项（skill 组合性，§11）要求 skill 声明它构建于何物之上，而 Harness 没有这种声明：frontmatter 只有工具需求（`requires_tools`），没有 skill 到 skill 的关系，因此选择器可能路由到一个前置不在目录中的 skill——一个根本无法工作、却凭文字拿分的候选。排序器（`rankSkills`）只按词法、向量与效用打分，没有"可路由性"的概念。

## Decision

前置沿用工具需求已走通的管线，并多走一步——因为消费它的是选择器而非加载器：

1. **Frontmatter**（`dsh-skill-filesystem`）：`requires` 加入 `STRING_LIST_FRONTMATTER_FIELDS` 表（两侧同形，`platforms`先例），解析、识别键 allowlist 与畸形值警告都从这一行派生。畸形值警告并丢弃，skill 照常加载。
2. **定义与摘要**（`dsh-skill`）：`SkillDefinition` 与 `SkillSummary` 新增可选 `requires`；`validateDefinition`、`validateCandidate` 与运行时注册都用既有的 `validateStringArray` 校验；`toSummary`、filesystem `list()` 候选与 `runtimeCandidate` 负责携带。它进入摘要是故意的：与 `requiredEnv`/`config`（加载期）不同，前置与路由相关，而 `whenToUse` 已开了"摘要带路由文本"的先例。
3. **选择器闸门**（`rankSkills`）：按 skill 名的 `requires` 映射，形状与 `signals` 选项一致。候选集中缺失任一前置的 skill 得零分——这是可路由性闸门，不是质量降权。不引入新可调参数：在集合中是否存在就是全部规则。
4. **评估消费方**（scorer `checkBehaviorRouting`）：`BehaviorCatalogSkill` 携带可选 `requires` 并送入同一选择器调用，因此需要目录外前置的候选会挂掉每个肯定查询——路由到它根本不可能工作。

`conflicts_with`/`composable_with` 合成暂缓：排除不需要新数据，但"两个冲突 skill 留谁"是本切片不发明的选择策略。

## Alternatives considered

- **像 `requires_tools` 那样在发现期隐藏前置不满足的 skill**——否决：提供方不可能知道某次调用中哪些兄弟可路由，只有手握候选集的选择器能判断。门控归选择器，解析归提供方。
- **降权而非清零（0.5 兼容系数）**——否决：缺失的前置不是弱证据，而是不可工作；系数需要无人拥有 的校准数据，而零才是"无法工作"的诚实读法。
- **独立的兼容服务或注册表方法**——否决：一个接缝一个主人；排序器已拥有打分，另一条打分路径需要把同一候选集传两遍。
- **经 `skill_manage create` 参数设置 `requires`**——暂缓：`buildSkillFile` 只写名称与描述，frontmatter 手工编辑加 `edit` 保留已能携带该字段；工具支持等到有在创建时设置前置的调用方再说。

## Consequences

- 声明 `requires: [base]` 的 skill 在 `base` 入目录时正常路由，缺席时处处零分——包括在行为评估路由门内，后者如今把前置与触发词一起证明。
- 畸形的 `requires` 与其它字符串列表字段完全一致地降级：每次解析警告一次，skill 照常加载。
- 验证中发现的陈旧构建问题记在下面；除删除那个多余文件外，无需任何源码改动。

## Deviations from the plan

- 验证中发现多余的构建产物：skill 包 `src/index.ts` 旁边躺着一份陈旧的已编译 `index.js`（9/15，gitignored），在包根导入时遮蔽了 TypeScript 源码，因为目录解析优先 `index.js` 而非 `index.ts`。本切片中 `skill.spec.ts` 的每一条失败——包括此前被记为"单跑既有失败"的五个作用域层用例——删掉该文件后全部通过。教训：导入包根的测试文件变红时，先怀疑多余的发射产物，再怀疑代码；`verify-no-src-js` 正是为这一类而存在。
- 只交付 `requires`：没有 `conflicts_with`、`provides`/`composable_with`，也没有从原语合成新 skill。它们仍是 P1-15 余部，本切片是它们的数据模型先例。

## Testing

- `skill-filesystem.spec.ts`：`requires` 无警告解析，并在 `get()` 与 `list()` 摘要上浮现；畸形标量每次解析警告（列表一次、加载一次），别无其它警告。
- `skill.spec.ts`：定义中的畸形 `requires` 被拒绝；运行时摘要携带前置；41 个测试全部通过——包括作用域层用例，删除多余产物后它们也好了。
- `rank.spec.ts`：前置缺席得零分且粗排分保留；前置满足或未声明时分数字节级一致。
- `behavior.spec.ts`：需要目录外 skill 的候选在末位挂掉每个肯定查询；需要目录内 skill 的候选路由如前。
- `skill/src/index.ts`、`skill/src/rank.ts`、`scorer/src/behavior.ts` 语句/分支/函数 100%；filesystem 的缺口是 Windows 下跳过的既有 POSIX 符号链接分支，本改动未触及。
- `typecheck` 全仓库通过；所有被触文件 `lint` 干净；`verify-translation-pairing`、`verify-export-jsdoc`（无新符号问题）、`verify-no-hardcoded-tunables` 与 Agent Note 门禁通过。`verify-doc-budgets` 与 `verify-md-links` 只在既有条目上红。

## Left alone

- P1-15 余部：`conflicts_with`、`composable_with`/`provides`、skill 图关系，以及从原语合成。
- 优化器目录构建器尚未提供 `requires`（该文件是别人的 WIP）；闸门已在 `checkBehaviorRouting` 中等携带它的目录。
- P1-17 基准语料写入需要录制 fixture 合成，仍是后面的切片；P1-16/19/20、P2、P3 家族同样排队。

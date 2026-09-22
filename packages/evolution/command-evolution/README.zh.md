---
description: "面向人类的 /memory、/skills、/journey、/curator、/refine、/trajectory、/learn、/suggestions 与 /frontier 命令，治理暂存的演进写入、作用域活动、会话导出与技能整理（ctx.commands），供治理自学习 harness 的宿主使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-evolution

[English](README.md) | 中文

## 概述

`dsh-command-evolution` 把演进 harness 的人类治理带进聊天 UI：`/memory` 与 `/skills` 批准或拒绝暂存写入，`/journey` 显示该作用域已记录的活动，`/curator` 显示整理台账、运行一次维护通过并列出为复核而暂存的技能，`/refine` 重建该作用域的经验，`/trajectory` 导出会话或作用域，`/dream` 把已记录的失败固化为记忆，`/frontier` 按实测证据把能力从最弱到最强排序，`/suggestions` 列出带 blueprint 的技能而不调度它们。除 `/learn` 外的命令都直接作答；`/learn` 排队一个普通轮次。当人类必须治理后台评审的提议、让它在落地前可见时，选择本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当后台评审为当前 workspace 作用域暂存了提案时，在聊天 UI 输入 `/memory` 或 `/refine`。作用域按注入器的方式解析——先查注册表会话归属，回退到规范 `cwd` 匹配——使用必填的 `profile`；作用域之外的会话得到 `This session is outside any workspace scope.`，而不是一个猜测。

### 配置

`profile` 为必填：部署方必须指明命令治理的作用域命名空间。作用域永不共享默认命名空间。

```yaml
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profile` | 必填 | workspace 键之前的作用域标识命名空间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-command-evolution)是每个可接受字段的详尽来源。

### 使用命令

| 输入 | 结果 |
|---|---|
| `/memory`、`/memory pending` | 以 `- <id> [<kind>:<op>] <gist> (session '<origin>', <instant>)` 列出作用域的暂存条目；无待审批项时返回 `No pending writes.`。`applyDecisions` 条目之下还会为每个决策各列一行缩进明细。裸 `/memory` 报告同一列表。 |
| `/memory approve <id>` | 应用一条记忆类条目并报告 `Approved staged <op> (<gist>).`；未知 id 报告 `No staged write '<id>'.`；技能类 id 会被重定向到 `/skills approve`。 |
| `/memory reject <id>` | 不应用而丢弃一条并报告 `Rejected staged write '<id>'.`。 |
| `/memory <anything-else>` | `Usage: /memory pending \| approve <id> \| reject <id>`——文法固定。 |
| `/skills`、`/skills pending` | 列出作用域的暂存技能条目，或给出指明提案来源的空状态。裸 `/skills` 报告同一列表。 |
| `/skills approve <id>` | 丢弃技能写入已落地的暂存技能条目，并在批准时附带该提醒；不是暂存技能的 id 报告 `No staged skill '<id>'.`。缺少有效捕获契约的**新建**提案保持暂存，并报告缺失的证据；`patch` 仅凭批准即可通过。 |
| `/skills <anything-else>` | `Usage: /skills pending \| approve <id>`。 |
| `/journey [today\|7d\|30d\|all]` | 渲染作用域时间线：窗口标题、每个活跃日一行、容量与摘要，以及暂存计数。裸 `/journey` 报告 `7d`。 |
| `/journey <anything-else>` | `Usage: /journey [today \| 7d \| 30d \| all]`。 |
| `/curator status` | 渲染上次通过的时刻、按生命周期状态（含置顶）与信任状态统计的被跟踪技能计数、来自用量台账的今日缓存命中率、来自遥测的技能失败率汇总、待复核分选数及最差失败率，以及最新记录的通过。任一比率在其来源未挂载时具名说明。 |
| `/curator run` | 立即运行一次维护通过：报告移动、跳过计数与快照 id。 |
| `/curator run --dry-run` | 同一通过只预览不写入；快照行显示 `Snapshot: none`。 |
| `/curator staged` | 列出台账为复核而分选的技能，失败率最差在前，并附选择各项的证据与分选时刻。 |
| `/curator optimize <skill> <scenario...>` | 在具名语料场景上运行一次离线优化，报告分选技能补丁 id 或未分选的原因。需要优化器已挂载且位于工作区作用域内。 |
| `/curator experiments [skill]` | 按最新优先打印该作用域的优化台账——时间、技能、结果、产出候选的算子、分选 id 及其产出算子、晋级行上的 `+added/-removed` 行数、置信度计数与原因——让第二次运行从已试过的东西出发。需要优化器已挂载且会话在某个工作区作用域内。 |
| `/curator adopt <name>` | 把由模型写出的技能认领为用户主导，并报告 `Adopted '<name>' (state: <state>)`；无模型作者身份一律拒绝。 |
| `/curator purge [--dry-run]` | 删除超过 TTL 的归档技能，并报告按目录或按记录的删除与因置顶而跳过者；`--dry-run` 只预览名单而不写入。 |
| `/curator rollback --id <id>` | 回滚一次已记录的通过：先报告被恢复的生命周期状态，若 SKILL.md 正文由其前像恢复，再输出 `Restored bodies: <names>`。 |
| `/curator ledger` | 按新到旧列出已记录的通过及其流转计数。 |
| `/curator pin <name>` / `/curator unpin <name>` | 置顶或取消置顶一个被跟踪技能，并报告 `Pinned '<name>'` / `Unpinned '<name>'`。 |
| `/curator <anything-else>` | `Usage: /curator status \| run [--dry-run] \| staged \| adopt <name> \| purge [--dry-run] \| rollback --id <id> \| ledger \| pin <name> \| unpin <name> \| optimize <skill> <scenario...> \| experiments [skill]`. |
| `/refine` | 经由评审器重建作用域经验并报告 `Memory rebuild complete.`。 |
| `/refine <anything>` | `Usage: /refine (no arguments)`——命令不接受参数。 |
| `/trajectory` | 经轨迹服务导出调用会话并报告 `Trajectory written to <path> (<n> conversations, <n> bytes).`。 |
| `/dream [light\|rem\|deep]` | 把该作用域已记录的失败固化为持久记忆，或运行单个阶段；报告各阶段扫描、暂存、提升与剪除的数量。 |
| `/trajectory --out <path>` | 同一导出写入指定路径。 |
| `/trajectory --all` | 导出调用会话所在 workspace 作用域的全部会话，而不是当前会话。 |
| `/trajectory <anything-else>` | `Usage: /trajectory [--out <path>] [--all]`。 |
| `/learn <anything>` | 构建调研并保存的提示词，作为一个普通回合排队：`Started a learning turn for '<topic>'. The skill lands only through the gated skill_manage write.` |
| `/learn` | `Usage: /learn <anything>`——命令需要一个主题。 |
| `/suggestions` | 列出 frontmatter 声明了 blueprint 的技能，格式为 `- <name>: <description> (schedule <schedule>, deliver <session\|file>)`，并附上不会调度任何内容的提醒。 |
| `/suggestions <anything>` | `Usage: /suggestions (no arguments)`。 |
| `/frontier` | 按实测证据把该作用域的技能从最弱到最强排序，格式为 `- <name>: <score> [<wins>/<runs>] [· <n> failures [(top: '<message>')]] · <loads> loads in <sessions> sessions[: <description>]`，末尾附排序规则。 |
| `/frontier <anything>` | `Usage: /frontier (no arguments)`。 |
| `/budget` | 按各自的配额结算每一条已记录的批次，格式为 `- <batchId> (<candidateClass>, <taskClass>): <spent>/<maxTokens> tokens, <spentMs>/<maxWallTimeMs>ms`，并给出精确的剩余余量；超出时改为 `EXCEEDED by <tokens> tokens, <ms>ms`。裸 `/budget` 列出全部批次。 |
| `/budget spends [<batchId>]` | 列出已记录的开销，格式为 `- <batchId>: <tokens> tokens, <wallTimeMs>ms, <n> rollouts at <instant>`。 |
| `/budget <anything-else>` | `Usage: /budget [spends [<batchId>]]`。 |
| `/meta` | 列出在任意任务类别上记录的引擎配置，按得分从高到低，格式为 `- <configId> (<taskClass>): <pct>% pass over <n> runs, <tokens> mean tokens, score <score>`。 |
| `/meta runs [<taskClass>]` | 列出已记录的引擎运行，格式为 `- <runId> (<taskClass>) pass\|fail, <tokens> tokens, <wallTimeMs>ms at <instant>`。 |
| `/meta recommend <taskClass>` | 给出该任务类别下存储推荐的配置，连同其算子、评估器、预算与路由选择以及排名依据的数字；证据不足的类别则如实说明。 |
| `/meta <anything-else>` | `Usage: /meta [summaries [<taskClass>] \| runs [<taskClass>] \| recommend <taskClass>]`。 |
| `/operators <artifactClass>` | 将该产物类别的变异算子从优到劣排序，格式为 `- <operator>: <n> attempts, <pct>% accepted, mean delta <delta>, <pct>% regressions, score <score>`。接受率与得分来自排名，回归率则从该类别的统计行合并。 |
| `/operators` | 统计并列出有记录的产物类别，不做排序。 |
| `/operators <anything-else>` | `Usage: /operators <artifactClass>`。 |
| `/router` | 列出实测的路由行，格式为 `- <provider>/<model> (<role>, <taskClass>): <pct>% pass over <n>, <tokens> mean tokens, <ms>ms mean`。 |
| `/router effectiveness [<taskClass>] [<role>]` | 同样的列表，收窄到给定任务类别与 §28 角色；不可用的角色会报告用法。 |
| `/router recommend <taskClass> <role>` | 给出该组合下存储推荐的路由及排名依据的数字，或说明尚无路由积累到足够结果。 |
| `/router <anything-else>` | `Usage: /router [effectiveness [<taskClass>] [<role>] \| recommend <taskClass> <role>]`。 |
| `/evaluator-strategy` | 列出已记录的评估器信任行，格式为 `- <evaluator> (<taskClass>): <n>/<m> independent corroborations over <n> verdicts, weight <weight> at <instant>`。 |
| `/evaluator-strategy rank <taskClass>` | 将该类别的评估器按可信度从高到低排序，并附每个排名背后的印证次数与权重。 |
| `/evaluator-strategy <anything-else>` | `Usage: /evaluator-strategy [strategies [<taskClass>] \| rank <taskClass>]`。 |

`applyDecisions` 条目在 gist 里给出一批决策的计数——confirms、contradicts 与 new 各多少条——并在该行之下为每个决策各列一行缩进明细：`new '<statement>'`、`confirms '<current statement>'` 或 `contradicts '<current statement>'`，而当该条反驳携带了更正后的 statement 时则是 `contradicts '<current statement>' → '<replacement>'`。`confirms` 或 `contradicts` 的目标渲染为记录当前为该工件持有的 statement；记录已不再持有时则渲染为该工件的 id——该 id 正是工件创建时所用的规范化 statement，因此读起来仍是文本。其他操作只打印自己的 gist 行；渲染器读不懂其载荷的 `applyDecisions` 条目同样如此：读不懂的暂存载荷不渲染任何明细行，而不是让整张列表失败。

### 你会看到什么

命令会把每个预期失败转换为可直接展示的稳定消息；左列的情形产生右列的消息。

| 情形 | 你看到的消息 |
|---|---|
| 会话不在任何 workspace 内（作用域命令） | `This session is outside any workspace scope.` |
| 经由 `/memory` 批准技能类条目 | `Staged skill '<id>' (<op>) is decided by '/skills approve <id>': write the skill with skill_manage first, then approve there to drop the entry.`——条目保持暂存。 |
| 批准时触发上限或子串拒绝 | `Cannot approve '<id>' (<code>): <detail>. The entry stays staged.` |
| 批准缺少准入证据的新建提案 | `Cannot approve '<id>' (evolution/staged-blocked): staged evolution write '<id>' is blocked: <needed evidence>. The entry stays staged.` |
| 批准或拒绝未知 id | `No staged write '<id>'.` |
| `/skills approve` 的 id 不是暂存技能 | `No staged skill '<id>'.` |
| 未挂载评审器时 `/refine` | `The evolution reviewer is not mounted.` |
| 未挂载整理器时 `/curator status` | `The evolution curator is not mounted.` |
| 重建被拒绝 | `Memory rebuild failed (<code>): <detail>.` |
| 未挂载导出器时 `/trajectory` | `The evolution trajectory exporter is not mounted.` |
| 在任何 workspace 作用域之外使用 `--all` | `This session is outside any workspace scope.` |
| 导出被拒绝 | `Trajectory export failed (<code>): <detail>.` |
| 未挂载技能注册表时 `/suggestions` | `The skill registry is not mounted.` |
| 未挂载优化器时 `/frontier` | `The evolution optimizer is not mounted.` |
| 未挂载遥测时 `/frontier` | `Skill telemetry is not mounted. The frontier needs the telemetry store.` |
| 没有任何技能时 `/frontier` | `No measured capabilities yet.` |
| 没有任何带 blueprint 的技能时 `/suggestions` | `No blueprint-backed skills. A skill appears here when its frontmatter declares a blueprint; this command never installs the schedule it names.` |

取消 `/refine` 即停止等待：注册表以中止原因结算调用，与 `/compact` 的取消约定一致。除上述预期情形外的失败会以错误形式呈现，而不会被静默转换。

### 组合命令

挂载命令注册表、workspace 注册表与演进记忆存储；`/refine` 需要评审器，而 `/curator` 在整理器与技能遥测挂载时读取它们：

```yaml
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-workspace'
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-evolution-reviewer'
- name: '@deepseek-ai/dsh-command-evolution'
  config:
    profile: default
```

没有 `ctx.commands` 的界面无法调用它们；暂存写入转而等待已挂载的命令适配器或控制器。`/curator status` 是宿主级的，能从任何会话工作，包括不在任何 workspace 作用域内的会话；整理器、遥测、轨迹导出器、评审器与技能注册表都是通过 `ctx.get` 读取的可选服务，因此即使部署中没有它们，该命令依然可用，并给出诚实的简短回答。

### 对话会发生什么

批准经由存储自身的写入链应用暂存的记忆操作，因此上限与子串拒绝会像直接存储调用一样保留条目；拒绝丢弃任一类别。一批暂存的 `applyDecisions` 是一次写入：批准会在审批时读到的记录上应用整批，因此上限拒绝会让它的每一条决策一起留在暂存。命令生命周期记入会话日志，永不进入模型历史。`/learn` 是唯一会开启回合的命令：它把一段由提示词构建器撰写的消息作为自己回合的唯一普通消息排队，模型随后用已有工具收集材料，并经由受提案门控的 `skill_manage` 写入器提议一个技能。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该命令建立在五项承诺之上：

- **治理不新增持久状态。** 插件不拥有任何域：待审批列表与时间线读取作用域记录（整理器则经由整理器服务读取自己的台账），变更委托 `approveStaged` / `rejectStaged`，重建把作用域加信号转发给 `evolutionReviewer.rebuild`，导出把会话或作用域转发给轨迹服务，建议读取技能目录。存储仍是唯一权威。
- **批准者先执行技能写入。** 批准技能类条目在存储中只会丢弃它，因此 `/skills approve` 也这么说：人类先写入技能（经由 `skill_manage`），再批准以丢弃条目，而 `/memory approve` 会把技能类 id 重定向到那里。没有任何内容被静默丢弃或静默应用。
- **读取只报告记录能证明的内容。** `/journey` 按仪表盘的 UTC+7 日历，为记录携带的每项事实各输出一个增量——每个文档族都来自它自己的写入时间戳、每个上下文条目、每个已索引产出、每条暂存条目——并在裁决落地当天计入该裁决；它绝不猜测一次无法解释的 `updatedAt` 移动的是哪个字段。
- **排队不等于写入。** `/learn` 构建提示词并排队一个普通回合；命令自身不写任何内容，因此唯一的保存路径是受提案门控的 `skill_manage`。`/suggestions` 只读取 blueprint，不调度任何内容。
- **完全停稳的拆除。** 生命周期 effect 先注销这些命令，再排空已开始的处理器，因此根拆除不会越过一次进行中的重建——正如 `/compact` 不会越过一次中止的压缩。

### 归属与作用域

作用域解析复制注入器的归属规则但不带缓存——命令是一次性的，因此每次调用都执行注册表会话归属加规范 `cwd` 回退，不保留任何状态；`/curator status` 是宿主级的，完全不解析作用域。`profile` 门控与注入器一致：空的或含 `:` 的命名空间在插件加载时大声失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令注册、作用域解析、暂存与导出失败映射、`/learn` 提示词构建器、blueprint 解析、生命周期排空 |
| [`src/journey.ts`](src/journey.ts) | 纯 `/journey` 读模型：按文档族与上下文/产出/暂存的增量、已裁决条目计数、按天桶、累计核算、渲染 |
| — | 不发布运行时不变式伴随条目；该命令适配器不拥有任何状态或事件流；演进记忆存储拥有唯一的持久域表，命令注册表拥有注册与分发生命周期。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从命令逐步进入存储、评审器与设计决策。

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——这些命令治理的行为契约。
- [evolution 组地图](../README.zh.md)——本分组的包及其仓库位置。
- [命令包](../../interaction/commands/README.zh.md)——聊天命令背后的注册表与分发约定。
- [Usage ledger](../../session/usage-ledger/README.zh.md)——时间线分桶所用的 UTC+7 日历与窗口辅助函数。
- [改进路线图](../../../specs/improvement.spec.md)——这些命令落地的 Phase 6 CLI 切片（`/suggestions` 仍在计划中）。

-----

<a id="model-experience"></a>
## 模型体验

### 人类治理命令

#### 模型看到的内容

斜杠输入与直接结果（例如 `No pending writes.`）绝不会进入模型请求。已批准的记忆写入随后作为注入的演进简报的一部分到达模型；重建改写下一份简报渲染的已存经验。`/learn` 是有意的例外：它由提示词构建器产出的内容作为普通 user 角色回合排队，因此模型看到的正是该命令构建的调研并保存指令——包括 `skill_manage` 写入受提案门控的提醒。

#### Token 影响

命令生命周期不会增加模型 token；结果只是面向人类的命令文本。`/learn` 会开启一个回合，因此它花费的 token 与该提示词上任何其他回合相同。

#### KV Cache 影响

命令发现与簿记不会影响缓存。已批准的经验变更会从下一份注入简报起使复用失效，与直接存储写入完全一致。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该命令何时不合适；它们是当前包约束。

- **不应用技能写入**——`/skills approve` 丢弃暂存技能条目；技能文件由 `skill_manage` 写入，命令本身从不写技能文件。
- **`/learn` 依赖受门控的写入器**——命令只排队一个回合；如果组合出的 agent 没有 `skill_manage`（或没有收集工具），该回合无法保存任何内容，提示词也会如实说明，而不是假装技能已落地。
- **`/suggestions` 只是建议**——它读取 blueprint 且不调度任何内容；安装 blueprint 所命名的 cron 条目仍是人类单独且审慎的行动。
- **blueprint 读取兼容两种表面**——技能的 blueprint 从解析后的 frontmatter 字段读取，或从它被解析自的 frontmatter 袋读取，因为发现层只发布其中一种；未被接受的形状只是不被建议。
- **导出需要导出器**——组合中缺少轨迹导出器时 `/trajectory` 报告 `The evolution trajectory exporter is not mounted.`，文件布局由导出本身拥有。
- **每次调用只治理一个作用域**——作用域命令只治理调用会话所在的作用域；没有跨作用域视图（只有 `/curator status` 与 `/suggestions` 是宿主级的）。
- **仅限命令适配器**——没有 `ctx.commands` 的界面无法调用它们；暂存写入转而等待已挂载的适配器或 `evolutionController` Remote 命名空间。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **注入器归属收敛，尚未决定**——作用域解析复制了注入器的归属规则但不带缓存。抽取共享辅助函数（由记忆包或 workspace 注册表拥有）要等到第三个消费者出现；两份副本加一处明确的所有者说明，比过早的 seam 更便宜。

</details>

# Agent Note：能力前沿

Status: implemented

[English](2026-09-16-capability-frontier.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §33 要求一张 capability → 当前得分 → 置信度 → 已知失败 → 技能覆盖的地图，让系统能回答"下一步学什么"，而不是等下一个任务。输入全在仓库里——优化器台账的行（winner triple + promotion tally）、遥测记录（加载与失败）、feedback 信号、技能目录——但没有任何东西连接它们：`/suggestions` 列的是可调度的 blueprint（另一个轴），`/curator experiments` 按时间列运行、不给技能排名。缺的正是这个连接。

## Decision

**一个纯排序加一个只读命令，不添包、不添域、不写、不加旋钮。**

- **一个 capability 就是一个 skill。** 遥测记录是唯一能连接所有缝的单技能身份：优化器行带 `skill`，feedback 经记录的 `sessionIds` 关联，目录按名称索引。更大的粒度（任务领域）需要仓库没有的分类法。
- **`rankFrontier` 是纯函数**（`command-evolution/src/frontier.ts`）：从最弱到最强分三组——有失败且无 passing winner、未测量、passing。组内：失败按失败数降序再按名称；未测量按名称；passing 按未确认优先、再按胜场数、再按胜率、再按 cost（同 tally 下更贵的 pass 更弱——优化器自己的支配关系）。无权重、无阈值；分组即排序。Archived 技能永不上榜——退出学习池是整理器的决定。
- **`/frontier` 直接读缝**，本包既定模式：按 skill 查优化器（各 skill 自己的台账页，不截断）、遥测 entries、每个 skill 会话表的第一条 feedback 信号、目录描述。缺优化器或遥测则大声报错；缺目录或 feedback 则降级为更少文字。会话在作用域外则与其它作用域命令同样报错。
- **每技能一行、自解释输出**：得分（`pass/fail at N tokens` 或 `unmeasured`）、tally（`wins/runs`，未确认则省略）、失败数及"在场" top 消息、加载与会话数、描述——末尾附排序规则。"while in play" 的限定是故意的：feedback 按会话关联而非因果，行文本不得多 claim。

## Alternatives considered

- **把 frontier 并入 `/suggestions`。** 设计评审中否决：suggestions 按可调度性（blueprint）排，frontier 按实测弱点排——一个输出按两轴排序，两边读者都不 serve。
- **为它新开包、服务与域。** 否决：frontier 推导别人的状态且不写任何东西；为一次连接搭注册、生命周期与目录面不值。
- **置信度只看胜场或只看胜率。** 在补 comparator 覆盖时否决：只看胜场把扎实的 4/5 排到单薄的 1/1 之后；只看胜率反过来。胜场、胜率、cost 的顺序让证据单薄者先于实测良好者、挣扎者先于扎实者——正是"下一步学什么"要的顺序。
- **对渲染后的分数字符串排序。** 否决，改为先排输入再渲染：`pass at 10000 tokens` 按字典序排在 `pass at 900` 之后。模块注释写明该规则。
- **把 archived 技能当"已知失败"列出。** 否决：解归档是整理器的决定；命令连对它们的读取都跳过，不止跳过行。

## Consequences

人（或未来的调度器）看到从弱到强的能力及每行背后的证据，用之前各 batch 建的缝闭合了 §33。代价都在文档里：遥测是 host 级、实验是 scope 级，某技能的覆盖数可能反映别的 scope；每周在恢复与失败间横跳的技能会在 frontier 上移动；按技能查台账使命令复杂度为 O(skills)——聊天命令够用，热路径免谈。

验证：11 个单元测试（分组、排序、双向 comparator、archived 排除、行渲染）；4 个命令测试（grammar/缝/作用域守卫、空态、四缝完整渲染逐字断言、无 feedback 与目录的降级）；外加注册表列举。`frontier.ts` 的语句、分支、函数、行四项 100%。

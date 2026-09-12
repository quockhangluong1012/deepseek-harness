# Agent Note: 演进 CLI 治理——/memory 与 /refine 命令

Status: implemented

[English](2026-09-11-command-evolution.md) | 中文

## Problem

演进存储可以暂存写入，却没有任何界面可以治理它们：`stageWrite` 暂存记忆与技能提案，但没有界面能列出、批准或拒绝；评审器的 `rebuild` 也没有按需入口。改进路线图要求在 Web 之旅落地前由 CLI 治理，不新增域，也不新增会话事件。

## Decision

在 `evolution/` 分组交付 `@deepseek-ai/dsh-command-evolution` 函数插件（`name` / `inject` / `Config` / `apply`，无默认导出），在 `ctx.commands` 上注册 `/memory` 与 `/refine`。`/memory pending` 把调用会话作用域的条目列为稳定的单行（无待审批项时如实为空）；`/memory approve <id>` 经由存储自身的写入链应用记忆类条目，上限与子串拒绝会保留条目；`/memory reject <id>` 丢弃任一类别；`/refine` 把作用域加信号转发给 `evolutionReviewer.rebuild`。作用域按注入器的方式解析——先查注册表会话归属，回退到规范 `cwd` 匹配——使用必填的 `profile`，空的或含 `:` 的命名空间在加载时大声失败。评审器经由 `ctx.get` 保持可选：未挂载时 `/refine` 报告其未挂载。预期的 Remote 失败映射为稳定的命令文本（`No staged write`、`Cannot <verb> (<code>)`、`Memory rebuild failed (<code>)`）；普通错误向上传播。拆除先注销两个命令，再排空已开始的处理器，复制 `/compact` 的 LIFO 模式。

## Alternatives considered

- **批准技能类条目时直接丢弃。** 已拒绝：存储在批准时只丢弃技能条目，前提是批准者先执行了技能写入，而本命令尚不能执行技能写入。命令携带 `skill_manage` 指引拒绝并保留条目，因此没有任何内容被静默丢弃；拒绝仍可用于打回。
- **先做控制器治理。** 本切片已拒绝：路线图要求 CLI 优先，而控制器需要尚不存在的时间线读模型。命令恰好覆盖已实现的存储表面（暂存写入加 rebuild），不新增域或会话事件。
- **与注入器共享归属辅助函数。** 推迟到第三个消费者出现：命令复制注入器的归属规则但不带缓存（一次性调用不保留状态），已记入包开发备注。两份副本加一处明确的所有者说明，比过早的接缝更便宜。
- **用提前返回处理不可解析的作用域。** 在按文件覆盖率门禁标红后已拒绝：`await` 后的无大括号（后加了大括号）`if (canonical === undefined) return undefined` 会把 else 路径报告为从未执行，尽管回退测试可证明执行过它——这是 v8 分支映射的怪异行为，不是死代码。三元形式映射正确且行为一致；重跑覆盖率之前不要把它改回去。

## Consequences

暂存的演进写入今天起可在任何命令适配器中治理：后台提案出现在 `/memory pending`，记忆条目经由 `/memory approve` 落地，不想要的经由 `/memory reject` 离开。技能提案明确阻塞在其技能写入上，如实反映了缺失的批准者另一半。`/refine` 给 rebuild 路径一个人类入口，不触碰评审器的门控与来源标记。

## Testing

二十一个用例锁定：带 Loader 安全导出与双重注销的注册、profile 拒绝、固定的 `/memory` 文法（含全部用法拒绝）、无作用域会话、直接与 `cwd` 回退解析加未命中 `cwd`、空/单/多条待审批列表（含生命周期对）、批准应用及存储状态、未知 id、拒绝不应用、技能拒绝且保留条目、上限拒绝且保留条目及错误码、未知存储失败向上传播、纯失败文本辅助函数、`/refine` 的用法/无作用域/缺评审器/Remote 失败/取消/未知失败路径及精确的信号转发，以及拆除结算前排空进行中的处理器。Loader 组合用例经由 `cordis.yml` 启动真实注册表、存储与命令平面，端到端驱动 pending → approve → refine（含经由真实存储的桩评审器写入）。语句、分支、函数、行按文件 100% 覆盖。

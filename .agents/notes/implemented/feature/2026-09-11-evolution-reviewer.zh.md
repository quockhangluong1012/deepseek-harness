# Agent Note: 演进评审器——缓冲回合、受门控的提取、重建

Status: implemented

[English](2026-09-11-evolution-reviewer.md) | 中文

## 问题

演进存储交付时没有写入者：没有包索引产出文件、从回合提炼经验，或从历史重建文档。逐字复制 workspace-memory 提取器有两处被堵死：它的单回合后向扫描经由 `ownEvents()` 读取会话历史，而新产品代码不得调用它；它的整文档 `setMemory` 在双层经验/画像加审批暂存的存储里没有对应物。

## 决策

在 `evolution/` 分组交付 `@deepseek-ai/dsh-evolution-reviewer`（`ctx.evolutionReviewer`），沿用[演进记忆存储决策](2026-09-11-evolution-memory-store.zh.md)。评审器在 `session/event` 投递时按会话缓冲当前回合的承认行与工具结果，在 `turn/end` 刷出：产出索引始终运行；`enabled` 开启、承认文本越过 `minTurnTextBytes`、按作用域冷却到期、且路由从配置 pair 或会话折叠请求头解析成功时，运行提取。作用域按配置 `profile`（默认 `default`）从 workspace 归属解析。提取调用使用 `temperature: 0` 与 `purpose: 'evolution-review'`，以 `background_review` 来源重写整份经验文档——直接写入，或在 `writeApproval` 开启时以 `setLessons` 操作暂存。超预算输出先裁剪到存储自身的 `too-large` 上限再重试一次，并标记 `truncated`。`rebuild` 经由 `sessionQuery.filterEvents` 从新到旧翻页读取历史，跳过归档会话，丢弃超出 `maxInputBytes` 的最旧行但保留单个超预算行，始终以 `rebuild` 来源直接写入；无路由、无查询面、全局或未知作用域一律大声拒绝。同一作用域永不并发两次提取；teardown 与会话释放会中止在途调用。用量经由请求自身的 `evolution-review` purpose 归属：用量台账与 token 表都没有任务钩子，因此不存在独立的台账写入。

## 备选方案

- **照搬 workspace 提取器的后向历史扫描。** 否决：新代码禁止调用 `ownEvents()`，而禁令开出的正是已交付的模式——从投递事件增量维护回合缓冲，经由显式异步面读取历史。
- **无 `sessionQuery` 时退回实时会话。** 否决：唯一的实时退路同样经过被禁的同步读取器。重建改为以 `evolution/extraction-failed` 大声失败，web 组合永远碰不到它。
- **同一次提取顺带写用户画像。** 首版否决：提示只返回 Purpose/Preferences/Decisions/References 标题下的一份文档，存储的画像层保持手工维护；把一次模型输出拆到两个文档，会发明规范未定义的组帧协议。
- **现在做延迟队列与 subagent 评审分支。** 首版否决：按作用域 promise 链已串行化重叠回合，带工具白名单的委派评审是信任面独立的能力；README 已把两者记为延期工作。
- **经由存储 `/types` 子路径导入经验/主体类型。** 在 Cordis 目录生成器拒绝后否决：跨包类型引用经由所属包根解析，评审器改为从 `@deepseek-ai/dsh-evolution-memory` 直接导入 `EvolutionScopeId`、`EvolutionExtraction` 与 `EvolutionOutput`。

## 后果

挂载评审器的作用域以每个受门控回合一次有界模型调用累积经验与产出文件索引，后台写入可暂存待批，重建按需可用。评审器挂载时正在进行的回合从其被观测到的后缀提取，重建依赖会话查询面已挂载。评审器不拥有持久状态：缓冲与链是调度，释放时清空。

## 测试

26 例评审器规约锁定：全工具参数矩阵的文件索引、含目录退路的作用域解析、路由优先级与无路由跳过、琐碎/冷却门控、max-tokens 容忍，以及 error、aborted、工具调用、异种收尾下旧文档保留、上限裁剪与截断标记、审批暂存与事后应用、按作用域串行与被取代链丢弃、释放中止、跳过归档的新到旧重建、无路由/查询/作用域的重建拒绝、teardown 后静默，全部基于真实存储/域栈；语句、分支、函数、行四项文件级 100%。配置规约锁定 pair 校验、profile 校验、提示组帧与 UTF-8 裁剪边界。

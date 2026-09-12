# Agent Note: Evolution recall, lean squeeze, and decided-write history

Status: implemented

[English](2026-09-12-evolution-recall-squeeze.md) | 中文

## 问题

[`specs/improvement.spec.md`](../../../../specs/improvement.spec.md) 的第 2 阶段在 evolution 家族留下三处缺口。存储会在任一决策上直接丢弃暂存条目，因此旅程无法统计批准与驳回；单一的 `memoryUpdatedAt` 同时覆盖指令、经验与画像，读者无法判断一次写入触及了哪一族。评审器把模型返回的内容原样写入，无论是否带标题，仅受存储字节上限约束。而没有任何逻辑使用会话搜索 seam：连续性只来自某个作用域自己的文档，从不来自同一目录中的既往工作。

## 决策

**存储保留已决写入。** `approveStaged` 与 `rejectStaged` 会把一条 `StagedResolution`——条目 id、kind、op、gist、决策、来源会话与时刻——追加到最新优先的 `resolutions` 日志，受 `maxResolutions`（默认 `200`）限制。决策记录既不计入容量，也不进入摘要，因此一次决策永不重新注入简报。

**每个记忆族盖自己的时间戳。** `setInstructions` 盖 `instructionsUpdatedAt`；`setLessons`、`addLesson`、`replaceLesson` 与 `removeLesson` 盖 `lessonsUpdatedAt`；`setUserProfile` 盖 `profileUpdatedAt`。暂存审批只为它改动的族盖章，重复追加经验则一个都不盖。`memoryUpdatedAt` 再保留一个版本，取经验与画像两个时间戳中的较晚者。两处模式新增都带默认值（`.default(null)`、`.default([])`），因此在它们之前写入的记录仍能打开：这是兼容的形状调整，而非版本升级。

**暂存载荷是诚实的 JSON 值。** `StagedWrite.payload` 与 `StagedWriteInput.payload` 是来自 `@deepseek-ai/dsh-util-values` 的 `JsonValue`，而不是 `unknown`，因为记录会跨越 Remote 边界，而不受约束的 `unknown` 没有线上形态。持久模式把该字段声明为 `stagedWritePayload = z.json()`（与 `checkpointRow` 在其持久边界所用的同一份声明），`stageWrite` 用它校验调用方：无法无损往返 JSON 的载荷——`undefined`、`NaN`、函数、`Date`——会被大声拒绝，且不存储任何内容。构造暂存载荷的消费方在调用处做类型断言（评审器的 `{ text, extraction }`），这是仓库中既有模式：类型化对象进入 JSON 字段；存储始终是执行点。

**一个纯函数挤压位于提取器输出与存储写入之间。** `squeezeLessons` 只保留四个记忆标题；首个标题之前的散文与任何其他标题之下的行都会被丢弃。超出 `squeezeBytes`（默认 `65536`）时，按 `squeezeOrder`（默认 `References, Decisions, Preferences, Purpose`）整体清空正文，最后一个仍在的正文在 UTF-8 边界处裁剪。只要由此丢失材料，存储的来源记录就标记 `truncated`。完全不携带可识别标题的输出原样返回：畸形的响应绝不能悄悄抹掉某个作用域的经验。`squeezeOrder` 在加载时被校验为标题的一个排列，因为缺少某个标题的顺序会让该小节从每次提取中消失。`compaction-basic` 检查点未被触碰。

**召回与重建按排名选取材料。** 后台评审开启时，每个被观测的回合都会由其最新人类消息导出查询，向按目录限定范围的排序搜索 seam（`sessionQuery` 上的 `searchSessions`，绝不使用面向模型的工具）请求作用域目录中的候选会话，并跳过提问会话。候选经 `readEvent` 解析，并通过 `admittedRow`——即时缓冲与精确重建扫描所用的同一条规则——因此注入的简报或指令消息永不会被召回回来。最强的被承认命中作为该作用域唯一的上下文条目落地，标签为 `Recall: <sessionId>`，内容变化时替换，未变化时不动。简报把召回条目渲染在最后，因此它们在压力下最先被丢弃。重建对每个会话使用同一 seam（先 `searchSessions` 再 `searchEvents`），按最不相关优先累积行，使笔录上限丢弃的是召回而非最强命中；当 seam 缺席、不完整、为空、失败，或作用域尚无被观测回合时，回退到精确的 `readSurface` 扫描。

## 备选方案

**从 `@deepseek-ai/dsh-workspace-memory-llm/src/prompt.ts` 读取 `MEMORY_HEADINGS`。** 改进规范把这条列为复用路径。已否决：该包根并不导出它，因此这个 import 需要在本次改动范围之外的 `tsconfig.base.json` 中加入路径条目，并为四个字符串常量引入跨分组依赖；仓库本就把 evolution 评审器视为逐字复制的分叉，其复用不是共享代码。`squeeze.ts` 改为采用分叉自身的 `LESSON_HEADINGS`，两个提示仍然钉住同样的四个标题。

**只把召回条目放在渲染出的简报里。** 已否决：合成条目没有持久身份，无法计入容量或摘要，而且会在每一步重新注入。真实的上下文条目原样复用了存储的 uuid 身份、摘要覆盖与丢弃顺序。

**让召回条目的身份扩展简报摘要。** 已否决：每步一次搜索与扩展身份会让大多数回合都追加一份新简报。条目存在记录里，因此召回变化会改变记录摘要、下一份简报即为新简报，而召回未变化时不写入任何内容。

**把排序搜索当作重建的唯一来源。** 已否决：查询若无匹配，就会把一份好文档换成只剩标题。排序召回提供材料，精确扫描是下限。

**在放不下时丢弃最重要标题的正文。** 已否决：清空针对的是最不重要的小节，因此最后剩下的那个在 UTF-8 边界处裁剪并报告 `truncated`。

## 后果

旅程读模型现在可以统计批准与驳回，并区分指令、经验与画像写入；记录增加了一份受上限约束的日志，任何容量或摘要规则都看不到它。提取更精简、结构更稳定，代价是模型在标题之外输出的散文；而把 `squeezeBytes` 配得高于存储的 `maxAgentBytes` 时，最终仍由存储自己裁剪。召回让作用域的简报携带其目录中的既往工作，代价是每个被观测回合一次索引搜索，以及一个一旦变化就改变摘要的上下文条目。重建质量如今取决于部署的搜索后端：没有排序 seam 时它降级为精确扫描而非失败；有排序 seam 时它只会*补充*材料，永不取代精确下限。由于随附后端把查询当作字面短语匹配，从未在已索引会话中逐字出现的查询不会返回候选——召回在构造上就是尽力而为。

## 测试

`packages/evolution/evolution-memory/tests/store.spec.ts` 钉住两种决策都被记录且受上限约束、非 JSON 暂存载荷被拒绝且不存储任何内容、决策记录不计入容量与摘要、每一族只被自己的写入与暂存审批盖章（重复追加不盖章），以及带默认值的模式能接受在新增字段之前写入的记录。`packages/evolution/evolution-reviewer/tests/squeeze.spec.ts` 钉住标题收集、按压力顺序清空、可配置顺序、UTF-8 裁剪、空白边界修剪，以及畸形输出与预算放不下任何正文时的返回。`reviewer.spec.ts` 钉住按目录限定范围的排序召回、单个被替换条目、注入上下文候选被拒绝、seam 缺席/不完整与空白请求路径、排序重建的过滤器与组帧、每一种降级下的精确扫描回退，以及 `squeezeBytes` 超出存储上限时的裁剪。`packages/context/evolution-memory-context/tests/inject.spec.ts` 钉住召回条目渲染在最后并最先被丢弃。三个 `src` 树在语句、分支、函数与行上都保持逐文件 100%。

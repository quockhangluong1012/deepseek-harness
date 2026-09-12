# Agent Note: 技能加载期环境与技能创建证据

Status: implemented

[English](2026-09-12-skill-load-time-environment.md) | 中文

## Problem

skill 可以声明它需要什么，却没有任何东西读取这些声明。`required_env` 与 `config` 已经被解析到 `ParsedSkill` 上（见 [frontmatter 白名单](2026-09-12-skill-frontmatter-allowlist.zh.md)）并投影到加载的定义上，但加载器照原样渲染正文：声明了环境变量的 skill 即使该变量未设置也照常加载，部署也无法把 skill 正文所需的值交给它。除两个保留变量之外，`${...}` 序列一律原样保留，因此想在加载期取得宿主事实的 skill 无从取得。

第 3 阶段还有两个界面没有归属：提议创建 skill 的被计数触发器（以重复证据代替供应方引用的重复数字），以及合并规模运行在扇出之前必须记录的成本行。

## Decision

两条加载路径——`skill` 工具与用户显式的 `/name` 注入——都在 `renderSkillContent` 包装正文之前，于 `packages/skill/tool-skill/src/load.ts` 走同一步解析与渲染。

**`required_env` 透传。** 每个声明的名称都必须在宿主环境中已设置且非空；其值成为该 skill 执行命令（下文的 内联 shell）的 `env`。未设置的名称会以 `skill "<name>" requires environment variable "<NAME>", which the host environment does not set` 令加载失败。工具抛出该错误；注入路径改为警告 `skill "<name>" skipped: …` 并在该步骤省略注入。

**`skills.config` 注入。** 声明的键是部署的 `skills.config.<skill>` 映射与该 skill 自身 frontmatter `config` 映射的并集。已部署的值优先于 skill 自身默认值，空白值视为缺席，两者都无值的已声明键令加载失败并列出每个缺失的键。已解析的值在任何 shell 展开之前替换正文中的 `${<key>}`，因此同名的已声明键总是优先于命令，同时它们也加入执行环境。

**内联 shell，需显式选择加入。** 只有设置 `metadata.shell: true` 的 skill 才允许未声明的 `${...}` 序列作为命令，通过已挂载的 `ctx.shell` 执行器运行（执行器缺席时渲染为空并警告）。每个不同命令只运行一次，工作目录为 skill 自身目录，环境为已解析的环境，受 `metadata.shellTimeoutMs`（默认 `10000`，须为正数）与由 4000 字符上限派生的 `stdoutMaxBytes` 约束。失败、超时、被中止或被拒绝的命令不贡献任何内容，并在宿主日志中警告。畸形的 `metadata.shell`（非布尔）或 `metadata.shellTimeoutMs`（非正整数）会令加载失败，而不是静默关闭该功能。

**被计数的技能创建触发器。** `packages/skill/evolution-skill-telemetry` 中的 `skillCreationEvidence(paths)` 按规范化路径对产出的输出分组——大小写折叠、`/` 与 `\` 等价、忽略结尾分隔符——并报告每个至少被产出 `SKILL_CREATION_OUTPUT_THRESHOLD`（3）次的路径，以及是否有路径达到该阈值。它只统计路径；文件内容从不读取或引用，也不采用任何供应方报告的重复数字。该计数就是触发器：两次相似输出不触发，三次触发。

**合并成本行。** `ctx.evolutionSkillTelemetry.recordConsolidationCost(row)` 在合并规模扇出开始之前存储冻结的 `{ inputBytes, maxOutputTokens, provider, model, truncated }` 行，`readConsolidationCost()` 返回最新行的脱离副本。

注册表携带这些声明值而不拥有它们：`SkillDefinition` 增加 `requiredEnv`、`config` 与 `blueprint`，`validateDefinition` 在提供方边界校验前两者，摘要保持与调用无关，因此它们都不会进入目录。`skill-filesystem` 提供方把解析出的值投影到其加载的定义上（见 [门控与项目扫描笔记](2026-09-12-skill-gating-and-project-scan.zh.md)）；该投影是本功能新增的唯一跨包依赖。

### Install blueprint

`SkillDefinition.blueprint`（`{ schedule, deliver, prompt }`）暴露提供方已经解析出的安装期建议，使安装界面可以从它加载的定义上读取。它刻意留在 `SkillSummary` 与 `SkillCandidate` 之外：目录是面向模型的路由列表，blueprint 不是路由材料；把它放到摘要上，会让每次发现都为只有安装方消费的字段支付目录级接口面积。提议自动化的命令改为按名称加载该定义；按 skill 的加载成本正是保持目录干净的代价。

不可用的 blueprint 会被丢弃，而不是致命错误。`get()` 让每个已加载定义经过 `usableSkill`：blueprint 缺席或形态正确时原样返回，否则复制一份并去掉该字段。发出错误形态 frontmatter 派生值的提供方只失去一条可选建议，而不会让所有消费者共用的加载失败——`skill-filesystem` 的解析本就会把畸形的 `blueprint` frontmatter 连同一条警告丢弃，因此这里是提供方边界的防御，而不是第二次解析。

## Alternatives considered

**只注入环境而不做正文替换。** 否决：部署的值对模型不可见，而正文中指名自身配置（`${region}`）的 skill 无从使用它。

**在正文后附加渲染出的配置块。** 否决：每次加载都要花费 token，并为从不读取该值的 skill 添加一帧模型可见内容；替换不花 token，且按构造即需显式声明。

**通用的 `${ENV}` 插值。** 否决：无限制地把环境变量外流进模型上下文，正是 `required_env` 要避免的安全面；名称必须被声明，而声明的名称在加载时会被校验。

**把 `skills.config` 放到 `dsh-skill` 注册表而不是加载器上。** 否决：注册表负责发现与合并，不负责加载期渲染；把同一步解析拆到两个包里，会使部署配置只能经由注册表的构造函数才能取到。

**按内容哈希或文件名统计相似输出。** 否决：内容恰恰是这个界面绝不能引用的东西，而按文件名分组会让同名的不相关文件触发该触发器。

**为成本行建立持久域。** 否决：curator 会把该行记进自己的账本，第二份持久副本只会让一次运行的计划支出出现双重权威；进程内的行是读界面，不是记录。

**把安装 blueprint 放到目录摘要上。** 否决：目录是面向模型的路由列表，而 blueprint 不影响模型据以路由的任何东西——每次发现都要为只有安装界面读取的字段付费，并且会为没有任何请求期收益的东西加宽模型可见的摘要形态。定义加载才是正确的接缝。

## Consequences

配置错误会响亮失败：声明无法满足的 skill 在加载时失败，而不会带着解析不完整的环境运行，其声明的值也只在宿主确实设置时才到达执行环境。内联 shell 让 skill 正文在加载期于已挂载执行器的环境中可执行——虽有界，但以作者身份为信任前提，因此只有受信任的发现根目录才应出现在部署中。

目录不受影响：声明无法解析的 skill 仍被列出，只在加载时才失败，`requiredEnv`、`config` 与 `blueprint` 都不会进入摘要——安装界面为它考虑的每个 skill 支付一次定义加载。成本行是进程内状态且只保留最近一次运行，这正是 curator 消费的全部；从不做合并的部署永远不会记录它。被计数触发器发布时尚无调用方接入——curator 与命令界面消费 `skillCreationEvidence`，把提议路径接上去是它们的改动。

## Verification

`packages/skill/tool-skill/tests/load.spec.ts` 直接覆盖解析与渲染：声明名称的透传、未设置与空白两种情形、部署值覆盖默认值并带空白部署回退、缺失的键、shell 选择加入与超时默认值、畸形的 `metadata`、配置优先于命令、每个不同命令只执行一次且带 skill 环境与工作目录、包含结尾代理对的字符上限，以及每种失败形态渲染为空并警告。`tests/tool-skill.spec.ts` 在已挂载的假执行器上补齐端到端路径：部署的 `skills.config` 到达已加载正文、未设置声明变量时工具报错与注入警告跳过、失败命令经工具路径警告。`packages/skill/evolution-skill-telemetry/tests/telemetry.spec.ts` 覆盖证据阈值、规范化、排序以及成本行的记录与读取。`packages/skill/skill/tests/skill.spec.ts` 钉住 `requiredEnv`、`config` 与形态正确 `blueprint` 的加载定义透传、与调用无关的摘要（不含 `blueprint` 键）、被拒绝的 `requiredEnv`/`config` 形态、被丢弃的畸形 blueprint 形态，以及 `skills/change` 上报告的隔离计数。`packages/skill/tool-skill/tests/tool-skill.spec.ts` 还通过文件系统提供方加载一个 blueprint skill，断言定义携带它而所有摘要都不携带。

本机 Windows 运行上三个包的 `src` 树均保持逐文件 100% 覆盖：tool-skill 230 语句 / 168 分支 / 37 函数，skill 313 / 199 / 65，evolution-skill-telemetry 92 / 53 / 33。（`skill-filesystem` 保留其已记录的 Windows 本地缺口，即 POSIX 符号链接分支；blueprint 投影那一行本身已有覆盖。）

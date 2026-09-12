# Agent Note: 技能门控与项目 skill 安全扫描

Status: implemented

[English](2026-09-12-skill-gating-and-project-scan.md) | 中文

## Problem

`specs/improvement.spec.md` 第 3 阶段点出了本地 skill 提供方缺失的四半，而它们共用同一个接缝——发现流程在解析出一个 skill 之后、它成为候选项之前做了什么：

- [frontmatter 白名单 Agent Note](2026-09-12-skill-frontmatter-allowlist.zh.md) 止步于 `required_env` 与 `config`，因此 `platforms`、`requires_tools`、`requires_toolsets`、`fallback_for_tools`、`fallback_for_toolsets` 与 `blueprint` 都被当作未知键警告，根本无法声明。
- 没有任何东西消费平台或工具要求，因此为其他操作系统编写的 skill、或需要组合从未挂载的工具的 skill，依然会进入模型目录。
- 项目 skill 未经检查即入库。信任已经决定了*哪个*项目根参与索引（见[项目信任 Agent Note](2026-09-11-skill-project-trust.zh.md)），但在受信仓库内部，一个附带「下载并交给 shell 执行」命令的 skill 与作者手写的 skill 受到同样对待。
- 注册表无从得知发现流程因安全原因丢弃了某个 skill，因此隔离永远只能是提供方内部的一条私有警告。

## Decision

### frontmatter 字段

`parseSkillText` 在既有键之外解析第 3 阶段冻结的字段集：`platforms`、`requires_tools`、`requires_toolsets`、`fallback_for_tools` 与 `fallback_for_toolsets` 是非空字符串组成的非空数组；`blueprint` 是映射，含非空字符串 `schedule`、取值为 `session` 或 `file` 的 `deliver`，以及非空字符串 `prompt`。六个键都进入白名单，属于已识别键而非未知键；畸形值仍会丢弃该键并警告一次，skill 照常加载，与既有的已识别键契约一致。非空字符串数组型键由同一张 `STRING_LIST_FRONTMATTER_FIELDS` 表解析，解析器与白名单都读它，因此新增一个列表型键不会出现「一处识别、另一处拒绝」。

`blueprint` 目前没有消费者：冻结形态是为计划中的 `/suggestions` 安装路径解析的，没有任何东西会自行调度。`requiredEnv` 与 `config` 随已加载定义（`FileSystemSkillProvider.get`）传递，那正是 `tool-skill` 消费的接缝。

### 门控

门控在 `discoverRoot` 中、解析成功与入列候选项之间运行，读取组合所挂载的 `ctx.get('tools')`：

- `platforms` 必须命中当前运行平台，与 `process.platform` 及其 agentskills.io 别名（`darwin`/`macos`、`win32`/`windows`）不区分大小写地比较。
- 每个 `requires_tools` 名称都必须在注册表中可解析，每个 `requires_toolsets` 名称都必须有已挂载工具带有该工具集前缀（`web` ← `web_search`）。DSH 没有工具集注册表，因此前缀约定就是全部定义。
- `fallback_for_tools` 或 `fallback_for_toolsets` 条目会在它所替代的工具或工具集**已挂载**期间隐藏该 skill。这一对是 skill 集合互换的方式：主 `requires_*` skill 随工具到来而出现、fallback 消失，工具离开时二者交换位置。

被门控排除的 skill 静默跳过——没有宿主警告，因为并没有出错——并且不会进入任何目录，因此也无法按名称加载。

### 项目 skill 扫描

`discoverRoot` 在候选项入列之前，扫描**项目自有**根（即携带 `projectRoot` 的根）下每个 skill 的原始文本。harness 自有的根——`custom`、用户与随包提供——未经扫描即索引：它们由 harness 写入或显式配置，而项目根是随仓库到来的。

四条词法规则会隔离文件：`pipe-to-shell`（`curl`/`wget` 管道给 shell）、`encoded-shell`（`base64` 解码结果管道给 shell）、`root-delete`（带递归与强制标志、目标为 `/`、`~` 或 `$HOME` 的 `rm`）、`credential-exfiltration`（在发起网络请求的同时读取凭据存储）。每条规则需要其全部模式命中，因此仅仅提及 `curl` 的 skill 不会被隔离。

隔离会跳过该 skill、在宿主日志记录命中的规则、为本次发现计数，并通过 `SkillProviderObservation.quarantinedCount` 返回；注册表汇总各提供方的计数，在 `skills/change` 载荷上报告总数。计数是宿主侧事实，永不进入模型目录。`FileSystemSkillProvider.get` 施加同一扫描，因此被显式指名的项目 skill 也无法加载其正文——调用方看到的仍是普通的「unknown or no longer available」结果。

判定结果按解析后的文件路径与宿主修改时间缓存在提供方实例中：未改动的文件不会重复扫描，被重写的文件则会。宿主无法 stat 的路径——远端工作区的后端路径——不做缓存即扫描。

## Consequences

skill 声明自己适用于何处，目录也反映运行中的组合，而不是磁盘上的每个文件。主 skill 与 `fallback_for_*` skill 之间的互换，就是「要求被读取而非仅被存储」的可观察证据：挂载该工具会把 fallback 移出目录、把主 skill 移入。

隔离是一种刻意控制影响面的安全姿态。它把 skill 从所有目录与按名加载中移除，但它是词法的，只读取 `SKILL.md`：bundle 的 `references`、`scripts` 等资源不在扫描范围内，经过混淆的载荷可以绕过。它是保守的第一道过滤，不是沙箱。

判定缓存存活于进程内，因此新进程会重新扫描每个项目 skill；规范允许仅存活于单次列出的缓存，而持久化缓存需要自己的失效与文件格式契约。门控在发现时刻读取注册表，这意味着未挂载 `ctx.tools` 的组合会隐藏所有 `requires_*` skill 并提供所有 `fallback_for_*` skill——这是忘记挂载注册表的组合能收到的最响亮的降级信号。

## Verification

`tests/skill-filesystem.spec.ts` 覆盖已发布行为：门控键解析且零警告（含合法 `blueprint`），七种畸形 `blueprint` 形态各警告一次而 skill 仍加载，`platforms` 在异平台隐藏 skill（两个方向都固定 `process.platform`，因此别名分支在任何宿主上都会执行），`requires_tools`/`requires_toolsets` 在注册表已挂载、部分挂载与缺席三种情形下隐藏 skill，主 skill 与 `fallback_for_tools` skill 随 `web_search` 的出现与消失互换，被隔离的项目 skill 不出现在目录中、警告指明规则、且 `skills/change` 携带 `quarantinedCount: 1`，加载路径拒绝同一 skill，按 mtime 建键的缓存在正文被改写而时间戳被恢复时复用判定、时间戳变动后重新扫描，宿主不可见路径仍然扫描，harness 自有根不经扫描，四条规则各自命中其模式而不命中裸 `curl`，本地根在重名时胜过 `bundled`，受信项目根索引而不受信根不索引。既有 `required_env`/`config` 用例同时断言已加载定义携带两者。

## Alternatives considered

**对 `fallback_for_*` 做降级排序而非隐藏。** 任务措辞是「排在它所替代的工具之下」，而 rank 在本注册表中是提供方重名时的次序判定，不是目录顺序——注册表按名称排序摘要，因此降级对任何消费方都不可见。所引研究记录明确指出：该工具集存在时 fallback skill 被隐藏；可见性互换才是可观察行为，因此门控直接丢弃候选项。

**在注册表或 `tool-skill` 中做门控。** 否决：`SkillSummary`/`SkillCandidate` 刻意保持调用中立，为提供方特有的门控字段拓宽它们会把字段推给每个消费方，而且消费方无法区分「未挂载」与「提供方没有意见」。发现事实归提供方所有。

**仅从目录而不断从 `get` 阻止被隔离的 skill。** 否决：目录排除已让该名称在正常流程中不可达，而把加载路径留着会让隔离变成建议性的——从过往会话得知的名称仍可加载该载荷。

**在 `<dshHome>/cache` 下做持久化扫描缓存。** 否决：它需要自己的文件格式、失效、损坏处理，以及一条「坏缓存条目拖垮发现」的失败路径；规范接受单次列出的缓存，而 mtime 键在进程内给出同样的复用。

**对畸形门控值直接拒绝。** 否决：它会把 frontmatter 拼写错误变成 skill 缺失或被错误门控，而该提供方对其他所有畸形但已识别的键都是警告后继续。

**更丰富的扫描规则（混淆、unicode 走私、PII）。** 否决：每增加一条启发式都会提高普通工程 skill 的误报率，而被隔离的 skill 对模型不可见，只有一条宿主日志可以解释。已发布的四条规则是审阅者能逐行辩护的规则。

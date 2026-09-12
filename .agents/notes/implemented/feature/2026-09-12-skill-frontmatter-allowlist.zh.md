# Agent Note: 技能 frontmatter 白名单

Status: implemented

[English](2026-09-12-skill-frontmatter-allowlist.md) | 中文

## Problem

`skill-filesystem` 解析 `name`、`description`、`whenToUse`、`metadata` 与调用布尔值，其余顶层 frontmatter 键一律静默忽略。作者把 `when_to_use` 拼错、或在从不读取该键的提供方上写 `required_env`，看到的都是一个照常加载、表现得像该键不存在的 skill——日志里没有任何解释。

`specs/improvement.spec.md` 第 3 阶段点名了修法：在 `ParsedSkill` 与解析入口上加白名单，在既有键之外识别 `required_env` 与 `config`，并对其他键发出警告。

## Decision

`parseSkillText` 额外识别两个键。`required_env` 是非空字符串组成的非空数组，落在 `ParsedSkill.requiredEnv`；`config` 是映射，其标量值以字符串形式保存，落在 `ParsedSkill.config`。其他任何顶层键各产生一次警告，指明该文件与该键。

已识别键的值畸形时警告一次并丢弃该键，skill 仍然加载。另一种做法——拒绝该 skill——会把可选字段里的拼写错误变成能力缺失，而该提供方既有的契约本就把无法解析的 frontmatter 当作「警告并跳过该文件」；已识别键值畸形比那更轻。

已识别集合是派生的，不是复制的：`RECOGNIZED_FRONTMATTER_KEYS` 展开 `invocationFrontmatterKeys()`（由 `parseInvocationPolicy` 用来拒绝旧拼写的同一张 `INVOCATION_FRONTMATTER_KEYS` 表构建），并展开 `STRING_LIST_FRONTMATTER_FIELDS` 中的列表型键——那张表正是解析器自身读取的表。新增一个调用键或一个列表型键都不会把白名单落在后面，警告路径也不会对解析器已经消费的键触发。

[门控与项目扫描 Agent Note](2026-09-12-skill-gating-and-project-scan.zh.md) 在该表上增加了 `platforms`、`requires_tools`、`requires_toolsets`、`fallback_for_tools` 与 `fallback_for_toolsets`，并加入 `blueprint`。

## Consequences

拼错或不支持的键现在会出现在宿主日志里，而不再静默失效。声明 `required_env` 或 `config` 的 skill 加载行为完全照旧：解析不带来任何目录条目、摘要、schema 或已加载内容的变化，因此模型会话里没有任何东西移动。

`required_env` 与 `config` 现在随已加载定义（`FileSystemSkillProvider.get`）一起传递，但自身没有取值来源：规范剩下的那一半——在加载时注入的 `skills.config` 映射，以及 `required_env` 的环境透传——需要一个规范本身未定义的部署侧来源，因此刻意不实现，而不是猜测。在它落地之前，解析与投影就是可观察契约。

## Verification

`tests/skill-filesystem.spec.ts` 按该文件既有的日志捕获模式：带合法 `required_env` + `config` 的 skill 加载且零警告，且其已加载定义同时携带两者；各种畸形形态（空数组、非字符串条目、空字符串条目、以标量代替数组；以字符串、null、列表、嵌套映射代替标量映射）各自恰好警告一次并指明文件与键，同时该 skill 仍进入目录；未知顶层键按键各警告一次；已识别的调用键不警告。按文件 100% 在 Linux 覆盖率通道上成立——那里三个符号链接用例会运行；在禁止符号链接（`EPERM`）的宿主上这些用例跳过，那也是本包覆盖率在本地唯一不达标的情形。

## Alternatives considered

**拒绝已识别键值畸形的 skill。** 否决：它把可选字段的拼写错误变成 skill 消失，而该提供方中没有任何其他解析失败会升格到这个程度。

**把值暴露进目录或已加载内容。** 目前否决：这会为一个没有消费者的字段改动模型可见载荷（及其快照），而注入契约尚未定义。

**再写一份已识别键的字面量列表。** 否决：调用键已有一张表，而一旦出现第三个调用键，两份列表立刻开始漂移。

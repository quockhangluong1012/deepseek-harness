---
description: "DeepSeek Harness 包工作区：packages/ 下的 npm 包如何分组、每个组负责什么，以及约束它们的约定。"
kind: "package-group"
---

# 包

[English](README.md) | 中文

## 概述

harness 由 `packages/` 下的 npm 包组装而成，按能力系列分组。把本页当作顶层地图使用：先找到拥有该能力的组，再打开其 README 查看包列表。每个包都以 `@deepseek-ai/dsh-*` 为作用域；每个组的 README 都是该能力系列的权威包映射。

## 目录

- [包分组](#package-groups)
- [发布预期](#release-expectations)
- [依赖](#dependencies)
- [包 README 约定](#package-readme-contracts)
- [开发备注](#dev-note)

-----

<a id="package-groups"></a>
## 包分组

每个包只属于一个组；新包加入现有组，新组则更新其自身 README 与本表。

| 组 | 职责 |
|---|---|
| [`core/`](core/README.zh.md) | 产品 API 主干与具体 agent loop |
| [`api/`](api/README.zh.md) | Remote BFF 装配与 Typert RPC 网关 |
| [`typert/`](typert/README.zh.md) | 类型图生成、产物加载与运行时注册表 |
| [`goal/`](goal/README.zh.md) | 同会话 goal 的持久化与生命周期 |
| [`schedule/`](schedule/README.zh.md) | 仅限会话内的定时后续操作 |
| [`feedback/`](feedback/README.zh.md) | 人类反馈的采集与命令 |
| [`identity/`](identity/README.zh.md) | 共享匿名身份 |
| [`llm/`](llm/README.zh.md) | LLM Service Definition 与提供方适配器 |
| [`subprocess/`](subprocess/README.zh.md) | 子进程 Service Definition 与本地进程树提供方 |
| [`ssh/`](ssh/README.zh.md) | POSIX 远端连接，配套文件系统／子进程／沙箱提供方 |
| [`shell/`](shell/README.zh.md) | Bash 执行器 seam、本地实现与面向模型的工具 |
| [`git/`](git/README.zh.md) | 面向模型的 git 工具：提交、分支、pull request、worktree |
| [`terminal/`](terminal/README.zh.md) | 限定所有者范围的持久 PTY 与面向模型的工具 |
| [`ptc-runtime/`](ptc-runtime/README.zh.md) | PTC Service Definition、沙箱 Node 提供方与 PTC mode Consumer |
| [`computer-use/`](computer-use/README.zh.md) | 按名称独占注册桌面提供方 |
| [`browser-use/`](browser-use/README.zh.md) | 按名称独占注册浏览器提供方 |
| [`sandbox/`](sandbox/README.zh.md) | 进程限制 seam；bwrap、Landlock、Seatbelt 后端 |
| [`deliverables/`](deliverables/README.zh.md) | 轮次交付物：显式文件交付与记录的工作区改动 |
| [`fs/`](fs/README.zh.md) | 文件系统 seam、本地实现、面向模型的文件／发现工具 |
| [`lsp/`](lsp/README.zh.md) | LSP seam、通用 stdio 提供方与 `lsp` 工具 |
| [`skill/`](skill/README.zh.md) | skill 提供方注册表、本地提供方与面向模型的目录／loader |
| [`compaction/`](compaction/README.zh.md) | 压缩（compaction）Service Definition、基础提供方与命令 Consumer |
| [`context/`](context/README.zh.md) | 模型可见请求上下文：workspace 指令、时间与引用 |
| [`repo/`](repo/README.zh.md) | 有界、惰性构建的仓库索引：路径、符号与引用 |
| [`subagent/`](subagent/README.zh.md) | subagent 提供方注册表约定与面向模型的委托工具 |
| [`jobs/`](jobs/README.zh.md) | 后台任务运行时与面向模型的作业控制工具 |
| [`experimental/`](experimental/README.zh.md) | 预稳定原型，包含显式私有例外 |
| [`workflow/`](workflow/README.zh.md) | 工作流 seam 与引擎，以及 `workflow`／`ralph` 工具 |
| [`webhook/`](webhook/README.zh.md) | 已验证外部事件、受信规则与即发即弃 Workspace 会话 |
| [`web/`](web/README.zh.md) | Web seam、搜索／获取提供方与面向模型的 Web 工具 |
| [`document/`](document/README.zh.md) | 共享宿主 Office 到 PDF 转换 |
| [`attachment/`](attachment/README.zh.md) | 附件标识、校验与本地内容寻址存储 |
| [`spill/`](spill/README.zh.md) | spill 存储 seam、本地实现与工具结果 spill 策略 |
| [`todo/`](todo/README.zh.md) | 面向模型的 `todo_write` 工具 |
| [`plan/`](plan/README.zh.md) | Plan 协作状态，提供进入命令与经评审的退出 |
| [`preset/`](preset/README.zh.md) | 由 preset `cordis.yml` 按会话组装 agent |
| [`guard/`](guard/README.zh.md) | 重复调用提醒、执行截止时间、每轮上限与注入／凭据扫描 |
| [`runtime/`](runtime/README.zh.md) | agent kernel（持久任务契约与完成门禁）与 context compiler |
| [`verification/`](verification/README.zh.md) | 为 kernel 完成门禁提供命令式验证器 |
| [`research/`](research/README.zh.md) | 有序研究循环，分阶段状态持久化 |
| [`mentor/`](mentor/README.zh.md) | 持久学习者记录、误解引擎与教导／重评循环 |
| [`bundle/`](bundle/README.zh.md) | 可安装的 `dsh --profile` 补丁层 |
| [`extensions/`](extensions/README.zh.md) | agent 运行时自修改：实时插件检查与模型所写挂载 |
| [`mcp/`](mcp/README.zh.md) | 外部 Model Context Protocol 服务器接入为原生工具 |
| [`hooks/`](hooks/README.zh.md) | 钩子桥接与共享 Claude Code／Codex 协议库 |
| [`session/`](session/README.zh.md) | 持久会话数据平面：持久化、投影与基于日志的标题 |
| [`session-query/`](session-query/README.zh.md) | 会话检索：语料库、有界读取、血缘与 SQLite 全文搜索 |
| [`settings/`](settings/README.zh.md) | 用户设置 seam 与基于文件的提供方 |
| [`credentials/`](credentials/README.zh.md) | 凭据引用／记录、环境变量优先于 `.env` 的提供方与人工授权 |
| [`storage/`](storage/README.zh.md) | 非会话存储中枢，含后端与领域形式 |
| [`workspace/`](workspace/README.zh.md) | Workspace 实体 |
| [`evolution/`](evolution/README.zh.md) | 按作用域记忆记录、暂存写入、后台评审与技能治理 |
| [`sdk/`](sdk/README.zh.md) | 进程外 SDK：JSON-RPC 协议与 TypeScript 客户端／服务器 |
| [`acp/`](acp/README.zh.md) | 仅面向自动化的 Agent Client Protocol 服务器 |
| [`interaction/`](interaction/README.zh.md) | 批准／交互 seam、权限预设、命令与询问用户的工具 |
| [`boot/`](boot/README.zh.md) | 共享的 app bin 启动粘合层 |
| [`host/`](host/README.zh.md) | Web GUI 宿主服务、目录选择、应用启动与遥测 |
| [`client/`](client/README.zh.md) | Web GUI 浏览器半侧：shell、协议层、slot 与 `ui-*` 插件 |
| [`test-support/`](test-support/README.zh.md) | 测试基础设施（testkit、回放、Loader 冒烟测试） |
| [`runtime-diagnostics/`](runtime-diagnostics/README.zh.md) | 按包归属的不变式检查与报告 |
| [`util/`](util/README.zh.md) | 组间共享的低层零依赖工具 |

-----

<a id="release-expectations"></a>
## 发布预期

大多数组属于产品组，提供稳定 API。例外：`experimental/` 发布时不提供稳定性或支持承诺，`test-support/`、`runtime-diagnostics/` 与 `util/` 是兼容性预期较低的支持组。

-----

<a id="dependencies"></a>
## 依赖

依赖图由工具生成：[docs/module-graph.md](../docs/module-graph.zh.md)（`pnpm run gen-module-graph`，CI 中有新鲜度门禁）。

**扩展插件依赖 Service Definition，绝不依赖具体提供方。** `dsh-agent-loop` 可替换；UI、钩子和工具插件使用 `dsh-agent`。组合包可以依赖主干插件。能力在需要独立演进时分离 Service Definition／Service Provider／Consumer 角色；详见[能力 seam](../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)。

-----

<a id="package-readme-contracts"></a>
## 包 README 约定

每个包 README 都覆盖用途、配置、扩展点与[模型体验](../docs/cookbook/adding-a-package.zh.md#4-write-the-package-readme)，列入模型无关[省略允许清单](../scripts/verify-package-readme-model-experience.ts)的包除外。它还要包含 `## Known Limitations and Deferred Work`，或列入其[允许清单](../scripts/verify-package-readme-limitations.ts)。包约定——导出、服务访问、不变式、测试——见 [packages/AGENTS.md](AGENTS.md)。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

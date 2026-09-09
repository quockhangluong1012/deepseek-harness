# Agent Note: Harness audit remediation across CI signal, tool validation, approval, and sandbox parity

Status: implemented

[English](2026-09-09-harness-audit-remediation-signal-validation-approval-sandbox.md) | 中文

## Problem

2026 年 9 月的 harness 审计确认三个执行层已经失效：任何分支或合并请求都不运行 CI 流水线，翻译配对门禁已经变红，没有已发布的 bundle 能发出审批提示，所有变更型工具都绕过超时守卫，工具参数校验存在三个漏洞，四个沙箱后端推导出四组不同的可写集合。

## Decision

`.gitlab-ci.yml` 接纳合并请求与默认分支流水线，提供八个 lane 任务调用既有的 `check:ci:*` 脚本，并配置以 `pnpm-lock.yaml` 为键的 pnpm-store 缓存；`scripts/verify-ci-lane-coverage.ts` 断言每个必需 lane 都被调用且工作流接纳合并请求，并接入 `ci-static` 与 `hygiene`；`test:python` 与 `test:native-system` 在 `ci-consumers` 内运行，`scripts/verify-no-fixme.ts` 拒绝运行时源码中的 `FIXME` 标记，同时通过保留已发布的包名解决超时策略的更名标记。

工具参数根编译为闭合（`additionalProperties: false`），未声明的模型键以 `INVALID_ARGS` 失败；MCP 桥接按服务端 schema 校验参数并抛出 `ToolArgsError`，不再把畸形输入强制转为空对象；超时策略携带校验过的 `defaultTimeoutMs`（120000，在 `bundle/base` 中显式配置），未声明单工具预算时按有界而非无界处理。

`permission-presets` 拥有已发布的 `tools/pre-execute` 审批生产者：`requiresApproval` 对变更型工具、所有 `mcp__*` 桥接工具以及 `schedule_*`/`cordis_*` 前缀设门，观察型与用户交互工具原样放行，被设门集合可经 `approvalTools` 配置；沙箱提权拒绝均为带可路由代码的 `HarnessError`（`INVALID_ESCALATION_ARGS`、`SANDBOX_ESCALATION_NOT_WIDER`、`SANDBOX_ESCALATION_UNAVAILABLE`、`SANDBOX_ESCALATION_REJECTED`、`SANDBOX_ESCALATION_CANCELLED`）。

Shell 对等性提取共享辅助函数而非向外复制守卫：`assertStandingPolicy` 与 `resolveWorkdir` 位于 `dsh-sandbox`，服务 bash、pwsh 与两个 fs 系列；`throwToolAborted` 与 `startAbortGuardedBackground` 位于 `dsh-tools`，服务 bash、pwsh、terminal 与 subagent；`str_replace_editor` 复用 `dsh-tool-fs` 的 `FsSandboxController`，不再保留平行的 `MutationPolicy` 类，使下一次修复不会只落到某一个调用点，克隆检测也保持绿色。

沙箱后端均从 `writableRoots()` 归约：bwrap 绑定每个非临时根并挂载易失的 `/tmp`，Landlock 授予规范集合，UNC 工作区根直接抛错，`docs/subsystems/sandbox.md` 声明网络否定性保证（`read-only` 拒绝写入但不阻止外传），对等性测试锁定每种归约；`CLAUDE.md` 在同目录 `AGENTS.md` 存在时作为回退跳过，`AGENTS.md` 记录回退语义以及 `check:all`、`check:ci:*` 系列、`change-scope`、覆盖率排除范围与无密钥快照刷新路径，工具目录不再声称 pwsh 缺少沙箱控制。

## Alternatives considered

**逐个调用点复制一份加固守卫，而非提取共享辅助函数。** 已拒绝，因为第一次尝试正是这样做，克隆检测随即报告四个新增镜像；`dsh-sandbox` 与 `dsh-tools` 中的共享辅助函数加上唯一的 `FsSandboxController`，使未来的每次修复都只有一个归宿。

**新建审批策略包，而非扩展 permission-presets。** 已拒绝，因为 permission-presets 已挂载于 `bundle/base` 且同时掌握沙箱与审批开关；新建包需要脚手架、目录注册与 bundle 接线，才能实现同一个监听器。

**恢复已删除的 GitHub Actions 拓扑，而非 GitLab run-gates 通道。** 已拒绝，因为已删除的工作流编码了自建 runner 池与 Wine 承载的 Windows，而 GitLab 对其建模方式不同；平台无关的 `run-gates.ts` 清单才是持久的调用方。

**删除 `CLAUDE.md` 占位文件，而非回退跳过。** 已拒绝，因为在 Windows 检出上无法可移植地提交符号链接；无论占位文件之后是否删除，回退机制都能消除垃圾指令问题。

**按 FIXME 提示重命名超时策略包。** 已拒绝，因为该包名已发布并被已发布的 bundle 引用；更名以破坏所有消费者为代价，仅换来命名对称。

## Consequences

变更型调用在 `ask` 与 `never` 策略下都经审批并留下审计事件对，未声明的工具参数在 schema 层闭合失败，每个已注册工具都归约到有限期限，每个沙箱后端都从同一个辅助函数推导可写集合并对 UNC 大声失败。遗留后续工作：运行时枚举的工具清单、Agent Note 引用完整性门禁、增量文档门禁、每轮步数上限、提示模板激活期校验、指令读取总量上限、完整的 Windows 覆盖率矩阵、被审计提交调度路径的行为回填、已发布组合的审批证明测试，以及本次变更之前已变红的翻译配对记录。

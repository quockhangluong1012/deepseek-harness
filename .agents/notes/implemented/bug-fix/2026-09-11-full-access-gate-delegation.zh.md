# Agent Note: Full-access sessions bypass the permission approval gate

Status: implemented

[English](2026-09-11-full-access-gate-delegation.md) | 中文

## Problem

选择完全权限（Full access）预设（`danger-full-access`：沙箱 `danger-full-access` 加审批策略 `never`）后，所有受门控的变更型工具都在没有任何提示的情况下失败：`Error: the user rejected tool "write"`。调用链如下：

1. 自[2026-09-09 审计整改](2026-09-09-harness-audit-remediation-signal-validation-approval-sandbox.zh.md)起，`dsh-permission-presets` 注册了一个 `tools/pre-execute` 生产者，对 `DEFAULT_APPROVAL_TOOLS` 中的每个工具（`bash`、`pwsh`、`write`、`edit` 等）返回 `{kind: 'ask'}`。
2. 该预设把审批策略固定为 `never`，而 `ApprovalService` 会在任何应答者运行之前把每个 ask 确定性地决议为 `'rejected'`。
3. `dsh-tools` 把 `'rejected'` 映射为 `the user rejected tool "<name>"`。

于是，这个文档含义为"完全文件访问且无审批提示"的预设反而拒绝了所有文件写入。已用真实服务复现（完全权限会话、真实 `ApprovalService`、真实 gate、真实 `ToolRuntime`、一个 `write` 工具）：得到与用户可见完全一致的报错；同一写入在 `workspace-write` 下由应答者放行时可正常执行。

## Decision

当调用会话的有效沙箱模式为 `danger-full-access`（折叠后的 `sandbox/mode` 覆盖值，否则为执行器的组合默认值）时，gate 直接委托给 `next()` 而不再提问。完全权限会话已经拥有部署授予的不受限文件权限，gate 在此保护不了任何东西；提问只会触发 `never` 策略的确定性拒绝。无 agent 调用保留提问（没有可读会话时 fail closed），没有固定沙箱旋钮的会话回退到组合默认值。

`never` 的服务语义保持不变：在 `never` 下仍然发生的提问（沙箱提权提问、hook 提问）继续以 `'rejected'` 决议并保留审计事件对。顺带删除了已死的 `config.approvalTools ?? DEFAULT_APPROVAL_TOOLS` 回退：schema 早已为该列表提供默认值（与预设表 cast 同一先例），其不可达分支自审计起就一直没有覆盖。

## Alternatives considered

**仅在 `ask` 审批策略下提问（`never` 下跳过 gate）。** 已拒绝，因为这会让每个 `never` 会话（含受限会话）的变更型工具静默放行——削弱了无人值守与锁定部署所依赖的、经审计的 fail closed 属性，也与面向模型的 `never` 语句矛盾。

**把 `danger-full-access` 改配 `ask`。** 已拒绝，因为完全权限会在每次变更时弹窗，行为与 `workspace-write` 完全相同——违背该预设"无审批提示"的含义与其客户端文案。

**新增自动放行的审批策略。** 已拒绝，因为新策略值会穿过整个 seam（服务、文档、SDK 快照、ACP 桥、生成目录），而现有沙箱模式已经表达了这份权限。

## Consequences

完全权限恢复文档所述行为：无提示且受门控工具正常执行；`workspace-write` 与 `read-only` 行为不变（`ask` 下提示、`never` 下拒绝、无审批通道时拒绝）。代价是明确的：把 `danger-full-access` 沙箱与 `ask` 配对的自定义预设同样跳过 gate——决定 gate 是否提问的是沙箱模式，而非审批策略。提权与 hook 提问仍遵守审批策略。所属 spec 钉住了完全权限下委托、受限下提问、裸会话下提问与无 agent 下提问，包的行/分支/函数覆盖率均为 100%。审计中缺失的 shipped-profile 审批证明测试仍是后续工作。

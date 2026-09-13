# Agent Note: Evolution slash-menu picks claim input

Status: implemented

[English](2026-09-13-evolution-slash-menu-claims-input.md) | 中文

## Problem

在 slash menu 中选择 `/memory`、`/skills`、`/curator` 或 `/trajectory` 会清空草稿并在后台执行裸命令，composer 留空。这些 host descriptor 未声明 `input`，于是客户端决策表（`packages/client/ui-commands/src/client/service.ts`）走了 host-bare 分支：消费 trigger span，再 detached 执行。而这些治理命令的真正工作需要参数（`approve <id>`），菜单因此无法拼装它们——`/memory` 后的空格也不会 claim，只能全手打，多错一词就吃 usage 错误。

另外，`/skills` 的 usage 宣称支持 `diff <id>`，但 handler 对一切 diff 硬报错：暂存 payload 尚无声明形状，后台提案也未落地。

## Decision

四个带参数的 evolution 命令在 `packages/evolution/command-evolution/src/index.ts` 中声明 `input` hint：`memory` 为 `pending | approve <id> | reject <id>`，`skills` 为 `pending | approve <id>`，`curator` 为 `status | run | adopt <name> | purge | rollback | ledger | pin <name>`，`trajectory` 为 `[--out <path>] [--all]`。菜单选择改走现成的 claim 路径（`/memory ` 留在草稿），复用已测试的 `slash/input-begin-command` 管道——客户端零改动。`journey`、`refine`、`suggestions` 保持无 `input`：`journey` 裸调用有可用默认值，后两者不接受参数。

`SKILLS_USAGE` 删去 `diff <id>` 并删除已死的 `diff` 分支，`/skills diff <id>` 改报 usage，不再承诺未实现的功能。包 README 中英双语同步更新为当前 grammar。

## Alternatives considered

**改为客户端对一切菜单选择都 claim。** 无需动 host descriptor 也能修这一例——但要改写已有文档与测试锁定的决策表（裸 host 命令选中即执行），连带改变本应立即执行的命令。落选：对已测试契约打局部补丁。

**实现真正的 skill diff。** 需要尚不存在的暂存 payload 声明形状；后台提案未落地。落选：为 store 渲染不了的东西做超前 surface。

## Consequences

这四个命令的裸回车改为向草稿 claim `/name ` 而非立即执行（再按一次回车才执行）——与既有 `/plan` 行为一致。它们同时按既有 `hint === undefined` 过滤退出行内（mid-text）菜单；行首菜单不受影响。附件继续大声拒绝，无变化：没有任何 handler 接受过附件。收益：approve/reject 流程可从菜单拼装，usage 文本不再宣称已死的动词。

## Testing

`packages/evolution/command-evolution` 用例以 descriptor `toContainEqual` 断言四个 `input` hint，断言新的 skills usage 文本（含 `/skills diff abc` → usage），覆盖 pending/approve/reject 路径：85/85 通过。该包作用域内 `tsc --noEmit` 干净。完整 `lint` 与 CI lanes 交由 CI。

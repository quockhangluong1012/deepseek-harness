# Agent Note: P0-session fixes batch 4

Status: implemented

[English](2026-09-13-p0-session-batch-4.md) | 中文

## Problem

`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md` 记录的全量扫描评审在 session 相关面提出了若干 finding，该扫描的批次 4（日期 2026-09-13）对其逐一处置。八个 finding 作为代码变更落地，三个按 Alternatives considered 中记录的理由驳回，此外本批次还撞上若干既有失败，并证明它们与自身改动无关（见 Known gaps）。

## Decision

八个 finding 作为代码变更落地：

1. `session-persistence-jsonl/src/index.ts`：`readGenerationHeader` 在列目录跳过无法解析的首行时发出 warn（只带 path，绝不含 header 内容）；跳过行为为可用性而保留。新增测试 `warns when listing skips an unparsable generation header`（修复前失败，warn 调用为 0；修复后通过）。
2. `session-persistence-jsonl/src/storage.ts`：`enqueueChain` 的 catch 被记录（只吞掉链环本身；调用方仍通过 `next` 观测到）。仅注释。
3. `session-query/cold-read.ts`：成功路径的 `handle.close()` 与错误路径同样包裹，close 失败不再掩盖有效的读取数据。
4. `plan-mode/src/index.ts`：`/plan off` 的 switch 针对绑定结果获得穷尽的 `default: assertNever(exit, ...)`（不再有重复 `set()` 调用），并使用共享的 `@deepseek-ai/dsh-util-values` 导入及其 `dependencies` 与 `tsconfig` reference。`tsc` 的收窄即穷尽性证明。
5. `agent-loop/src/index.ts`（4 处）与 `tool-calls.ts`（2 处）：未命名的 rollback/drain 吞掉行为按该文件自身的惯用法记录。仅注释；drain 吞掉分析表明 `committed` 只在结果全部追加完成之后推进，因此不存在重复结果风险。
6. `spill-local/src/store.ts`：`saveTextFile` 在 `EEXIST` 时重新生成随机名，尝试次数有界（10），并用尽时抛出响亮的冲突错误；`path` 移入循环内部。新增 fs-mock 测试装置（`vi.mock` 加 hoisted injector，沿用 `jsonl.spec.ts` 先例），覆盖重试成功与次数用尽两种情形（二者修复前均失败）。
7. `session-query/observation.ts`：构造函数在 capacity 不是正安全整数时 fail loud（`SESSION_QUERY_INVALID_CONFIG`），而不是静默装入一个退化 cache；新增 4 例测试（修复前失败）。
8. `user-approval/src/index.ts`：`overrideOf` 保留按 session 的仅追加扫描游标（`WeakMap`，floor 加截断防护）——每条日志事件在多次 ask 之间最多只被检查一次，取代每次工具调用做一次完整 O(n) 重扫。测试锁定 98 条追加事件对应 98 次读取（修复前为 99）。`hasOpenTurn` 有意不动（其规模受 turn 长度约束）。

## Alternatives considered

**把已 dispose 的 fire-and-forget 清理也 drain 掉。** 已证伪：`close()` 是幂等的（`this.closing ??=`，storage.ts:224），且 `releaseHandle` 在结算前于其内部运行，因此 teardown effect 的 openHandles 快照总能到达同一个在途 promise——否则就没有东西需要 drain。不存在孤儿路径；已对照 `emitDisposed`（同步分发，core/session/src/index.ts:1121）与保持绿色的 live-write 契约测试验证。

**在调用点校验 timeout-policy 默认值。** 已符合约定：配置层默认值在 `apply` 处解析并校验（index.ts:76-79），而每次调用的 `??` 就是已记录的两级默认（工具声明值覆盖插件默认值，JSDoc 67-70），由插件显式持有。

**把 session-query 基类的 `Config` schema 换成单一的 zod schema。** 属已接受的设计：抽象基类手动校验，以抛出带类型的 `SESSION_QUERY_INVALID_CONFIG` 分类（zod schema 会抛通用错误），而具体的 `session-query-sqlite` 实现本身已持有 zod schema。

## Consequences

无法解析的 generation header 现在会以只带 path 的 warn 显形，而列目录仍为可用性跳过该行；冷读成功路径上的 close 失败也不再能掩盖有效的读取数据。jsonl 的 enqueue 链仍吞掉链环失败，调用方通过 `next` 观测，而 `/plan off` 现在对绑定结果做穷尽检查，不再依赖编译器的沉默。capacity 不是正安全整数时以 `SESSION_QUERY_INVALID_CONFIG` fail loud，而不是装入退化 cache；`spill-local` 把随机名重试限制在 10 次并在用尽时抛出响亮的冲突错误；`user-approval` 每条日志事件在每次 session 中最多检查一次——这正是 98 条事件对应 98 次读取成立的原因——而 `hasOpenTurn` 仍受 turn 长度约束。Known gaps 中记录的三项失败原样结转，并非本批次造成。

## Known gaps

- plan-mode 3 个 PTC/SDK-bytes 失败：失败文本引用 `run_code` SDK 绑定（脏工作树里的 files-api 工作）；本批次的改动可证明行为中性（不可达分支加无副作用导入）。
- jsonl `fails a stale prepared publication`：把两个 jsonl 文件 stash 后失败完全相同（基线证明）。
- spill-local 3 个 symlink 测试：在 Windows 上创建 fixture symlink 时 `EPERM`（测试环境权限，本批次未触碰）。

## Verification

- jsonl.spec.ts：175 通过 + 新增 warn 测试（上方 1 项既有失败）。
- spill-local：40 通过（上方 3 项环境失败）；session-query 包：102 通过；approval：33 通过；plan-mode：66 通过（上方 3 项既有失败）。
- `tsc -b` 干净：agent-loop、session-query、spill-local、session-persistence-jsonl、plan-mode、user-approval。
- `pnpm install` 重新链接了 plan-mode 的新 workspace 依赖。

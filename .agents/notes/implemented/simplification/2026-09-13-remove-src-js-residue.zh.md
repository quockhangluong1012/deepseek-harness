# Agent Note: 移除被跟踪的 `src/**/*.js` 构建残留

Status: implemented

[English](2026-09-13-remove-src-js-residue.md) | 中文

## Problem

全量清扫修复的第 1 批（`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`）发现 `packages/*/src/` 下与其 TypeScript 原件并列提交了 145 个 JavaScript 文件，把源码平面与构建产物平面混在一起。每一个都是字节级的构建镜像：145 个文件全部有同名的 `.ts` 兄弟文件，且没有任何 `src/*.ts` 文件导入相对 `.js` 说明符（仓库中仅有的 `.js` 导入指向 `lib/` 产物，或位于残留文件自身内部）。

## Decision

145 个残留文件已删除。编译器仍向 `lib/` 输出，因此删除不改变任何运行时行为。

`src/` 之外被跟踪的 8 个 `.js` 文件被有意保留：`experimental/webworker-packer/bin.js`（声明的 `bin` 入口）以及 `tests/fixtures/plugins/` 下的 7 个纯 JS Cordis 插件（测试数据，而非残留）。宽泛的 `git ls-files` 匹配会命中 153 个文件；删除使用的是按 `*/src/` 过滤后恰好 145 个文件的清单。

## Alternatives considered

- **用宽泛的 `git ls-files` 删除所有被跟踪的 `.js` 文件（153 个路径）：** 已否决，因为其中 8 个路径并非残留——声明的 `bin` 入口与 7 个 Cordis 测试夹具插件——所以删除收窄为按 `*/src/` 过滤后恰好 145 个文件。
- **仅依赖 `.gitignore` 规则：** 已否决，因为 `.gitignore` 规则无法阻止被跟踪的文件；新门禁因此改为读取 `git ls-files`。

## Consequences

没有放弃任何东西：`lib/` 仍是构建产物平面，`src/` 之外的 `.js` 文件继续生效，运行时行为没有改变。

## Verification

- `verify-no-src-js`（新门禁）：在干净工作树上退出码为 0；强行暂存的探针文件会被标记，门禁以 1 退出（仅靠 `.gitignore` 规则无法阻止被跟踪文件，这正是门禁读取 `git ls-files` 的原因）。
- `pnpm run duplication`：不再有克隆对引用已删除的路径。
- 对 `llm/llm`、`attachment/attachment`、`shell/shell` 运行 `vitest`：重跑通过。最初 59 个文件的并行运行在 `llm-pi-ai`（本次变更未触及的包）出现 6 个超时类失败；这 5 个套件作为一组通过 153/153——属于负载下的抖动，不是回归。
- 完整 `pnpm run typecheck`（宿主 `tsc -b` + `tsdown` + 客户端 `tsc -b`）：通过。

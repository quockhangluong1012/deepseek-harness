# Agent Note: 工作区记忆卡片与对话框 UI

Status: implemented

[English](2026-09-13-workspace-memory-card-and-dialog-ui.md) | 中文

## 问题

Workspace 页面的「指令」与「记忆」卡片通过 `.preview` 渲染文档，其 `-webkit-line-clamp` 盒子即使存储的文档为空也会保留六行高度，在卡片中留下一条空白带。编辑与预览对话框使用共享 `Modal` 默认的 380px 卡片和不受约束的 `resize: vertical` textarea：一旦存在真实的指令或记忆文档，编辑器就会长到视口之外，被裁剪的对话框把保存／取消推出可达范围，用户拖动句柄还会进一步破坏卡片布局。

## 决策

空文档（或尚未加载完成的文档）渲染卡片本地化的空状态文案（`instructions.empty`、`memory.empty`），而不是空的 clamp 盒子；非空文档保留六行预览。

三个文本文档对话框（指令编辑、记忆编辑、记忆 Markdown 预览）向共享 `Modal` 传入 owner 本地的类名：`textDialog` 将卡片加宽至 `min(680px, 100%)` 并以 `calc(100dvh - 48px)` 封顶（附 `100vh` 回退），`textDialogContent` 使内容区域成为滚动容器（`min-height: 0; overflow-y: auto`），位于固定的 footer 之上，并按 ui-theme 的重绑定约定改用 l2 滚动条滑块色对。这些对话框内的编辑器在页面 `editor` 类之上追加 `dialogEditor`：`field-sizing: content` 且以 `50vh` 为下限、不提供手动缩放手柄——与反馈对话框的输入域处理方式一致。页面内的描述与上下文文本编辑器保持自身尺寸与 `resize: vertical`。

不更改 `ui-primitives` 的 `Modal`：该原语维持 figma 对话框几何，各 owner 通过既有的 `className`/`contentClassName` 席位覆盖，即 `RiskConfirmation` 使用的同一机制。

## 考虑过的替代方案

**把宽度／滚动规则移入共享 `Modal`。** 不予采用，因为 380px 卡片是设计中短表单对话框（重命名、创建工作区、确认框）的家族样式；让所有对话框变成可滚动的宽卡片会损害这些场景。

**只为非空文档渲染预览 clamp、不加空状态文案。** 不予采用，因为那样空文档的卡片在标题与底部之间什么都不显示，看起来像加载缺陷而非空状态；页面已为其他每个空区块提供了标签。

**在对话框内保留缩放手柄。** 不予采用，因为手柄允许编辑器增长到对话框裁剪盒之外，这正是破损布局的复现路径；增长交给 `field-sizing`，滚动交给内容区域。

## 后果

侧栏卡片始终说明自身的内容状态，长文档以可读宽度的对话框打开，其操作按钮保持可达。空状态文案键加入两个 locale 字典，文案仍归 locale 所有。在不支持 `field-sizing` 的引擎中，编辑器退化为 `50vh` 下限加内部滚动。

## 验证

[页面测试](../../../../packages/client/ui-workspace-memory/tests/page.client.spec.tsx)覆盖空文档的空状态标签、已加载文档的逐字预览，以及经渲染 DOM 检查的对话框卡片／内容／编辑器类名接线。`pnpm run test:gui` 运行它们；可见布局由浏览器回放负责。

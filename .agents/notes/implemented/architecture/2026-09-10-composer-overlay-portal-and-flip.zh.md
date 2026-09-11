# Agent Note: composer 浮层改为 portal 并按侧选择

Status: implemented

[English](2026-09-10-composer-overlay-portal-and-flip.md) | 中文

## Problem

composer 的两个浮动面板——触发菜单（`ui-input-trigger` 的 slash/`@` 候选）与命令弹层（`ui-commands` 的 popupSelect）——原先渲染在 composer 卡片*内部*的 `conversation.input.overlay` 挂载点，并用 CSS 相对该卡片定位：`position: absolute; bottom: calc(100% + 4px)`。`useAnchoredMaxHeight` 把设计上限压到面板与视口顶部之间的空间，因此它们始终向上生长。

中栏页面会让这两点同时失效。page layer 位于会话中栏之上——该栏被刻意 isolate，使页面的层叠只需一个 rank——因此就地绘制的面板一旦离开 composer 所在 band，就会被页面盖住；Workspace 页面的 composer 正处在页头下方，其下拉出现在页头之上并消失。而靠近视口顶部向上展开的面板几乎没有空间：clamp 会把它压成一条细缝。

## Decision

两个 composer 面板都 portal 到文档 body，并按卡片周围的可用空间选择展开侧。

- **portal 到 body。** 每个视图经 `createPortal(panel, document.body)` 渲染面板，因此面板不再位于被 isolate 的中栏内，任何页面都无法遮挡它。关闭逻辑随之调整：触发菜单改为检查 `anchorRef.current`（composer 卡片），而不再查找 `[data-composer-card]` 祖先——portal 后的面板没有该祖先。
- **锚点作为 owner prop 传入。** `conversation.input.overlay` 现在声明 `owner: ComposerOverlayOwnerProps`——即 `anchorRef`（composer 卡片）——由 `InputBar` 传入自身卡片 ref。面板相对该卡片定位，而不再相对零高度的挂载条——后者无法说明面板应落在哪里。
- **由一个钩子掌管落位。** `ui-primitives` 用 `useFloatingPanel` 取代 `useAnchoredMaxHeight`：它在锚点两侧中选择空间更大的一侧（只有上方空间更小时才向下），用 `left`/`width` 固定面板与卡片齐宽，向上时以底边锚定、向下时以顶边锚定，并把高度压到所选侧的空间。它会在调用方给的信号（store 状态）、滚动与 resize 时重新落位。
- **回退始终留在视口内。** 所选侧以 `data-side` 暴露，面板表面在 CSS 中保留设计上限；运行时 clamp 不会超过它。

## Alternatives considered

- **保留就地面板并加强 clamp。** 否决：面板只要落在 composer band 之外就会被 page layer 盖住，而上方面板没有任何空间可压。
- **把 composer 提到 page layer 之上。** 否决：这需要解除中栏的 isolate，并让 page layer 的 rank 高于会话自身的 z-index（其对话框高达 1100）——正是中栏页面席位刻意去除的脆弱性。
- **只量空间、不选侧。** 否决：这正是出问题的情形——一条细缝比展开在卡片下方更糟。
- **两个视图各自实现落位。** 否决：两个面板共享同一个锚点、间距、边距与上限，且本已共用 clamp 钩子。

## Consequences

下拉在任何 composer 位置都可用：上方有空间时向上展开，没有时向下展开，且永远不会藏在占用中栏的页面之后。portal 带来两项代价：面板不再位于 composer 子树内，因此任何从面板解析祖先的逻辑都必须经由 props 取得（见上面的关闭检查）；其几何从此是 fixed 定位计算而非流式布局——这正是 `useFloatingPanel` 存在的意义。

## Testing

`ui-input-trigger` 与 `ui-commands` 以打桩的锚点矩形渲染各自视图，断言所选侧、fixed 偏移、视口 clamp 以及 resize 后的重新落位；`apps/web/tests/workspace-memory-page.e2e.ts` 在真实页面上打开 composer 的命令菜单，断言它落在卡片下方、位于视口内，且不在页面自身的子树中。

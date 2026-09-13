# Agent Note: Workspace 页面 composer band

Status: implemented

[English](2026-09-10-workspace-page-composer-band.md) | 中文

> seat 的 `padding-top`（本条决策中停靠偏移的形状）本身已被[页面顶部内缩](2026-09-12-workspace-page-top-inset.zh.md)取代：band 之上的空间归页面所有。

## Problem

[常驻输入区决策](2026-09-10-workspace-page-live-composer.zh.md) 让 Workspace 页面使用会话的常驻 composer，而不是手写的 ask box；[中栏页面席位](2026-09-10-center-track-page-seat.zh.md) 又把该 composer 放在中栏底部：frame 的 page layer 在自身下边缘预留 seat 公布的高度，因此页面读作 名称与描述 → 产出 → 会话 → composer。

这并非该页面上 composer 应有的位置。该页面参照的项目页把唯一的编辑器当作首屏主体：先是名称与描述，然后是 composer，再是本 Workspace 的产出与会话/动态列表。停靠在底部还会丢掉输入卡的上边框：卡片的描边是向外绘制 0.5px 的 elevation hairline，而预留的 band 量的是 seat 的 border box——页面因此盖住了描边环的最上一行，卡片看起来没有封顶。

## Decision

占用中栏的页面自己拥有 composer band。

- **名称与描述行开启内容区。** Workspace 名称、其规范路径与描述构成页面内容列之上、与内容列同宽同边距、高度由内容决定的一行，因此读者先看到它们，再看到 composer band 与右栏；多余高度归下方内容列所有，页面不再有独立的页头条带，也没有属于自己的离开控件——离开由侧栏的会话与 Workspace 负责。右栏第一张卡片与 composer 同一行起始。
- **Hero 卡片就是页面的内容列。** 被页面占用时 seat 不再保留侧边留白，输入卡片与其上方的 preset chip 因此与下方产出、会话卡片左右边缘一致，整页读作一列。
- **页面留出 band。** `ui-workspace-memory` 渲染 名称与描述 → band → 可滚动 body。band 为 `height: var(--dsh-composer-height)`——即 `ui-conversation` 已经发布的 seat 实时高度——因此 body 从卡片下方开始，并随草稿增高而跟随。
- **页面发布 band box。** band 的顶部偏移及其相对主栏的左右内缩以 `--dsh-page-composer-top`、`--dsh-page-composer-left`、`--dsh-page-composer-right` 发布到 `document.documentElement`，即 `--dsh-composer-height` 已经在用的同一条通道：页面与会话只共享文档根元素。这些偏移以 body 的内容盒为基准测量，而该内容盒与对话滚动容器预留同一条滚动条槽，因此 seat 正好落在产出与会话列表所在的那一栏上。名称与描述行、主栏与页面自身的 `ResizeObserver` 会重新发布它们，因为描述会换行、右栏会折到主栏下方、frame 会改变尺寸。
- **seat 停靠进 band。** `.root[data-page-occupied] .composerSeat` 把发布的顶部与左右偏移作为自身外边距，并取 `margin-bottom: auto`，因此 seat 落在 band 内、宽度不超过主栏，而不再吸收中栏在底部的自由空间。
- **seat 自己容纳描边与顶部留白。** 同一条规则加上 `padding-top: 24px`：卡片与名称与描述行拉开距离，且卡片在自身盒外绘制的 0.5px 环位于 seat 内部，页面名称与描述行（或未来任何 band 边界）都无法再裁掉它。
- **band 保留 preset chip。** 页面 band 就是空白 Session Hero 的位置，因此 `ConversationRoot` 在那里、输入区之上渲染 `conversation.hero.agentPreset`——暂存下一个 Session 组合的 chip。Workspace picker 仍是 Hero 专属席位，因为页面在自己的名称与描述行里已标明 Workspace。
- **frame 的层不规定页面几何。** `.pageLayer` 去掉下边距，也不再对占用方强制 `pointer-events: auto`。页面只绘制名称与描述行与 body，让 band 保持透明、自身根节点可穿透，并把这两个绘制区域重新开启指针事件——这才使在下方绘制的 composer 能在 band 内接收点击。`shell.page` 的 JSDoc 为后续占用方写明这些义务。

## Alternatives considered

- **把输入区停靠在中栏顶部、并让层从顶部内缩。** 两条规则、无需测量。否决：页面自己的名称与描述行（Workspace 名称、路径、描述）会落到 composer 之下，而本页面遵循的布局是 名称与描述 → composer → body。
- **保留下边距，只调整页面各区块顺序。** 否决：composer 仍是页脚，而那正是要改的地方。
- **把 composer 渲染进页面。** slot key 只有一个声明者，页面永远无法渲染 `conversation.composer.bar`；在页面自有 key 下重新声明该 bar 及其七个子 hole，正是常驻输入区决策已经拒绝的代价。
- **改量名称与描述行的高度而不是 band 偏移。** 今天两者等价（其间没有任何元素），但 band 自身的偏移在日后上方插入内容时无需再增加一次测量。

## Consequences

页面读作 名称与描述 → composer → body，且 composer 保留全部席位——模型、权限、模式、附件、队列——因为它仍是驱动该 Workspace 空白 Session 的会话编辑器。

代价是第二次跨子树测量，以及更宽的 `shell.page` 契约：想要该 composer 的占用方必须留出 band、发布其顶部偏移、保持 band 透明，并为自身区域重新开启指针事件。不需要 composer 的占用方照旧绘制整个表面即可。band 是固定条带：页面的 body 在其下方滚动，composer 不随该滚动移动，这正是 seat 在任何滚动位置都与 band 对齐的原因。

## Testing

`apps/web/tests/workspace-memory-page.e2e.ts` 经真实 wire 打开页面，断言 seat 的盒子与页面的 `[data-page-band]` 齐平、位于产出区块之上、名称与描述行之下，且页面上没有 blank session 的 Hero chrome。`ui-conversation` 的占用中栏用例继续固定已收起的 Hero chrome 与仍然挂载的 seat；`ui-workspace-memory` 的页面用例覆盖名称与描述行、band 与 body 的渲染。

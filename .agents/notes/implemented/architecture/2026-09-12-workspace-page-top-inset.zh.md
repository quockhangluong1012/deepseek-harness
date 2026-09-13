# Agent Note: Workspace 页面顶部内缩

Status: implemented

[English](2026-09-12-workspace-page-top-inset.md) | 中文

## Problem

[composer band 决策](2026-09-10-workspace-page-composer-band.zh.md) 给停靠的 composer seat 加了 `padding-top: 24px`：让名称与描述行与输入卡片拉开距离，并让卡片在自身盒外绘制的 0.5px elevation 描边环留在 seat 盒内。在实际页面上，这段留白是描述与 preset 行之间条带的主要部分：名称与描述行本身已经在 band 之上留出 40px（其自身 16px 下留白加上页面 24px 的 gap），于是该留白把 composer 上方的空间翻倍，那条带读起来像页面上的空洞，而不像间距。

同一个页面自身没有任何顶部内缩。`.page` 从中栏轨道顶边开始，因此 Workspace 名称贴着 frame 顶边；frame 的页层不规定任何页面几何，名称与描述行之上也没有任何东西提供内缩。

## Decision

页面自己拥有顶部内缩，停靠的 seat 不保留任何留白。

- **内缩由 `.page` 承担。** `padding-top: 20px` 搭配 `box-sizing: border-box`。border-box 是必需的而非修饰性的：页面在页层内是 `height: 100%`，而页层按轨道高度裁剪，因此 content-box 会让页面比轨道高 20px，并裁掉 body 与右栏的底部。
- **停靠的 seat 去掉留白。** `.root[data-page-occupied] .composerSeat` 不再设置 `padding-top`。seat 盒子的顶部依旧与 `[data-page-band]` 齐平：页面发布的是 band 自身的 `offsetTop`，因此名称与描述行之上增加的内缩会同时把 band 与 seat 下移，页面读回的 band 高度仍是 seat 的准确高度。
- **卡片描边环不再预留边距。** band 条带在页面布局中是透明的，且 seat 的祖先在它的顶边没有裁剪盒，因此卡片在自身盒外绘制的 0.5px 环仍然可见；只要 preset 席位被填充——所有已发布组合都会填充它——band 的第一行就让卡片位于 seat 顶边之下 36px。

## Alternatives considered

- **保留该留白，去掉名称与描述行与内容列之间的 24px gap。** 否决：那条 gap 同时分隔名称与描述行与右栏的第一张卡片，而 seat 的留白从未影响右栏，因此右栏会上移而 composer 原地不动。
- **把内缩移到 `.introRow` 上。** 同样像素、少一个属性，也没有 `box-sizing` 问题。否决：页面的 frame 内缩会落在它的第一行而非页面本身，日后以别的行开头的页面必须重述一次。
- **在 seat 上保留一条描边高度的留白（1–2px）。** 否决：该条带是透明的，这么小的留白换不来任何裁剪保护，却仍留下一个页面 band 偏移必须携带的测量盒。

## Consequences

页面的第一笔绘制距轨道顶边 20px，composer 跟随 band。描述与 preset 行之间的条带就是页面自身的间距——名称与描述行的 16px 下留白加上页面 24px 的 gap，共 40px——而不再是该间距再加一层 seat 强加的留白。seat 的绘制盒减少了一个留白的高度，而这正是页面读回 band 所用的高度。

代价是描边环的显式预留：seat 在卡片之上不再保留边距，因此若有组合让 `conversation.hero.agentPreset` 空置、并在 band 顶边绘制不透明区域，就必须重新为描边环留出让位。

## Testing

`apps/web/tests/workspace-memory-page.e2e.ts` 经真实 wire 打开页面，并在 chromium 中测量盒子：名称与描述行的标题距页面盒顶为该内缩，seat 的盒子与 `[data-page-band]` 齐平，输入卡片位于产出区块之上，且 band 到卡片的距离只容纳 preset 行与堆栈 gap、不包含任何留白。

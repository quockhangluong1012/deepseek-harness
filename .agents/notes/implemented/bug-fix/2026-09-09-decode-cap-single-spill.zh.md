# Agent Note: 解码像素上限与单次 spill 搜索结果

Status: implemented

[English](2026-09-09-decode-cap-single-spill.md) | 中文

## Problem

图像准入在完整光栅解码前检查了头部尺寸，却没有给解码器本身设限：说谎的头部可以通过尺寸检查，然后在 `raw().toBuffer()` 中驱动无界像素放大。另外，`glob` 与 `grep` 已经 spill 各自设界、附分页指引的结果，而通用 spill 策略又把同一调用 spill 第二次，为一个超大结果写出重复产物。

## Decision

`detectImage` 把配置的 `maxPixels` 带入解码器自身的像素上限，使说谎的头部在解码中失败；解码器的像素上限拒绝映射为 `IMAGE_TOO_MANY_PIXELS`，而非通用的 `INVALID_IMAGE`。spill 策略的模型可见分支在 `read` 之外再跳过 `glob` 与 `grep`，把它们自带分页的 spill 结果作为唯一产物。

## Alternatives considered

**加长 spill 会话目录哈希。** 已拒绝，因为测试与启动扫描钉死了 `session-<12hex>` 形态；48 位目录随机数加 48 位文件随机数已使碰撞可忽略，改名只增加 churn，没有真实威胁模型。

**对未结算调用将会话不变式判失败，或按 session id 共享任务限额。** 已拒绝，因为现有测试钉死了两个约定：step 结束允许未结算调用以便修复闭包，限额按精确 owner 对象计算。

**发布默认遥测规则，或在工具调用输出上让压缩大声失败。** 已拒绝，因为遥测保持显式的无规则默认加可选辅助函数，而摘要器约定把工具调用留在 `rawOutput` 中只投影文本。

**现在就实现 SDK 线级取消。** 推迟为 proposed RFC：它需要协议方法、能力协商以及横跨两个 SDK 的版本偏差矩阵，不适合放在行为修复批量里。

## Consequences

说谎的图像头部以正确的像素上限码闭合失败，不再有内存放大的风险；搜索工具每次设界调用只产生一个 spill 产物；SDK 取消设计作为可评审提案等待。

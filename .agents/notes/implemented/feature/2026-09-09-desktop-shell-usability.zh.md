# Agent Note: 桌面壳可用性改进

Status: implemented

[English](2026-09-09-desktop-shell-usability.md) | 中文

## Problem

Electron 壳的应用菜单起初只有插件、检查更新和退出，聊天输入框没有编辑、视图与窗口菜单；插件窗口是唯一知晓更新的界面，却未暴露其 preload 已具备的更新能力。插件更新依赖阻塞式 `window.prompt`，缺失的 locale 键会导致整个渲染进程崩溃，开发构建显示可用的安装表单但只能失败，64 KB 的 pnpm 诊断原文直达状态栏。更新下载没有进度，开发构建检查更新误报“已是最新”，每次后端重启都只返回光秃的 `backend unavailable` 503。

## Decision

壳菜单由 `apps/desktop/src/main.ts` 构建：应用菜单保留仅打包可用的插件入口与更新检查，编辑（撤销到全选）、视图（重载、缩放、仅开发可见的开发者工具）与窗口（最小化、关闭）使用 Electron role 以保留平台原生文案，只有顶层菜单消费壳 locale 文案。插件管理器改为行内版本编辑并校验精确版本，移除前用 locale 文案确认，开发构建禁用表单并显示只读提示，缺失的 locale 键回退显示键名，事务冲突与截断后的 pnpm 首行错误分别映射为友好提示。同一窗口新增更新区，由既有更新 IPC 与新增 `updates-version` 通道驱动：显示当前版本、手动检查、有可用版本时安装，并通过 coordinator 的 `download-progress` 订阅实时显示下载百分比。后端缺席时的 `dsh-app://app` 请求返回带 `retry-after: 1` 与 locale 重启文案的 503，开发构建手动检查显示仅打包可用提示而非“已是最新”。

## Alternatives considered

**为桌面分叉一套聊天 UI。** 否决，因为 Desktop Host 已通过版本化管道传输组装匹配的客户端图；分叉将破坏打包说明中作为一个整体认定的版本身份。

**本轮返回更丰富的更新状态（渠道来源、字节数）。** 否决，因为源地址是打包时产物，字节总量只存在于进度事件中；状态先携带可选下载百分比，来源展示延后。

**从渲染进程排队或取消包事务。** 否决，因为项目管理器经由锁文件串行化且 pnpm 拥有子进程生命周期；渲染层仅把冲突映射为等待重试提示。

**经由壳协议处理器提供 Web 资源。** 否决，因为 `serveShellAsset` 只拥有壳渲染目录，Web 组合由已安装 Host 流式提供；MIME 表保持限定于壳资源。

## Consequences

聊天输入获得标准编辑、缩放与窗口能力且未在壳字典之外新增文案，插件窗口成为桌面插件与更新的统一自有界面。版本编辑不再阻塞事件循环，开发构建在调用 pnpm 前即可见失败，长下载有进度而非静默。本轮未触及离线种子、分片、签名与存储合并管线，其为下一轮工作。

## Testing

`desktop-menu.spec.ts` 锁定四个顶层菜单、role 成员、仅打包插件状态与仅开发开发者工具；`plugin-manager-ui.spec.ts` 锁定无 prompt、locale 键可解析与元素 id 存在；`update-coordinator.spec.ts` 新增无可用版本拒绝安装与下载进度发布。`verify-client-ui-i18n` 在重写后的渲染层通过，桌面包构建成功，`apps/desktop` 与 `apps/desktop-host` 全量套件通过。

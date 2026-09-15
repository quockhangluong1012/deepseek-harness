# Agent Note: P0 安全修复，第 6 批

Status: implemented

[English](2026-09-13-p0-security-batch-6.md) | 中文

## 问题

全量清扫修复的第 6 批（`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`）覆盖安全部分的发现项。其中三项是现网缺陷：hook protocol runner 中非正或非有限的 `timeoutSec` 会武装一个退化的 shell 超时；web-search 各提供方在 URL 内嵌凭据的情况下仍然表示为可用；ACP 图像准入在中途切换模型后仍信任 initialize 时点的标志。其余发现项或被证伪，或由刻意的信任边界固定，或记录为后续工作；另有一项收窄决策留待用户定夺。

## 决策

1. `hooks/hook-protocol/src/runner.ts`：非正/非有限的 `timeoutSec` 回退到 `defaultTimeoutMs`，而不再武装退化的 shell 超时（按 seam 规则在该操作处强制；bridge 会把线上值原样透传、不做校验）。新增 4 例测试。注意：hook 套件在 `vitest.config.ts` 中被排除于 Windows —— 新测试在 Linux 通道运行；本地 `tsc -b` 通过。
2. `web-search-{exa,perplexity,deepseek}` 提供方：可用性判定现在拒绝内嵌于 URL 的凭据（`username`/`password` 必须为空），同时仍接受纯 http（egress 测试替身在 `*.invalid` 与本地 mock 上需要它 —— 只允许 https 的规则会破坏这些用例）。每个提供方一个测试，全部由 `URL.canParse` 语义隐含地 fail-first；104/104 通过，egress 套件单独运行时为绿。
3. `acp/acp/src/session.ts`：当 prompt 携带图像块时，图像准入改为依据会话的 LIVE 模型选择重新解析（`imageEnabledForPrompt`），而不再在中途切换模型后信任 initialize 时点的标志。其余情况零额外开销（纯文本 prompt 不做重算）。这实现了已记录的 `2026-07-23-acp-automation-only-protocol` 方向（“prompt 准入重新检查实时路由”）；反方向早已由 `assertImageRoute` fail loud。新增 bridge 测试（修复前以 `not advertised` 失败）。

## 考虑过的替代方案

**为 bash 输出标记增加防伪造处理。** 改为以 nonce 分析接受现状：标记是每条命令 122 位的 UUID，标记会从面向模型的输出中剥除，持久 shell 的 `eval` 不会通过 `ps` 暴露标记，且 `lastIndexOf` 语义要求真实 END 标记之后出现 CURRENT nonce —— 远程 prompt 注入无法伪造。

**把 ACL 边界断言移入每个文件操作。** 改为固定在 setup 路径：两个断言都在供给（provisioning）时运行，而非每个文件操作运行，且 `path-boundary.spec.ts` 固定了它们的消息。

**让 config 不变式免于 ReDoS。** 改为认定为操作方信任面：config 作者拥有这台机器（可通过 config 挂载任意插件），该模式只编译一次，属于自伤且立刻可见。与之相对，`hooks.json`（随 clone 到达、不受信）则确实在上面做了加固。

**冻结 Typert loader manifest。** 改为认定为同信任边界：包改写自身 manifest 属于自我破坏，而冻结 zod 实例会有内部实现风险。`z.any()` 的产出已由 `typescript/no-explicit-any: error` 把关。

**在本地关闭 LSP TOCTOU 窗口。** 改为认定其经 seam 中介且已有记录：读取经由 `fs.resolve` / `contains` / `streamText`，残余风险已用 XXX 标注，且 for-await 的 `break` 会触发迭代器的 `return()`，因此不会泄漏 fd。

**用不透明 id 替换 remotes 的 `home` 字段。** 不是 P0 修复：`home` 是承重协议字段（loopback 检测、picker 默认值、固定的形状测试），改不透明 id 属于协议版本项目。

**收紧 vm 定时器、inspector 捕获、`.env` 优先级或凭据重载。** 改为接受为既定设计：vm/timer 的信任立场已有记录，inspector 是本地调试工具，继承的 env 按有记录的优先级胜出并记录层级，warn-and-keep 是与 settings-file 对称的刻意 fail-safe。

**重新加固 worker 消息处理。** 已经加固：先解析后接触、恶意对端规则、`Object.hasOwn` 原型防护，以及 ELU + 墙钟计时器。

**改动 schedule 下限、release 超时、preset 静默、patch 来源、启动期同步 FS、RPC 扫描或 method params。** 接受现状：该下限是纯领域数学中的滥用防护不变式、没有 Config 表面；该超时属于致命路径的时点；preset 默认值的静默有解析期 fail-loud 兜底；patch 来源只是调试用的表面问题；启动期读取是一次性的小文件冷启动；RPC 扫描是配以新鲜 dispatch 的 tiny-n；method params 使用经测试的 fail-loud 回退且不做压缩。

## 后果

非正或非有限的 hook 超时改为回退到已记录的 `defaultTimeoutMs`，而不再武装退化的 shell 超时；web-search 的可用性判定不再接受内嵌于 URL 的凭据，同时纯 http 的 egress 替身仍可工作；ACP 图像准入跟随实时路由，对纯文本 prompt 无额外开销。被接受的信任边界维持原状 —— 操作方提供的 config、同包内 manifest 改写，以及 `home` 这类协议字段 —— 而 sandbox `/tmp` 的问题留待用户而非单方面决定。

## 延后事项

- **Hook halt（`continue:false`）。** 架构性问题：正确的 halt 需要跨越两个 bridge 的 loop 级契约（cancel 与 suppress-wake 与 budget 之别），外加 `stop_hook_active` 的守卫语义，仓促映射有破坏自动化运行的风险。作者已加 TODO 标记；当前行为是记录日志。需要后续 spec，不是 P0 改动。
- **client/store JSON 缓存的版本化键。** 同源、自写的缓存；每 store 的 zod schema 是横切项目，且解析失败路径已有回退。记录留待以后。
- **bash 标记的 fd 分离状态。** 一项继续保持延后的加固方向。
- **Sandbox `/tmp` 收窄（需要用户决策）。** `workspace-write` 中共用 `/tmp` + `tmpdir()` 是刻意的，已有文档（`roots.ts:10-14`），并由测试做等价性固定；收窄为私有临时子目录会破坏 `/tmp` socket 互操作，以及 Seatbelt/bwrap/Landlock 上承诺的 mode 语义。选项：(a) 维持现状，(b) 在所有平台硬收窄（破坏性），(c) 提供 `sharedTmp` opt-in Config。若确实要做加固，建议 (c) —— 说一声即可安排为 batch 8。

## 验证

- hook-protocol `tsc -b` 干净（套件在 Linux 通道运行）。
- web search 各包：104/104 + egress 套件单独运行时为绿（并行 egress 争用是既有的测试隔离缺陷：两个套件都 patch 了全局 dispatcher —— 已记录，超出本次范围）。
- acp 图像子集 7/7，含新增的切换测试；`tsc -b acp` 干净。

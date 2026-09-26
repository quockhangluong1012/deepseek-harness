---
description: "verification 族的包索引：为 agent-kernel 完成门禁提供 pass、fail 与超时证据的命令式判据验证器，供希望让任务可验证的用户与维护者使用。"
kind: "package-group"
---

# verification/ — 验收判据验证族

[English](README.md) | 中文

## Summary

`verification/` 族回答一个 agent kernel 拒绝自行回答的问题：任务的验收判据究竟是否成立？kernel 拥有门禁与判据验证器注册表，但它不运行任何东西，因此没有任何插件认领的判据保持未解析。`command-verifiers` 裁决命令所能回答的族——每个判据 id 或族一条经 `ctx.shell` 运行的已配置 shell 命令，外加 `diff` 的改动范围检查。`agent-verifiers` 则以每条判据一个独立的审查者子代理裁决 `security`、`browser` 与 `review`。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | What it provides |
|---|---|
| [`command-verifiers/`](command-verifiers/README.zh.md) | 注册一个判据验证器：运行部署为某判据 id 或验证器族配置的 shell 命令，让超出所声明超时的判据失败，并根据任务改动的范围判定 `diff` 判据 |
| [`agent-verifiers/`](agent-verifiers/README.zh.md) | 注册一个判据验证器：由每条判据一个独立的审查者子代理裁决 `security`、`browser` 与 `review` 三族，子代理经由审查命令共用的审查者辅助函数启动 |

-----

<a id="related-documentation"></a>
## Related documentation

请先读这些验证器所服务的门禁，再读运行其命令的执行器与它们接受的配置。

- [Agent kernel 子系统参考](../../docs/subsystems/agent-kernel.zh.md) — 任务契约、完成门禁，以及对本族的贡献进行排序、超时与释放的 `CriterionVerifier` 注册表。
- [Shell 子系统参考](../../docs/subsystems/shell.zh.md) — 每条已配置命令所经过的执行器接缝，包括其截止时间、输出上限与溢出文件。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-command-verifiers) — 验证器插件接受的每个字段。

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

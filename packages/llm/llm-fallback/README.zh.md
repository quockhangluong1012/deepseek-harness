---
description: "Provider route fallback on the agent loop's request recovery extension point (ctx fallback recovery), for hosts surviving provider outages without operator intervention."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-fallback

[English](README.md) | 中文

## 概述

`dsh-llm-fallback` 在下游恢复拒绝一次失败时，把下一次模型请求切换到下一个健康的已配置路由，并先记录持久化 `llm/fallback` 事件。按路由的断路器让反复失败的路由休息到冷却结束；可选的、部署方拥有的密钥轮换钩子在切换前运行。切换搭乘循环每次尝试重发的 `agent/request` 替换契约，因此循环本身不变。当一个提供方故障不该终结回合时，选择本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

以轮换顺序挂载带恢复路由的插件。下游拒绝一次失败时，本包记录该路由的失败，跳过断开的断路器与刚失败的提供方，在安装了密钥轮换时运行它，追加 `llm/fallback`，为本步骤的下次尝试藏好路由，并回答 `{ kind: 'retry' }`。下游的重试决策永远保留，不被取代。中止与空路由表直接拒绝，不切换。

### 配置

恢复路由、断路器与合格码是可通过 `cordis.yml` 修改的、经过校验的 `Config` 成员。空路由表是有效的关闭态。密钥轮换不是配置：需要轮换后的密钥先于切换后的尝试生效时，在树挂载前提供 `ctx.llmFallbackKeyRotation`。

```yaml
- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    fallbackRoutes:
      - provider: 'other'
        model: 'other-model'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `fallbackRoutes` | `[]` | 按轮换顺序的恢复路由；为空时禁用回退 |
| `breaker.failureThreshold` | `3` | 断开一条路由所需的观测失败数 |
| `breaker.coolMs` | `60000` | 断开路由退出轮换的毫秒数 |
| `eligibleCodes` | 全部码 | 合格的失败码；省略接纳一切码 |

把回退行与 `llm-retry` 放在一起挂载。已发布的 web-app 行排在它之后（重试行由 base 层插入），而本包先委托下游，因此行顺序不改变 v1 结果；让未来的取代决策保持可能的，是「回退位于重试策略之外」这一 canonical 顺序。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-fallback)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

两个监听器、一个暂存、一个持久事件。`agent/request-error` 包装器永远先委托下游，因此 `llm-retry` 与压缩保留其决策；只有被拒绝的失败才进入回退求值。`agent/request` 覆盖为失败步骤的下次尝试提供暂存路由，其他请求原样通过，镜像模型选择的替换模式。切换时剥离继承的 reasoning effort，因为不同适配器可能拒绝上一路由的 effort 旋钮；其余由适配器默认逐次补齐。断路器状态是进程本地、按提供方键入；成功重置另行到来。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、监听器、暂存、断路器与密钥轮换接线 |
| [`src/types.ts`](src/types.ts) | 持久化 `llm/fallback` 事件载荷与会话事件声明 |
| [`src/brand.ts`](src/brand.ts) | 不透明回退链标识 |

### 失败与恢复

切换后的路由经由循环的持久化请求头延续到后续回合，直到另一次切换或选择变更；回退永不自动切回。抛错的下游监听器拒绝整个瀑布，而不是被切换掩盖。抛错的轮换钩子记警告后切换继续，因此轮换永不阻塞恢复。销毁移除两个监听器、清空暂存并排空在途恢复；过期的捕获回调直接返回而不恢复。

invariant 伴生尚未发布：`llm/fallback` 事件校验（开放回合/步骤、提供方匹配、单调 attempt、链标识）随排序与预算矩阵到来。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——本包实现的行为契约。
- [LLM 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-fallback)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

经由服务适配器间接呈现：本包在恢复时选择路由，而请求组装与适配器拥有模型可见的请求。

#### KV Cache 影响

路由切换改变请求前缀，因此提供方缓存复用在切换后的尝试上重启；不切换的回合不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本回退不适用的场景。它们是当前包约束。

- **不自动返回**——切换后的路由跨回合保持；主路由恢复时不会自动切回。
- **常开重试饿死回退**——无界重试策略下循环永不拒绝，回退永不介入；需要回退生效的地方请用有界普通策略。
- **共享尝试预算**——每次切换后的尝试消耗一次共享 `maxRequestRetries` 步骤；深路由表需要匹配的上确界。
- **进程本地断路器**——断路器状态随重启丢失，不跨 agent 协调；成功重置与跨会话断路器另行到来。
- **invariant 伴生尚未发布**——事件校验与排序/预算矩阵另行到来。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>

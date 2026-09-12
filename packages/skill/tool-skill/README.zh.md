---
description: "面向模型的 skill（技能）目录与加载工具，供希望了解 agent（智能体）看到的内容或配置会话 skill 目录的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

[English](README.md) | 中文

## 概述

agent 可以在会话期间发现并加载 skill。在首次请求前，如果存在模型可调用 skill 且 `skill` 工具可见，agent 会收到一份持久目录，列出可用 skill 的名称与有长度上限的描述，并可用 `skill` 工具加载完整指令。用户可以用 `/name` 调用某个用户可调用的 skill，把相同的指令注入该步骤。目录变更会追加一份完整替换，其中空目录会停用旧名称；可配置 `catalogDescriptionMaxLength` 来限制每条描述的长度。加载会先解析该 skill 的运行环境：声明的 `required_env` 名称从宿主环境透传，配置值取自部署的 `skills.config` 映射并覆盖 skill 自身默认值，内联 `${...}` shell 展开只对以 `metadata.shell` 选择加入的 skill 执行。

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

与 skill 注册表一起挂载该插件，即可让 agent 拥有会话 skill 目录和 `skill` 加载工具。它需要 `ctx.agents`、`ctx.tools` 与 `ctx.skills`。

### 何时选择

当 agent 应在会话期间发现并加载 skill 时使用它。当 skill 加载由其他消费方处理或完全不需要时，请跳过——没有它，提供方与注册表仍可工作，但不会有任何东西为模型渲染目录或工具。

### 挂载与配置

与 skill 注册表和至少一个提供方一起加载该插件；当有 skill 选择加入内联 shell 展开时，还要挂载 shell 执行器。配置限制目录中渲染的规范化描述长度，并提供部署侧的按 skill 配置值。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
  config:
    skills:
      config:
        deploy-skill: { region: eu-west-1 }
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `catalogDescriptionMaxLength` | `500` | 会话目录中渲染的规范化描述最大长度；最小为 3 |
| `skills.config` | `{}` | 加载时注入的按 skill 配置值，先按 skill 名再按配置键索引；已部署的值覆盖 skill 自身声明的默认值 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-skill)是每个受支持字段的穷尽式真源。

### 模型得到什么

- **会话目录。** 当存在模型可调用 skill 且 `skill` 工具可见时，agent 会在首次请求前收到一条持久的用户角色消息，列出每个 skill 的名称与有长度上限的描述；该消息告诉模型在着手任务前先用工具加载 skill，且绝不能仅凭摘要推断指令。
- **加载工具。** 模型以精确的 skill 名称调用 `skill`，并收到完整指令正文以及规范的 `<skill_content>` 块中的资源指引；该结果作为普通工具历史保留。在渲染前，加载器会先解析该 skill 的加载期环境——见[加载期环境](#load-time-environment)——再展开正文中的 `${DSH_SKILL_DIR}`（该 skill 自身目录）与 `${DSH_SESSION_ID}`（加载方 agent 的会话 id）；未被 skill 声明为配置的其他任何 `${...}` 序列都保持原样，除非该 skill 选择加入了内联 shell；没有值的变量——无 `path` 的虚拟 skill 的 `${DSH_SKILL_DIR}`，或无 agent 加载时的 `${DSH_SESSION_ID}`——也保持原样。
- **用户显式调用。** 直接用户输入中的 `/name` token 若指名某个用户可调用 skill，会把该 skill 的指令注入该步骤，而无需模型自行加载。在渲染注入内容前会应用同样的加载期解析与模板展开。
- **实时目录更新。** 后续成员关系、描述或可见性变化会追加完整的替换目录；删除全部 skill 时会追加空目录，停用较早的名称。

<a id="load-time-environment"></a>
### 加载期环境

加载会在正文送达模型之前解析该 skill 运行所需的环境。三项声明在此生效：

- **`required_env`。** 每个声明的名称都必须在宿主环境中已设置；其值会透传给该 skill 的执行命令。声明的名称未设置时加载失败并指名该名称——工具报告 `Error: skill "<name>" requires environment variable "<NAME>", which the host environment does not set`，用户显式调用则改为警告并在该步骤跳过该 skill。
- **`config`。** 声明的键是部署的 `skills.config.<skill>` 映射与该 skill 自身 frontmatter `config` 映射的并集。已部署的值优先于 skill 自身默认值，空白值视为缺席，两者都无值的已声明键同样令加载失败，并列出每个缺失的键。
- **内联 shell。** 仅当 skill 设置 `metadata.shell: true` 时，其余任何 `${...}` 序列才通过已挂载的 `ctx.shell` 执行器作为 shell 命令运行；命令在 skill 自身目录、以已解析的环境运行，输出上限为 4000 个字符，`metadata.shellTimeoutMs`（默认 `10000`，须为正数）限制每条命令。失败、超时、被中止或没有执行器的命令不向正文贡献任何内容，并在宿主日志中警告。同名时已声明的 `config` 键优先于 shell 命令。

### 可观察的成功与失败

加载列出的 skill 会返回其完整指令；无论加载来自工具还是用户的显式调用，模型看到的都是同一种规范形态。无效名称会报告 `Error: invalid skill name "<name>"`，未知名称会报告该 skill 未知或已不可用，被禁用模型调用的 skill 会报告其不可用于模型调用。声明的 `required_env` 或 `config` 无法解析的 skill 会报告上文的解释性加载错误，而不会带着解析不完整的环境加载。如果从未发布过目录，并且不存在模型可调用 skill，或 `skill` 工具被隐藏或遮蔽，则会整体省略目录；目录发布后，无论可见性丧失——`skill` 工具被隐藏或被同名作用域工具遮蔽——还是删除全部 skill，都会改为追加空目录来停用旧名称。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释目录与调用边界如何构建；可观察行为已在[使用本包](#use-this-package)和下方模型体验章节中完整说明。

### 设计理念

本包建立在两个想法之上。第一，目录是一种持久投影，按已发布条目的 digest 而非渲染后的正文做差异比较，因此 `<system-reminder>` 包装永远不会强制重新发布，消费方也不需要重新解析 `<available_skills>` 块。第二，一条规范渲染服务两条加载路径——工具结果与用户显式注入——经由共享自 `dsh-skill` 的 `renderSkillContent`，因此无论加载由谁发起，模型看到的都是同一种 `<skill_content>` 形态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、目录与手势 pre-step 监听器、渲染与 digest |
| [`src/load.ts`](src/load.ts) | 加载期环境：`required_env` 透传、`config` 解析与可选的内联 shell 展开 |
| [`src/template.ts`](src/template.ts) | 纯 `${DSH_SKILL_DIR}` / `${DSH_SESSION_ID}` 展开，供两条加载路径共享 |
| — | 不发布运行时不变式伴生入口；这个面向模型的适配器没有独立的生命周期流；执行关系由它调用的能力 seam 负责。 |

### 目录生命周期

在每次符合条件的 `agent/pre-step`，插件都会快照调用会话的 skill 目录，应用 `skill` 工具的精确可见性，过滤出模型可调用的 skill，并把条目 digest 与会话日志中最新可见的 `skill-catalog` 消息做比较。digest 变化时，它把包含完整替换目录的持久用户角色消息交给 `enter` 决策；空替换会显式停用较早的名称。提供方快照不完整时不发送任何内容，并为下一次 pre-step 保留最后一份可用视图。可见性检查针对本插件所注册的精确工具定义，因此作用域内同名的遮蔽项会同时移除 schema 及其指引；该插件既可全局挂载，也可挂在单个 agent 的组合内。

### 调用边界

`/name` 手势监听器只扫描已认领的用户消息：若某个以空白为界、指名工作区目录中用户可调用 skill 的 token 出现，则把同一份 `<skill_content>` 渲染作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后。未知名称与用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录与 `skill` 工具永不暴露这类 skill。

### 加载期展开

两条加载路径在 `renderSkillContent` 包装正文之前共享同一步解析与渲染（`src/load.ts`）。解析会从宿主环境透传每个 `required_env` 名称，按部署的 `skills.config.<skill>` 映射覆盖 skill 自身声明的默认值计算出配置值，并读取 `metadata.shell` 与 `metadata.shellTimeoutMs`；任何缺失的名称、缺失的值或畸形的 `metadata` 值都会变成解释性加载错误，而不是解析不完整的加载。工具抛出该错误，用户显式注入则警告并在该步骤跳过该 skill，因此配置错误的 skill 绝不会在缺少其所声明内容的情况下静默加载。

随后渲染会把 `${DSH_SKILL_DIR}` 展开为该 skill 自身目录（取 skill 绝对 `SKILL.md` 路径 `path` 的 dirname），把 `${DSH_SESSION_ID}` 展开为加载方 agent 的会话 id（工具中为 `exec.agent?.session.id`，pre-step 注入中为 `agent.session.id`）。其余每个 `${...}` 序列先解析为已声明的配置值；仅当 skill 设置了 `metadata.shell: true` 时，未声明的序列才通过已挂载的 `ctx.shell` 执行器作为 shell 命令运行——每个不同命令只运行一次，工作目录为 skill 目录，环境为已解析的环境。其他任何序列都保持原样，没有值的变量也保持原样：虚拟 skill 没有 `path`，因此 `${DSH_SKILL_DIR}` 不展开；没有加载方 agent 的工具调用会让 `${DSH_SESSION_ID}` 不展开。内联 shell 输出上限为 4000 个字符；失败、超时、被中止或未挂载 shell 的命令渲染为空并在宿主日志中警告，因此损坏的命令绝不会把其部分输出泄漏进模型的指令。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从目录背后的注册表词汇逐步进入精确工具 schema 与设计依据。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——目录背后的注册表与提供方词汇。
- [skill 包](../skill/README.zh.md)——注册表与共享的 `renderSkillContent` 渲染。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)——模型接收的精确 `skill` schema。
- [用户显式 skill 调用 Agent Note](../../../.agents/notes/archived/feature/2026-08-08-user-explicit-skill-invocation.md)——`/name` 手势设计。

-----

<a id="model-experience"></a>
## 模型体验

### 会话目录

#### 模型看到什么

如果存在模型可调用 skill，且可见的正是这个 `skill` 工具，agent 会在第一个请求之前收到下方目录模板，其中包含每个已排序 skill 的一条随数据而定的条目。该目录是一条持久的用户角色消息。后续成员关系、描述或可见性的变化会使用同一个 `<available_skills>` 信封追加完整替换；删除所有 skill 时，会追加一个空信封，并明确指示不得使用旧名称。模板的结尾一句是防止双重加载的规则：用户显式的手势边界（下文的 pre-step 监听器）会把同一份 `renderSkillContent` 输出（共享自 `@deepseek-ai/dsh-skill`）内联注入，目录则告诉模型遵循该块，而不是再经工具重新加载该 skill；替换目录模板的两个分支——包括清空后的目录——都携带同一条防双重加载规则。

##### Skill 目录模板

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

#### Token 影响

重复输入成本随 skill 数量和 `catalogDescriptionMaxLength` 增长；当列表为空或工具被隐藏或遮蔽时，不会发送初始目录 token。每次实际目录变更都会添加一条保留的完整替换消息。

#### KV Cache 影响

初始持久目录追加在现有可重用前缀之后。动态变更作为该目录之后的仅追加历史，因此较早的可重用 token 保持不变，每条新追加的目录和后续轮次都会形成新的后缀。新建或恢复的实例如果 digest 发生变化，可能会从新追加的目录位置起影响缓存重用。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`skill` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)。

#### Token 影响

工具可见时，每次请求都有固定的 schema token 开销。

#### KV Cache 影响

工具定义和可见性不变时，前缀稳定。遮蔽、限制或插件生命周期变更可能从该 schema 起使重用失效。

### 工具结果

#### 模型看到什么

成功调用使用下方结果模板，以及提供方管理的资源指引、目录资源指引、URL 资源指引或不透明资源指引。其中 `<provider-owned-instruction-body>` 是经过加载时模板展开后的 skill 正文：有值时替换 `${DSH_SKILL_DIR}` 与 `${DSH_SESSION_ID}`，其他任何 `${...}` 序列——包括无 `path` 的虚拟 skill 的 `${DSH_SKILL_DIR}`——都保持原样。

##### Skill 结果模板

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### 提供方管理的资源指引

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### 目录资源指引

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL 资源指引

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### 不透明资源指引

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token 影响

已加载指令是取决于数据的工具结果 token，并在后续步骤中重新发送，直到压缩；不会制作重复的 `agent.inject()` 副本。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到什么

无效或陈旧选择会精确返回 `Error: invalid skill name "<name>"`、`Error: skill "<name>" is unknown or no longer available` 或 `Error: skill "<name>" is not available for model invocation`。声明的 `required_env` 名称未设置、声明的配置键无值，或 `metadata.shell`/`metadata.shellTimeoutMs` 畸形的 skill 会返回一条 `Error: skill "<name>" requires …` 解释性错误并指名缺失内容。提供方抛出的查找文本取决于数据，并套用同一个 `Error: <message>` 包装层。

#### Token 影响

只有失败调用会添加这些已保留 token。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 用户显式调用注入

#### 模型看到什么

已认领用户消息中任意位置、以空白为界、指名工作区目录中某个用户可调用 skill 的 `/name` token，会把该 skill 的完整 `<skill_content>` 渲染（与上文结果模板完全相同的形态）作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后——背景在前，模型要着手处理的材料在最后。只扫描直接的用户输入，检查在已加载定义上进行，未知名称和用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录和 `skill` 工具永不暴露这类 skill；目录的结尾一句会告诉模型遵循注入块，而不是重新加载它。注入的正文携带与工具加载相同的加载时模板展开。

#### Token 影响

每次手势会把一份渲染后的 skill 正文作为注入上下文加进该轮次——尺寸与同一 skill 的工具结果相同，该成本会随用户请求必然产生，而非由模型自行决定。同一步骤内对同一 skill 的重复手势只注入一次。

#### KV Cache 影响

仅追加；注入落在该步骤的消息批次中、可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明目录或加载器何时不合适。它们是当前包约束，不是任务积压。

- **目录省略 `whenToUse`、来源和提供方元数据**——路由只基于名称和有长度上限的描述；`whenToUse` 仍是提供方元数据，加载后的包装层也不渲染它。
- **已加载指令正文没有大小上限**——提供方可返回足以占用大量下一步上下文的 skill；只有目录描述会被截断。
- **资源是指引，而非附件**——工具报告基础目录/URL/不透明提示，但既不列举也不为模型获取引用文件。
- **加载是一次性文本**——远程提供方缓慢或 skill 正文很大时，不提供部分内容、流式输出或缓存内容句柄。
- **目录替换采用全量列表**——一个名称或描述发生变化，就会追加所有可见摘要；这样能显式停用陈旧名称，但 token 成本与目录大小成正比。
- **正文不做版本化**——仅修改正文不会改变目录 digest，也不会通知模型；后续工具调用会读取提供方的当前内容，而先前工具结果仍是历史事实。
- **不可加载的 skill 仍留在目录中**——`required_env` 或 `config` 无法解析的 skill 仍会被展示；失败只在模型或用户尝试加载它时出现。
- **内联 shell 信任 skill 作者**——选择加入会把 `${...}` 序列当作命令在已挂载执行器的环境中运行，虽受字符上限与超时约束，但没有任何白名单；只有部署信任的 skill 才应出现在其发现根目录中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

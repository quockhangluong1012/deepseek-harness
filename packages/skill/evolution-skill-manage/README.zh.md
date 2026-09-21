---
description: "Model-facing skill_manage tool that creates, patches, edits, writes, removes, and deletes agent skills as files (ctx.tools), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-skill-manage

[English](README.md) | 中文

## 概述

`dsh-evolution-skill-manage` 发布面向模型的 `skill_manage` 工具：`create` 在配置的 `createDir` 新建技能，`patch` 替换一处恰好出现一次的子串，`edit` 在保留 frontmatter 的前提下重写技能正文，`write_file` 与 `remove_file` 维护附属文件，`delete` 删除整个技能。已有技能在目录发现它的位置原地变更；bundled 与 hub 技能只读，置顶阻止删除，但永不阻止补丁。写入立即落盘且无版本记录，回滚由你自己的版本控制负责。当模型应把持久技能当作文件整理、而不是守着一份冻结集合作答时，选择本包。

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

当模型应创建或修订技能时挂载本插件。技能名为小写短横线形式。`create` 需要路由 `description` 与指令 `content`，重名时拒绝。`patch` 需要恰好出现一次的 `old_text` 子串与其 `new_text`；未知、歧义与空子串都会大声拒绝。`edit` 需要完整的替换 `content`，并保留已存 frontmatter 的名称与描述。`write_file` 与 `remove_file` 接受技能相对 `path`：绝对路径、逃出技能目录的穿越与空路径均被拒绝，`SKILL.md` 保留给正文操作。`delete` 删除技能目录，除非遥测报告该技能已被置顶。随包附带与 hub 技能拒绝一切变更；没有本地目录的技能对管理操作而言视为未知。

### 配置

`createDir` 是唯一的部署选择：`create` 新建技能的位置。它支持 `~` 与 `${VAR}`/`$VAR`；省略时解析到画像技能目录。其余行为均为固定协议，不是配置。

```yaml
- name: '@deepseek-ai/dsh-evolution-skill-manage'
  config:
    createDir: '~/skills'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `createDir` | `$DSH_HOME/skills` | 新建技能的目录；`~` 与 `${VAR}`/`$VAR` 会展开，缺失变量时大声失败 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-skill-manage)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

本工具在执行器中、而非模式中强制执行操作集合：`op` 是普通字符串，未知值以 `unknown skill_manage op` 拒绝，因此直接执行也绕不开该决策。展示器保持回放安全，对过期的已记录参数回退到通用渲染而不是抛错。文件机制位于 `src/files.ts`，由纯助手加薄 `node:fs` 操作组成；frontmatter 按 `---` 围栏切分，技能文件经由 YAML 序列化重建，因此棘手的描述也能保持可解析。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`skill_manage` 工具、操作强制、展示器与遥测接线 |
| [`src/files.ts`](src/files.ts) | 目录展开、注册表解析、frontmatter 处理与唯一子串手术 |

### 失败与恢复

被拒绝的变更永不触碰文件系统。目录技能经由 `resolveSkillDir` 解析，它在一切读取之前拒绝随包与 hub 来源、无文件条目与不可写目标。变更经由 `ctx.get('evolutionSkillTelemetry')` 报告，因此遥测未挂载时工具照常工作；存储记录的修订正是该操作写出的文件文本，由存储自己求哈希，而不是再从磁盘读回。创建时的 `EEXIST` 冲突报告已存在路径；其余 I/O 失败向上传播。

不发布 invariant 伴生包，因为每个操作在单次流程中解析、检查并写入同一个文件系统位置，不存在可能分歧的两个独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——本包实现的行为契约。
- [skill 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-skill-manage)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型所见

`skill_manage` 工具，带一个 `op`（`create`、`patch`、`edit`、`write_file`、`remove_file` 或 `delete`）、短横线 `name`，以及该操作所需的字符串参数。每次调用解析为一行短文本，写明操作、技能与写入路径。

##### 该字段的原文（如需引用）

```markdown
skill_manage patch polish: /skills/polish/SKILL.md
```

#### Token 影响

随调用线性增长：每次变更一次工具调用，参数以上限为界的编辑内容为限。无辅助模型调用；本工具只做文件系统写入。

#### KV Cache 影响

每次调用一行短结果进入记录；本工具不改变任何提示前缀，因此除结果文本本身外不会使 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本工具不适用的场景。它们是当前包约束。

- **仅限本机**——技能位于本机的受管目录或目录路径之下，永不作为共享记录存在。
- **写入即时且无版本**——变更一次性落盘；回滚靠调用方的版本控制，不是本工具。
- **随包与 hub 技能在此只读**——本工具拒绝它们；由其所有者在别处整理。
- **新建永不就地落子**——新技能一律进入 `createDir`，即使别处存在同名目录技能；只有 `create` 使用配置的目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>

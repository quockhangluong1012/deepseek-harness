---
description: "对单个工作区根目录的有界、惰性构建的仓库索引：一次构建派生出的遍历树、声明符号、模块导入与符号引用，以及派生出的测试图、包/依赖图与配置图，还有缓存新鲜度规则与全部上限（ctx.repoIndex），供嵌入仓库事实的各包维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-repo-index

[English](README.md) | 中文

## 概述

`dsh-repo-index` 把单个工作区根目录变成一份有界快照：遍历得到的路径、声明行、每个模块说明符及其解析结果、声明之间的引用、覆盖某个文件的测试、树中声明的包及其依赖，以及每个插件声明与读取的配置。只要新鲜度摘要未变，`ensure()` 就只重新遍历目录元数据并返回缓存快照；`invalidate()` 强制重建。`maxFiles`、`maxFileBytes`、`maxSymbols`、`maxEdges` 与 `maxRoots` 限定一次构建。提取按行进行；任何未解析的关系都如实报告为未解析，而非猜测；此处不调用模型。

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

在需要仓库事实的消费方处挂载本插件：它注入 `fs`、注册 `ctx.repoIndex`，其缓存随挂载它的 fiber 一同销毁。

```ts
const snapshot = await ctx.repoIndex.ensure(workspaceRoot)
snapshot.symbols      // declaration lines, at most maxSymbols
snapshot.imports      // one edge per distinct specifier, with how it resolved
snapshot.references   // declaration-to-declaration name matches, at most maxEdges
snapshot.tests        // every test file and the files it covers
snapshot.packages     // every manifest and the dependencies it declares
snapshot.configs      // every configuration declaration and its fields
snapshot.configReads  // every configuration field a file reads
snapshot.stats        // { indexed, skippedLarge, capped }
ctx.repoIndex.invalidate()
```

`ensure(root, signal?)` 经 `ctx.fs` 解析根目录、遍历其目录并返回快照；同一次遍历摘要出相同 `fingerprint` 的根目录会返回同一个缓存快照，且不读取任何文件文本。`invalidate()` 丢弃全部缓存快照，因此下一次 `ensure()` 会重新遍历并读取。

### 配置

```yaml
- name: '@deepseek-ai/dsh-repo-index'
  config:
    maxFiles: 20000
    excludeDirs: [node_modules, .git, lib]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxFiles` | `10000` | 单次遍历返回的最大树条目数；达到该数量即停止并报告 `capped` |
| `maxFileBytes` | `262144` | 索引读取并从中派生事实的单个文件文本字节上限 |
| `maxSymbols` | `20000` | 索引中保留的声明符号上限 |
| `maxEdges` | `40000` | 索引中保留的符号引用与配置读取边上限 |
| `maxRoots` | `4` | 保留已构建快照的工作区根目录上限；最久未使用的根目录会被丢弃 |
| `excludeDirs` | `['node_modules', '.git', 'lib', 'dist', 'coverage', '.sessions']` | 遍历永不进入的目录基名 |
| `extensions` | `['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']` | 读取其文本的文件扩展名；开头的点可省略 |
| `testFileSuffixes` | `['.spec.', '.test.']` | 测试图中把一个路径判定为测试文件的文件名片段 |
| `testDirs` | `['tests', '__tests__']` | 测试图视为存放测试文件的目录基名 |
| `sourceDir` | `'src'` | 测试按路径约定覆盖源码时，测试目录映射到的目录基名 |
| `manifestNames` | `['package.json']` | 包图作为包清单读取其 JSON 文本的基名 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-repo-index)是每个受支持字段及其源声明的穷尽式真源。

### 派生图

四个成员报告消费方否则需要自行重新派生的关系，且每个成员都说明自己是怎样派生出来的，因此启发式结果绝不会被当作已解析事实呈现。

- **测试图。** 每个已索引测试文件对应一个 `tests` 节点。`covers` 中每个被覆盖文件一条：`via: 'import'` 是直接证据，因为该测试自身的导入解析到了该文件；`via: 'naming'` 仅凭路径约定——同名但去掉测试片段，或把 `tests`／`__tests__` 目录替换为 `sourceDir`。索引未持有其代码的测试报告 `covers: []`，而不是给出猜测。
- **包/依赖图。** 遍历返回的每个清单对应一个 `packages` 节点，按 `dependencies`、`devDependencies`、`peerDependencies`、`optionalDependencies` 顺序为每个声明的范围给出一条依赖边，`scope` 指明所属小节。`to` 是 `name` 与所声明依赖名相同的那个工作区包的清单路径；外部依赖没有 `to`。
- **配置图。** 绑定名以 `Config` 结尾的每个顶层 `const` 或 `interface` 对应一个 `configs` 节点，列出其块第一层的字段并标注 `derivedFrom: 'schema'` 或 `'interface'`。每个 `config.<field>` 或 `config['<field>']` 出现处给出一条 `configReads` 边，上限由 `maxEdges` 约束。
- **符号引用** 带有 `via`：当引用声明的块把该名字写作调用或构造时为 `'call'`，仅提及该名字（例如类型标注）时为 `'mention'`。

每条模块边都带有自己的 `resolution`。`indexed` 带 `to`；`workspace-package` 带裸说明符匹配到的包名——具体文件由索引不读取的清单 `exports` 映射决定；`external` 是没有任何已索引清单命名的裸说明符；`unresolved` 是没有命名任何已索引文件的相对说明符。

### 可观察行为与失败

非法配置会使插件加载失败：每个数值上限都必须是正的安全整数，`excludeDirs`、`testFileSuffixes`、`testDirs` 与 `manifestNames` 各自至少命名一个值，`sourceDir` 不得为空，`extensions` 至少命名一个扩展名且转小写后保持唯一。`maxFiles` 停止遍历，或 `maxSymbols`／`maxEdges` 截断图时，`stats.capped` 为 true；`stats.skippedLarge` 统计报告字节数或实际 UTF-8 字节长度超过 `maxFileBytes` 的文件。遍历之后消失、被拒绝访问或解码失败的文件会被排除在索引之外，而不是让整次构建失败；文本不是 JSON 对象的清单只会贡献一个不具名的包节点，同样不会让构建失败。信号会中止遍历及其已启动的读取。

后端对某条目报告不出过时令牌时，该条目只以自身大小计入新鲜度摘要，因此同大小的修改对 `ensure()` 不可见，直到调用方使索引失效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **事实来自行，而非解析器。** 声明、模块说明符、引用名字匹配与配置字段都按行匹配，因此索引没有解析器依赖，也没有需要持续跟进的语言专属解析。
- **先一次遍历，再对每个文件做一次有界读取。** 遍历只读取目录元数据、绝不读取文件文本；构建为符号、导入与配置读取每个可索引文件一次，再为声明头部引用块读取一次，并为包事实读取每个清单一次，且在每次读取前依据报告的字节数做出决定。
- **新鲜度是遍历的摘要。** 缓存键是解析后根目录的目标标识，值是快照；`ensure()` 比较快照的指纹，因此缓存命中只花费目录列举、不读取内容。
- **上限截断的是快照，而非进程。** 触及 `maxFiles`、`maxSymbols` 或 `maxEdges` 时，遍历或该轮处理停止并报告 `capped`，而不会加载整棵树。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`RepoIndex`、配置校验、根目录缓存与有界构建 |
| [`src/walk.ts`](src/walk.ts) | 有界目录遍历与新鲜度摘要 |
| [`src/extract.ts`](src/extract.ts) | 按行的声明、说明符、头部引用、配置声明与说明符解析 |
| [`src/graphs.ts`](src/graphs.ts) | 测试图、包/依赖图与配置图的派生 |
| [`src/types.ts`](src/types.ts) | 快照、图、符号、边与统计的词汇定义 |

### 主要流程

`ensure()` 调用 `walkRepository`：它解析根目录，按基名的码元顺序把每个目录至多列举一次，跳过被排除的基名与已访问过的目录目标，并在 `maxFiles` 处停止。遍历指纹命中缓存时直接返回已存快照；否则构建会在 `maxFileBytes` 之下为包事实读取每个清单，为声明、配置与排队的说明符读取每个可索引文件，然后针对已索引路径解析每个说明符——依次尝试说明符原样、其后缀变体与 `index.*` 形式，以及 `js` 系列扩展名背后的 TypeScript 源文件——并对裸说明符匹配已索引的包名。引用处理会重新读取每个已索引文件，把每个声明头部块中的标识符与同名已索引符号匹配，在块调用该名字时把该边标为调用，丢弃自指边，并在 `maxEdges` 处停止；测试图随后在同一批已索引路径上把已解析导入与路径约定结合起来。读取失败的文件会被跳过，因此单个不可读文件不会使构建失败。

### 无不变式配套模块

本包不发布运行时不变式配套模块，因为快照只是文件系统的有界投影，下一次 `ensure()` 会重新派生它：不存在独立存储的该状态副本可供不变式比对。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——遍历经 `ctx.fs` 读取的目标标识、目录元数据与过时令牌。
- [`dsh-repo-map`](../../context/repo-map/README.zh.md)——把快照按会话目标排序并注入紧凑地图的消费方。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-repo-index)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-repo-map`，每条模型可见的仓库地图都由本服务返回的快照渲染而来；索引自身不注册任何提示词、工具或会话事件。

#### KV Cache 影响

此处不进入任何模型请求，因此提供方的缓存复用不受影响；由该快照渲染出的地图的复用条件归属于 `dsh-repo-map`。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本索引何时不合适。它们是当前包约束。

- **按行事实，而非解析结果**——跨行书写的声明、计算得出的导入说明符、计算得出的配置键，以及字符串、注释或对象字面量中的标识符都不会被识别。需要真实类型图或调用图的消费方需要带解析器的工具。
- **引用是名字匹配**——`via` 说明引用块是把该名字写作调用（`'call'`）还是仅提及（`'mention'`），但两者都不解析作用域、重载、别名或类型，因此同名声明的每条各自成边，经由别名发起的调用则完全不成边。
- **裸说明符解析到包，而非文件**——`workspace-package` 命名匹配到的清单，因为入口文件由清单的 `exports` 映射决定而索引不读取它；tsconfig 路径别名或未匹配任何包名的说明符保持为 `external`。
- **测试—被测边可能只凭路径约定**——`via: 'naming'` 报告的被测文件是该测试从未导入的，因此被测文件改名后测试仍列出旧路径，而测试实际执行的同名不同文件则不会成边。
- **配置图只读取 `*Config` 绑定与 `config.` 读取**——通过解构后的局部变量读取配置的插件，以及在 YAML 或 JSON 中声明配置的仓库，都不贡献节点或边。
- **新鲜度取决于后端的过时令牌**——后端不上报令牌的条目只以大小计入，因此同大小的修改会一直对 `ensure()` 不可见，直到 `invalidate()`。
- **上限静默截断**——`capped` 只说明某一上限截断了结果，既不指出被丢弃的文件、符号或引用，`skippedLarge` 也只计数而不点名超限文件。
- **排除按任意深度的基名生效**——名为 `lib` 或 `dist` 的源码目录无论出现在树的何处都会被跳过，而非仅限根目录。
- **缓存按插件 fiber、按进程存在**——快照只存在于实例中且从不持久化，因此再次挂载或重启后会重新遍历并读取。
- **只索引整文件**——超过 `maxFileBytes` 的文件完全不贡献符号、导入、引用、测试或配置事实；索引没有部分读取文件的能力。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

遍历用码元序基名比较器对每份列举结果排序，使文件系统顺序不同的两台机器产生相同的 `entries` 序列；它还维护一个目标标识的 `visited` 集合，使把目录链接作为目录暴露的后端无法让遍历重访同一子树。摘要按条目对 `path`、`version` 与 `size` 做哈希，这正是没有过时令牌的后端只能检测大小变化的原因。

构建会检查 `maxFileBytes` 两次：一次在读取前针对报告的字节数，一次针对取回文本的 UTF-8 字节长度，因为后端报告的字节数可能与解码后的文本不一致。引用处理会重新读取文件而不再保留其文本，因此峰值内存只持有单个文件的文本，而非整棵树的文本。

</details>

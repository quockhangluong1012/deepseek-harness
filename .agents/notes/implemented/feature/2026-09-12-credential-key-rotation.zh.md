# Agent Note：凭据 seam 上的密钥轮换

Status: implemented

[English](2026-09-12-credential-key-rotation.md) | 中文

## 问题

`llm-fallback` 交付了一个部署方拥有的轮换钩子（`ctx.llmFallbackKeyRotation`），在路由切换前运行，但钩子没有任何办法真正轮换密钥。凭据 seam 可以按操作 `resolve` 一个引用、可以 `set` 一个新值，而正确的轮换是「读—决定—替换」：决定必须在与写入同一把锁内看到当下原样的值，否则两个进程轮换同一个密钥时会丢掉先写的那一个。在钩子里组合现有的 `resolve` 与 `set`，会让独占窗口在两次调用之间敞开。

## 决策

凭据 Service Definition 新增一个抽象的引用写入方法：

```ts
abstract rotate(ref: CredentialRef, mutate: (current: string | undefined) => string): Promise<void>
```

`rotate` 是 `modifyRecord` 在引用一侧的孪生：`mutate` 收到的是写入取得独占那一刻该引用解析出的值，其返回的非空值被持久化，提交在持久化写入之后恰好发布一次 `credentials/reference-updated`。该值只作为这个回调参数存在——seam 从不返回它，也绝不跨调用缓存它。加锁由提供方负责：`LocalCredentialProvider` 让 `rotate` 走与 `set`/`modifyRecord` 相同的操作链与跨进程写锁，先重读文档，并在渲染前准入结果，因此空白永远不会被持久化为已存储引用。

轮换策略仍由部署方拥有。下一个密钥从何而来——密钥池、保险库还是排期——是部署方的决定函数，经由 `llm-fallback` 已经交付的钩子到达（[无循环改动的 LLM 路由回退](2026-09-11-llm-fallback.zh.md)）；seam 只拥有受锁的「读—决定—替换」。部署方在该钩子内写 `await ctx.credentials.rotate(ref, current => nextKey(current))`。

被环境遮蔽的引用会被大声拒绝，条件与 `set`/`unset` 相同：继承的启动环境无法从进程内部修改，因此已提交的轮换会永远解析到那个遮蔽值——一次看似成功却毫无效果的写入，比一次失败的调用更糟。

## 备选方案

- **用 `resolve` 加 `set` 拼出的具体默认实现。** 否决：独占窗口会跨越两个操作，并发写入者可能在决定与写入之间插进来——正是 `rotate` 要防止的丢轮换 bug。
- **单独建一个密钥轮换服务，或在凭据包内交付 `llmFallbackKeyRotation` 实现。** 否决：seam 已经拥有引用写入路径及其事件，第二条写路径就得在既有语义旁另建一套锁与通知语义。
- **把被环境遮蔽的引用轮换进存储。** 否决：写入会提交，而下一次 `resolve` 仍返回启动环境的值，于是调用会报告成功却无可观测效果。用户得到的是指名 shell 变量的大声拒绝。
- **像 `modifyRecord` 那样允许 `mutate` 返回 `undefined` 表示放弃。** 否决：对这个原语而言，没有下一个密钥的轮换策略直接不调用 `rotate` 即可，返回值签名让回调的职责保持唯一明确。

## 后果

轮换钩子现在有了一个结果能作用于下一次请求的原语——无需重启，无需改配置。返回值回调让「空轮换」无从表达；无事可做的策略直接跳过调用。抽象方法对所有 `CredentialProvider` 子类都是破坏性变更，因此仓库内两个测试替身（credentials 与 authorization 的内存提供方）在同一次改动中实现它。`set`/`unset` 仍是调用方已持有某个值时的路径；`rotate` 是下一个值取决于当前值时的路径。

## 测试

七个用例锁定本地提供方：决定函数看到已存储值、以及为缺失引用写入首个值；`.env` 提供的引用被替换后，存储结果压过后备层；启动环境遮蔽引用时大声拒绝；空决定在写入任何内容前被拒绝；抛错的决定不提交任何内容、也不通知任何人；释放后拒绝轮换；drain 用例覆盖排队后释放的分支。另有两个用例锁定与 `llm-fallback` 钩子契约的组合：注册的钩子完成轮换、下一次 `resolve` 返回新密钥；策略抛错时拒绝且存储原封不动，使回退可以告警并继续切换。按文件 100% 在两个 `src` 树上成立。

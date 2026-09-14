# Agent Note：搜索结果获得有界、按世代加键的 TTL 缓存

Status: implemented

[English](2026-09-13-search-result-cache.md) | 中文

## 变更内容

`@deepseek-ai/dsh-session-query-sqlite` 增加了一个有界、带 TTL 的
`searchSessions`/`searchEvents` 页缓存（`src/result-cache.ts`，
`SessionResultCache`）。规范化查询、页码与语料世代都相同的重复请求会直接从内存作答，
而不重新运行 SQLite。两个新的 `Config` 字段——`resultCacheEntries`（默认 1000）与
`resultCacheTtlMs`（默认 3,600,000，即一小时）——像本包中其它每一个可调参数一样受约束：
用经过校验的 `Config` 字段约束，绝不硬编码常量。

## 为何规范中的机制只缺了一半

规范 §16.2 把两件事捆绑进一个 Python 类里描述：持久化索引被复用而非每次搜索都重建，
以及有界 TTL 的搜索结果缓存，二者由一个 `index_health` 状态机
（`healthy`/`dirty`/`rebuilding`）门控，决定是搜索当前索引、触发后台重建，还是阻塞等待重建。

前一半在本次变更之前已经是本包的设计。派生 SQLite 索引跨重启持久化，并增量对账：
`_reconcile` 把每个会话的持久化修订与已索引的行比较，只重新读取发生变化的部分，
在每次搜索的一个串行化事务内完成。它从不从零重建，因此不存在与 `index_health`
对应的东西——索引因构造方式而始终是最新的，而不是在惰性重建之后最终变新。
在这里加一个健康状态机，等于是在解决一个本包并不存在的陈旧性问题。

真正缺失的是第二半——缓存重复的相同搜索——这正是本次变更所添加的。

## 为何缓存键携带语料世代

引擎已经为每个语料维护一个单调递增的世代（整个语料 `searchSessions` 作用域用
`_globalGeneration`，单个会话的 `searchEvents` 作用域用 `target.generation`），
以便分页游标能检测到语料变化并以 `SESSION_QUERY_STALE_CURSOR` 失败，
而不是悄悄返回指向另一个语料的偏移量。

结果缓存把同一个世代当作其键的一部分复用：
`` `sessions|${fingerprint}|${generation}|${offset}|${limit}` `` 与
`` `events|${fingerprint}|${target.generation}|${offset}|${limit}` ``。
语料变化会递增世代，从而改变每一个受影响的键，因此在结构上不可能提供陈旧的页——
不存在可能被遗忘、或与并发写入产生竞态的失效步骤。另一种做法
（只按请求缓存，再在每次写入时显式清除条目）需要缓存知道每一条会修改语料的代码路径，
并且每一条都不能出错；按世代加键则让这整类 bug 变得无法表示。

## 边界

- `maxEntries`（LRU）：一旦 map 超出该边界，最久未被触碰的条目被淘汰。默认 1000，
  对应规范参考实现 `TTLCache(maxsize=1000)`。
- `ttlMs`：条目只在写入后的这么多毫秒内可以作答，无论世代是否变化。默认 3,600,000
  （一小时），对应规范参考实现 `ttl=3600`。
- `close()` 时缓存与它现在遮蔽的 SQLite 句柄一起被清空。

## 验证

- `tests/result-cache.spec.ts`：`SessionResultCache` 的纯单元测试（未命中、TTL 过期、
  LRU 淘汰、覆写、clear）；引擎级测试证明重复的相同搜索不会重新运行底层 SQLite 查询
  （用 `vi.spyOn` 监视私有的 `_querySessions`/`_queryEvents` 方法——TypeScript 的
  `private` 只在编译期起作用，因此这是在不引入生产测试钩子的前提下观察内部调用次数的
  合理方式），以及语料变化会立即体现，而不是提供一个早于该变化的页。
- `tests/sqlite.spec.ts`：在既有的 Cordis `Config` 校验测试中扩展了两个新字段的默认值、
  配置值与边界。
- 全包语句/分支/函数/行覆盖率 100%。

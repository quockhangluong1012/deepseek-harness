/**
 * `sidebarUsage` namespace dictionaries for the usage dashboard tab.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'sidebarUsage'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'type.label': '用量',
  'guide.title': '用量统计',
  'guide.description': '当前会话的实时 token 用量。',
  'action.open': '仪表盘',
  'overlay.title': '仪表盘',
  'overlay.close': '关闭仪表盘',
  'filter.label': '时间范围',
  'filter.today': '今天',
  'filter.7d': '近 7 天',
  'filter.30d': '近 30 天',
  'filter.all': '全部',
  'session.title': '当前会话',
  'session.requests': '请求',
  'session.input': '输入 token',
  'session.output': '输出 token',
  'session.cacheHit': '缓存命中',
  'cards.requests': '总请求',
  'cards.input': '输入 token',
  'cards.output': '输出 token',
  'cards.cacheHit': '缓存命中',
  'cards.cacheHitAvg': '平均缓存命中',
  'chart.title': 'Token 按天',
  'chart.input': '输入',
  'chart.output': '输出',
  'chart.noData': '暂无数据',
  'table.title': '模型用量',
  'table.model': '模型',
  'table.requests': '请求',
  'table.input': '输入 token',
  'table.output': '输出 token',
  'table.total': '总计',
  'table.cacheHit': '缓存命中',
  'table.empty': '暂无模型用量数据',
  'state.loading': '正在加载用量…',
  'state.failed': '用量加载失败：{message}',
  'state.retry': '重试',
} satisfies Record<string, string>

/** The usage-dashboard namespace key union. */
export type SidebarUsageKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'type.label': 'Usage',
  'guide.title': 'Usage stats',
  'guide.description': 'Live token usage for the current session.',
  'action.open': 'Dashboard',
  'overlay.title': 'Dashboard',
  'overlay.close': 'Close dashboard',
  'filter.label': 'Range',
  'filter.today': 'Today',
  'filter.7d': 'Last 7 days',
  'filter.30d': 'Last 30 days',
  'filter.all': 'All',
  'session.title': 'Current session',
  'session.requests': 'Requests',
  'session.input': 'Input tokens',
  'session.output': 'Output tokens',
  'session.cacheHit': 'Cache hit',
  'cards.requests': 'Total requests',
  'cards.input': 'Input tokens',
  'cards.output': 'Output tokens',
  'cards.cacheHit': 'Cache hits',
  'cards.cacheHitAvg': 'Avg cache hit',
  'chart.title': 'Tokens by day',
  'chart.input': 'Input',
  'chart.output': 'Output',
  'chart.noData': 'No data',
  'table.title': 'Usage by model',
  'table.model': 'Model',
  'table.requests': 'Requests',
  'table.input': 'Input tokens',
  'table.output': 'Output tokens',
  'table.total': 'Total',
  'table.cacheHit': 'Cache hit',
  'table.empty': 'No model usage yet',
  'state.loading': 'Loading usage…',
  'state.failed': 'Usage failed to load: {message}',
  'state.retry': 'Retry',
} satisfies Record<SidebarUsageKey, string>

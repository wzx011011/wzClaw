// ============================================================
// 中文翻译 — web-ui 使用的所有 key
// 分类：common / chat / session / settings / tool / connection
// ============================================================

const zhCN: Record<string, string> = {
  // ---- 通用 ----
  'common.loading': '加载中...',
  'common.confirm': '确认',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.save': '保存',
  'common.close': '关闭',
  'common.back': '返回',
  'common.retry': '重试',
  'common.error': '错误',
  'common.success': '成功',
  'common.search': '搜索',
  'common.noResults': '没有匹配的结果',
  'common.justNow': '刚刚',
  'common.minutesAgo': '{{count}} 分钟前',
  'common.hoursAgo': '{{count}} 小时前',
  'common.daysAgo': '{{count}} 天前',
  'common.monthsAgo': '{{count}} 个月前',
  'common.yearsAgo': '{{count}} 年前',
  'common.yesterday': '昨天',
  'common.today': '今天',
  'common.earlier': '更早',

  // ---- 聊天 ----
  'chat.title': 'wzxClaw',
  'chat.placeholder': '输入消息... (Enter 发送, Shift+Enter 换行)',
  'chat.send': '发送',
  'chat.stop': '停止生成',
  'chat.newSession': '新建会话',
  'chat.connected': '已连接',
  'chat.disconnected': '未连接',
  'chat.notConfigured': '未配置',
  'chat.empty.title': '开始新的对话',
  'chat.empty.hint': '输入消息开始聊天',
  'chat.error.sendFailed': '发送失败',
  'chat.error.connectionLost': '连接已断开',
  'chat.error.timeout': '请求超时',
  'chat.usage.inputTokens': '输入: {{count}} tokens',
  'chat.usage.outputTokens': '输出: {{count}} tokens',
  'chat.contextCompacted': '上下文已压缩: {{before}}k -> {{after}}k tokens',

  // ---- 会话 ----
  'session.list.title': '会话',
  'session.search.placeholder': '搜索会话...',
  'session.empty.title': '暂无会话',
  'session.empty.hint': '开始新的对话吧',
  'session.search.empty': '没有匹配的会话',
  'session.search.hint': '尝试其他关键词',
  'session.rename': '重命名',
  'session.rename.shortcut': 'F2',
  'session.delete': '删除',
  'session.delete.confirm': '确认删除？',
  'session.messageCount': '{{count}} 条消息',
  'session.newSession': '+ 新建会话',

  // ---- 设置 ----
  'settings.title': '设置',
  'settings.connection': '连接配置',
  'settings.connection.agentUrl': 'Agent Server 地址',
  'settings.connection.agentUrl.hint': 'WebSocket 连接地址，支持 ws:// 和 wss:// 协议',
  'settings.connection.token': '认证 Token',
  'settings.connection.token.hint': '用于连接认证，留空则不使用认证',
  'settings.connection.test': '测试连接',
  'settings.connection.testing': '测试中...',
  'settings.connection.testSuccess': '连接成功',
  'settings.connection.testFailed': '连接失败: {{error}}',
  'settings.connection.urlError': 'URL 必须以 ws:// 或 wss:// 开头',
  'settings.appearance': '外观',
  'settings.appearance.theme': '主题',
  'settings.appearance.theme.dark': '暗色',
  'settings.appearance.theme.light': '亮色',
  'settings.appearance.language': '语言',
  'settings.save': '保存设置',

  // ---- 工具 ----
  'tool.status.running': '运行中',
  'tool.status.completed': '已完成',
  'tool.status.error': '出错',
  'tool.showMore': '展开更多',
  'tool.showLess': '收起',
  'tool.copyCode': '复制代码',
  'tool.copied': '已复制',
  'tool.expand': '展开代码',
  'tool.collapse': '收起代码',
  'tool.progress': '正在执行...',
  'tool.workflow.running': '工作流运行中 ({{count}} 个工具)',
  'tool.workflow.completed': '工作流已完成 ({{count}} 个工具)',

  // ---- 连接 ----
  'connection.status.connected': '已连接',
  'connection.status.disconnected': '未连接',
  'connection.status.connecting': '连接中...',
  'connection.status.reconnecting': '重连中...',
  'connection.status.notConfigured': '未配置 Agent Server 地址',
  'connection.status.configure': '前往设置',

  // ---- 导航 ----
  'nav.settings': '设置',
  'nav.toggleSidebar': '切换侧边栏',
}

export default zhCN

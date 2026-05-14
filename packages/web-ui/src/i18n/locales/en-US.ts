// ============================================================
// English translations — all keys used by web-ui
// Categories: common / chat / session / settings / tool / connection
// ============================================================

const enUS: Record<string, string> = {
  // ---- Common ----
  'common.loading': 'Loading...',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.retry': 'Retry',
  'common.error': 'Error',
  'common.success': 'Success',
  'common.search': 'Search',
  'common.noResults': 'No matching results',
  'common.justNow': 'just now',
  'common.minutesAgo': '{{count}} min ago',
  'common.hoursAgo': '{{count}}h ago',
  'common.daysAgo': '{{count}}d ago',
  'common.monthsAgo': '{{count}}mo ago',
  'common.yearsAgo': '{{count}}y ago',
  'common.yesterday': 'Yesterday',
  'common.today': 'Today',
  'common.earlier': 'Earlier',

  // ---- Chat ----
  'chat.title': 'wzxClaw',
  'chat.placeholder': 'Type a message... (Enter to send, Shift+Enter for new line)',
  'chat.send': 'Send',
  'chat.stop': 'Stop',
  'chat.newSession': 'New Session',
  'chat.connected': 'Connected',
  'chat.disconnected': 'Disconnected',
  'chat.notConfigured': 'Not configured',
  'chat.empty.title': 'Start a new conversation',
  'chat.empty.hint': 'Type a message to start chatting',
  'chat.error.sendFailed': 'Failed to send',
  'chat.error.connectionLost': 'Connection lost',
  'chat.error.timeout': 'Request timeout',
  'chat.usage.inputTokens': 'Input: {{count}} tokens',
  'chat.usage.outputTokens': 'Output: {{count}} tokens',
  'chat.contextCompacted': 'Context compacted: {{before}}k -> {{after}}k tokens',

  // ---- Session ----
  'session.list.title': 'Sessions',
  'session.search.placeholder': 'Search sessions...',
  'session.empty.title': 'No sessions yet',
  'session.empty.hint': 'Start a new conversation',
  'session.search.empty': 'No matching sessions',
  'session.search.hint': 'Try different keywords',
  'session.rename': 'Rename',
  'session.rename.shortcut': 'F2',
  'session.delete': 'Delete',
  'session.delete.confirm': 'Confirm delete?',
  'session.messageCount': '{{count}} messages',
  'session.newSession': '+ New Session',

  // ---- Settings ----
  'settings.title': 'Settings',
  'settings.connection': 'Connection',
  'settings.connection.agentUrl': 'Agent Server URL',
  'settings.connection.agentUrl.hint': 'WebSocket URL, supports ws:// and wss:// protocols',
  'settings.connection.token': 'Auth Token',
  'settings.connection.token.hint': 'Token for authentication, leave empty to skip auth',
  'settings.connection.test': 'Test Connection',
  'settings.connection.testing': 'Testing...',
  'settings.connection.testSuccess': 'Connection successful',
  'settings.connection.testFailed': 'Connection failed: {{error}}',
  'settings.connection.urlError': 'URL must start with ws:// or wss://',
  'settings.appearance': 'Appearance',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.theme.dark': 'Dark',
  'settings.appearance.theme.light': 'Light',
  'settings.appearance.language': 'Language',
  'settings.save': 'Save Settings',

  // ---- Tool ----
  'tool.status.running': 'Running',
  'tool.status.completed': 'Completed',
  'tool.status.error': 'Error',
  'tool.showMore': 'Show more',
  'tool.showLess': 'Show less',
  'tool.copyCode': 'Copy code',
  'tool.copied': 'Copied',
  'tool.expand': 'Expand code',
  'tool.collapse': 'Collapse code',
  'tool.progress': 'Executing...',
  'tool.workflow.running': 'Workflow running ({{count}} tools)',
  'tool.workflow.completed': 'Workflow completed ({{count}} tools)',

  // ---- Connection ----
  'connection.status.connected': 'Connected',
  'connection.status.disconnected': 'Disconnected',
  'connection.status.connecting': 'Connecting...',
  'connection.status.reconnecting': 'Reconnecting...',
  'connection.status.notConfigured': 'Agent Server URL not configured',
  'connection.status.configure': 'Go to Settings',

  // ---- Navigation ----
  'nav.settings': 'Settings',
  'nav.toggleSidebar': 'Toggle sidebar',
}

export default enUS

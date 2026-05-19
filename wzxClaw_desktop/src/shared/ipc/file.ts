// File I/O IPC channels
export const FILE_CHANNELS = {
  'file:read': 'file:read',
  'file:save': 'file:save',
  // main → renderer push (file watcher event)
  'file:changed': 'file:changed',
  'file:read-content': 'file:read-content',
  'file:read-folder-tree': 'file:read-folder-tree',
  'file:rename': 'file:rename',
  'file:delete': 'file:delete',
  'file:create': 'file:create',
  // Diff apply
  'file:apply-hunk': 'file:apply-hunk',
  // File history / revert (session-scoped undo)
  'file:get-history': 'file:get-history',
  'file:revert': 'file:revert',
} as const

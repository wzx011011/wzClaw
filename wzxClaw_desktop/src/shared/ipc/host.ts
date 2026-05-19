// Host (remote SSH) IPC channels
export const HOST_CHANNELS = {
  // Host CRUD (renderer → main)
  'host:list': 'host:list',
  'host:get': 'host:get',
  'host:create': 'host:create',
  'host:update': 'host:update',
  'host:delete': 'host:delete',
  'host:test-connection': 'host:test-connection',
  // SSH execution
  'host:exec': 'host:exec',
  // Monitor / health (main → renderer push)
  'host:monitor': 'host:monitor',
  // SFTP operations
  'host:sftp:list': 'host:sftp:list',
  'host:sftp:download': 'host:sftp:download',
  'host:sftp:upload': 'host:sftp:upload',
  'host:sftp:read': 'host:sftp:read',
  'host:sftp:mkdir': 'host:sftp:mkdir',
  'host:sftp:delete': 'host:sftp:delete',
  // Docker management
  'host:docker:list': 'host:docker:list',
  'host:docker:logs': 'host:docker:logs',
  'host:docker:action': 'host:docker:action',
  'host:docker:stats': 'host:docker:stats',
  'host:docker:images': 'host:docker:images',
} as const

// Workspace IPC channels (folder + task workspaces)
export const WORKSPACE_CHANNELS = {
  // Folder/project management (renderer → main)
  'workspace:open_folder': 'workspace:open_folder',
  'workspace:set_folder': 'workspace:set_folder',
  'workspace:get_tree': 'workspace:get_tree',
  'workspace:watch': 'workspace:watch',
  'workspace:status': 'workspace:status',
  // Task workspace CRUD (renderer → main)
  'workspace:list': 'workspace:list',
  'workspace:get': 'workspace:get',
  'workspace:create': 'workspace:create',
  'workspace:update': 'workspace:update',
  'workspace:delete': 'workspace:delete',
  'workspace:add-project': 'workspace:add-project',
  'workspace:remove-project': 'workspace:remove-project',
} as const

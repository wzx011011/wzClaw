// Plugin system IPC channels
export const PLUGIN_CHANNELS = {
  'plugin:list': 'plugin:list',
  'plugin:get': 'plugin:get',
  'plugin:install': 'plugin:install',
  'plugin:uninstall': 'plugin:uninstall',
  'plugin:enable': 'plugin:enable',
  'plugin:disable': 'plugin:disable',
  'plugin:reload': 'plugin:reload',
  'plugin:get-skills': 'plugin:get-skills',
  'plugin:install-from-source': 'plugin:install-from-source',
  'plugin:get-output-styles': 'plugin:get-output-styles',
  'plugin:get-user-config': 'plugin:get-user-config',
  'plugin:set-user-config': 'plugin:set-user-config',
  'plugin:search_marketplace': 'plugin:search_marketplace',
} as const

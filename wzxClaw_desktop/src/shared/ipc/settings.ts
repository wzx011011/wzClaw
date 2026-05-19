// Settings + Session IPC channels
export const SETTINGS_CHANNELS = {
  'settings:get': 'settings:get',
  'settings:update': 'settings:update',
  // Session persistence (desktop-only, used by settingsManager)
  'session:save-last': 'session:save-last',
  'session:get-last': 'session:get-last',
} as const

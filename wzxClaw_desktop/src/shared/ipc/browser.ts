// Browser automation IPC channels
export const BROWSER_CHANNELS = {
  // renderer → main (control)
  'browser:navigate': 'browser:navigate',
  'browser:take_screenshot': 'browser:take_screenshot',
  'browser:close': 'browser:close',
  // main → renderer push (events)
  'browser:screenshot': 'browser:screenshot',
  'browser:status': 'browser:status',
} as const

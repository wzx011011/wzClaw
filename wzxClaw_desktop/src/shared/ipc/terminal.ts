// Terminal (PTY) IPC channels
export const TERMINAL_CHANNELS = {
  'terminal:create': 'terminal:create',
  'terminal:kill': 'terminal:kill',
  'terminal:input': 'terminal:input',
  'terminal:resize': 'terminal:resize',
  // main → renderer push (pty output)
  'terminal:data': 'terminal:data',
  // renderer → main (request buffered output)
  'terminal:output': 'terminal:output',
} as const

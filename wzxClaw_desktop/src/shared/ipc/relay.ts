// Relay (NAS WebSocket relay) IPC channels
export const RELAY_CHANNELS = {
  'relay:connect': 'relay:connect',
  'relay:disconnect': 'relay:disconnect',
  // main → renderer push (connection status change)
  'relay:status': 'relay:status',
  // renderer → main (request current status)
  'relay:get_status': 'relay:get_status',
  'relay:qrcode': 'relay:qrcode',
  // Data sync (main → renderer push for mobile sync)
  'data:changed': 'data:changed',
} as const

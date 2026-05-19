// Hand (remote tool executor) IPC channels
export const HAND_CHANNELS = {
  // main → renderer push (hand connection status)
  'hand:status': 'hand:status',
  // renderer → main (query / control)
  'hand:get_status': 'hand:get_status',
  'hand:reconnect': 'hand:reconnect',
  'hand:disconnect': 'hand:disconnect',
} as const

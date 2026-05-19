// Agent + AskUserQuestion IPC channels
export const AGENT_CHANNELS = {
  // Permission flow (main ↔ renderer)
  'agent:permission_request': 'agent:permission_request',
  'agent:permission_response': 'agent:permission_response',
  // Plan mode (main → renderer events + renderer → main decision)
  'agent:plan-mode-entered': 'agent:plan-mode-entered',
  'agent:plan-mode-exited': 'agent:plan-mode-exited',
  'agent:plan-decision': 'agent:plan-decision',
  'agent:toggle_plan_mode': 'agent:toggle_plan_mode',
  // AskUser interactive question (main → renderer push + renderer → main answer)
  'ask-user:question': 'ask-user:question',
  'ask-user:answer': 'ask-user:answer',
} as const

// ============================================================
// /debug — Debug session issues (adapted from Claude Code)
// Helps diagnose issues with the current wzxClaw session
// ============================================================

import { registerBundledSkill } from '../bundled-skills'

const DEFAULT_DEBUG_LINES = 30

export function registerDebugSkill(): void {
  registerBundledSkill({
    name: 'debug',
    description:
      'Enable debug logging for this session and help diagnose issues with wzxClaw',
    allowedTools: ['FileRead', 'Grep', 'Glob'],
    argumentHint: '[issue description]',
    disableModelInvocation: true,
    userInvocable: true,
    async getPrompt(args) {
      return `# Debug Skill

Help the user debug an issue they're encountering in wzxClaw.

## Debug Log Location

wzxClaw debug logs are stored in \`~/.wzxclaw/debug/\` directory.
Session logs follow the pattern \`<session-id>.txt\`.

## Issue Description

${args || 'The user did not describe a specific issue. Check the debug logs and summarize any errors, warnings, or notable issues.'}

## Instructions

1. Look for debug logs in \`~/.wzxclaw/debug/\` — list files and read the most recent one
2. Focus on [ERROR] and [WARN] entries, stack traces, and failure patterns
3. Check the project's .env file for missing or incorrect configuration
4. Check if the configured API key and model are valid
5. Look at the workspace settings in \`~/.wzxclaw/settings.json\`
6. Explain what you found in plain language
7. Suggest concrete fixes or next steps

## Common Issues

- **API errors**: Check API key validity, base URL, and model name
- **Permission errors**: Check file/directory permissions
- **Context too long**: Suggest using /compact to reduce context
- **Model not found**: Verify the model ID matches the provider's available models
- **Connection errors**: Check network connectivity and proxy settings
`
    },
  })
}

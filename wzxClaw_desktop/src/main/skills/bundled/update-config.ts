// ============================================================
// /update-config — Update wzxClaw configuration (from Claude Code)
// Helps users modify settings.json or project config files
// ============================================================

import { registerBundledSkill } from '../bundled-skills'

const UPDATE_CONFIG_PROMPT = `# Update Config

Help the user update wzxClaw configuration files.

## Config File Locations

- **User settings**: \`~/.wzxclaw/settings.json\` — global settings (API key, model, provider, baseURL)
- **Project instructions**: \`WZXCLAW.md\` or \`CLAUDE.md\` in project root — project-specific instructions
- **Project skills**: \`.wzxclaw/skills/\` directory — project-level custom skills
- **MCP config**: \`~/.wzxclaw/mcp.json\` — MCP server configurations

## Common Configuration Tasks

### API Configuration
- Change model: update \`model\` field
- Change provider: update \`provider\` field (\`openai\` or \`anthropic\`)
- Change base URL: update \`baseURL\` field
- Update API key: update \`apiKey\` field

### Permission Configuration
- alwaysAllow: tools that don't need approval (e.g. ["FileRead", "Glob", "Grep"])

### Thinking Configuration
- thinkingDepth: "none" | "low" | "medium" | "high"

## Instructions

1. First, read the current config file the user wants to change
2. Understand what they want to modify
3. Make the change carefully — validate the new value
4. Show a diff of what changed
5. Explain the impact of the change

**Important**:
- Always read the file before modifying
- Never remove existing settings unless explicitly asked
- Validate JSON syntax before writing
- For sensitive fields like API keys, don't echo the full value`

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description:
      'Update wzxClaw configuration files (settings, model, API key, permissions, etc.)',
    whenToUse:
      'Use when the user wants to change settings, configure wzxClaw, update API keys, switch models, or modify permissions. Examples: "change my model", "update my API key", "set always allow for Glob".',
    argumentHint: '[what to update]',
    userInvocable: true,
    async getPrompt(args) {
      let prompt = UPDATE_CONFIG_PROMPT
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return prompt
    },
  })
}

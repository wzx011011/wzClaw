// ============================================================
// /keybindings — Display keyboard shortcuts (from Claude Code)
// ============================================================

import { registerBundledSkill } from '../bundled-skills'

const KEYBINDINGS_PROMPT = `# wzxClaw Keyboard Shortcuts

## Chat Input
| Shortcut | Action |
|----------|--------|
| \`Enter\` | Send message |
| \`Shift+Enter\` | New line |
| \`Shift+Tab\` | Toggle plan mode |
| \`Escape\` | Cancel generation / Close picker |
| \`↑\` (Arrow Up) | Previous input from history (when cursor at start) |
| \`↓\` (Arrow Down) | Next input from history (when cursor at end) |

## Slash Commands
| Command | Description |
|---------|-------------|
| \`/help\` | Show available commands |
| \`/compact\` | Compress context to free tokens |
| \`/clear\` | Start a new session |
| \`/init\` | Analyze codebase and create WZXCLAW.md |
| \`/commit\` | Analyze git changes and commit |
| \`/review\` | Review code changes |
| \`/simplify\` | Review code for reuse/quality/efficiency |
| \`/verify\` | Verify a change works end-to-end |
| \`/batch\` | Parallel work orchestration |
| \`/debug\` | Debug session issues |
| \`/skillify\` | Create reusable skill from session |
| \`/update-config\` | Update wzxClaw settings |
| \`/context\` | Show context window usage |
| \`/plan\` | Toggle plan mode |
| \`/plugin\` | Open plugin manager |
| \`/insights\` | Generate coding insights |

## File Explorer
| Shortcut | Action |
|----------|--------|
| \`Ctrl+Shift+O\` | Open folder |
| \`Ctrl+S\` | Save current file |
| \`F12\` | Toggle DevTools |

## Tips
- Type \`/\` in the input to see all available slash commands
- Type \`@\` to mention files in your message
- Paste images directly into the input to attach them
- Drag and drop images onto the input area`

export function registerKeybindingsSkill(): void {
  registerBundledSkill({
    name: 'keybindings',
    description:
      'Display keyboard shortcuts and quick reference for wzxClaw',
    whenToUse:
      'Use when the user asks about keyboard shortcuts, hotkeys, or how to perform an action quickly. Examples: "show shortcuts", "keyboard help", "how do I...".',
    userInvocable: true,
    disableModelInvocation: true,
    async getPrompt(_args) {
      return KEYBINDINGS_PROMPT
    },
  })
}

import React from 'react'
import { Command } from 'cmdk'
import { useCommandStore } from '../stores/command-store'

// ============================================================
// CommandPalette — VS Code-style command palette overlay (per CMD-01)
// Uses cmdk for fuzzy search, keyboard navigation, and grouping.
// ============================================================

export default function CommandPalette(): JSX.Element | null {
  const commands = useCommandStore((s) => s.commands)
  const paletteOpen = useCommandStore((s) => s.paletteOpen)
  const closePalette = useCommandStore((s) => s.closePalette)
  const execute = useCommandStore((s) => s.execute)

  if (!paletteOpen) return null

  // Group commands by category, preserving insertion order
  const categories = new Map<string, typeof commands>()
  for (const cmd of commands) {
    const existing = categories.get(cmd.category) ?? []
    categories.set(cmd.category, [...existing, cmd])
  }

  return (
    <div className="command-palette-overlay" onClick={closePalette}>
      <Command.Dialog
        open={paletteOpen}
        onOpenChange={(open) => {
          if (!open) closePalette()
        }}
        label="Command Palette"
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <Command.Input className="command-palette-input" placeholder="Type a command..." />
        <Command.List className="command-palette-list">
          <Command.Empty className="command-palette-empty">
            No matching commands
          </Command.Empty>
          {Array.from(categories.entries()).map(([category, cmds]) => (
            <Command.Group key={category} heading={category}>
              {cmds.map((cmd) => (
                <Command.Item
                  key={cmd.id}
                  value={cmd.label}
                  onSelect={() => {
                    execute(cmd.id)
                    closePalette()
                  }}
                  className={`command-palette-item${cmd.available === false ? ' unavailable' : ''}`}
                  disabled={cmd.available === false}
                >
                  <span>{cmd.label}</span>
                  {cmd.available === false && (
                    <span className="command-palette-coming-soon">Coming soon</span>
                  )}
                  {cmd.shortcut && (
                    <kbd className="command-palette-shortcut">{cmd.shortcut}</kbd>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command.Dialog>
    </div>
  )
}

import React, { useState, useEffect, useRef } from 'react'
import type { SlashCommand } from '../../../shared/types'

// ============================================================
// SlashCommandPicker — Dropdown shown when input starts with /
// (per SLASH-01)
// ============================================================

interface SlashCommandPickerProps {
  visible: boolean
  query: string
  commands: SlashCommand[]
  onSelect: (cmd: SlashCommand) => void
  onClose: () => void
}

export default function SlashCommandPicker({
  visible,
  query,
  commands,
  onSelect,
  onClose
}: SlashCommandPickerProps): JSX.Element | null {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter commands whose name starts with the query
  const filteredCommands = query
    ? commands.filter((cmd) => cmd.name.toLowerCase().startsWith(query.toLowerCase()))
    : commands

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Close on outside click
  useEffect(() => {
    if (!visible) return
    const handleMouseDown = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [visible, onClose])

  // Keyboard navigation — capture phase so we win over ChatPanel's keydown
  useEffect(() => {
    if (!visible) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filteredCommands[selectedIndex]) {
          onSelect(filteredCommands[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [visible, filteredCommands, selectedIndex, onSelect, onClose])

  if (!visible || filteredCommands.length === 0) return null

  return (
    <div className="slash-picker" ref={listRef}>
      {filteredCommands.map((cmd, idx) => (
        <div
          key={cmd.name}
          className={`slash-picker-item${idx === selectedIndex ? ' slash-picker-active' : ''}`}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => setSelectedIndex(idx)}
        >
          <span className="slash-picker-name">/{cmd.name}</span>
          <span className="slash-picker-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  )
}

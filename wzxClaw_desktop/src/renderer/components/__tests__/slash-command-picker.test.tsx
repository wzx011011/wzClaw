// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import SlashCommandPicker from '../chat/SlashCommandPicker'
import type { SlashCommand } from '../../../../shared/types'

// jsdom 没有 scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Compact context' },
  { name: 'clear', description: 'Clear chat' },
  { name: 'help', description: 'Show help' },
] as SlashCommand[]

describe('SlashCommandPicker', () => {
  const defaults = {
    visible: true,
    query: '',
    commands: COMMANDS,
    onSelect: vi.fn(),
    onClose: vi.fn(),
  }

  it('renders all commands when query is empty', () => {
    render(<SlashCommandPicker {...defaults} />)
    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.getByText('/clear')).toBeInTheDocument()
    expect(screen.getByText('/help')).toBeInTheDocument()
  })

  it('returns null when not visible', () => {
    const { container } = render(<SlashCommandPicker {...defaults} visible={false} />)
    expect(container.innerHTML).toBe('')
  })

  it('filters commands by query', () => {
    render(<SlashCommandPicker {...defaults} query="co" />)
    expect(screen.getByText('/compact')).toBeInTheDocument()
    expect(screen.queryByText('/clear')).not.toBeInTheDocument()
    expect(screen.queryByText('/help')).not.toBeInTheDocument()
  })

  it('returns null when no commands match query', () => {
    const { container } = render(<SlashCommandPicker {...defaults} query="xyz" />)
    expect(container.innerHTML).toBe('')
  })

  it('calls onSelect when clicking a command', async () => {
    render(<SlashCommandPicker {...defaults} />)
    fireEvent.click(screen.getByText('/compact'))
    expect(defaults.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'compact' }))
  })

  it('navigates with ArrowDown/ArrowUp and selects with Enter', () => {
    render(<SlashCommandPicker {...defaults} />)

    // ArrowDown twice → index 2 (help)
    fireEvent.keyDown(window, { key: 'ArrowDown', bubbles: true })
    fireEvent.keyDown(window, { key: 'ArrowDown', bubbles: true })
    fireEvent.keyDown(window, { key: 'Enter', bubbles: true })

    expect(defaults.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'help' }))
  })

  it('calls onClose on Escape', () => {
    render(<SlashCommandPicker {...defaults} />)
    fireEvent.keyDown(window, { key: 'Escape', bubbles: true })
    expect(defaults.onClose).toHaveBeenCalled()
  })
})

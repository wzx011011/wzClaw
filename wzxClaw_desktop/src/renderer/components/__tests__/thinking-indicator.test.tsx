// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import ThinkingIndicator from '../chat/ThinkingIndicator'

describe('ThinkingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders thinking indicator container', () => {
    const { container } = render(<ThinkingIndicator />)
    expect(container.querySelector('.thinking-indicator')).toBeInTheDocument()
  })

  it('renders a dot and a phrase', () => {
    const { container } = render(<ThinkingIndicator />)
    expect(container.querySelector('.thinking-dot')).toBeTruthy()
    const phraseEl = container.querySelector('.thinking-phrase')
    expect(phraseEl?.textContent).toMatch(/Thinking\.\.\.|Reasoning\.\.\.|Analyzing\.\.\.|Evaluating\.\.\./)
  })

  it('cycles phrases after the timer', () => {
    const { container } = render(<ThinkingIndicator />)
    const initial = container.querySelector('.thinking-phrase')?.textContent

    // Advance past CYCLE_MS (3000) + FADE_MS (280)
    act(() => { vi.advanceTimersByTime(3300) })

    const after = container.querySelector('.thinking-phrase')?.textContent
    expect(after).not.toBe(initial)
  })
})

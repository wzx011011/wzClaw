// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import WelcomeScreen from '../ide/WelcomeScreen'

describe('WelcomeScreen', () => {
  it('renders wzxClaw branding', () => {
    render(<WelcomeScreen />)
    expect(screen.getByText('wzxClaw')).toBeInTheDocument()
  })

  it('renders subtitle', () => {
    render(<WelcomeScreen />)
    expect(screen.getByText('AI Coding IDE')).toBeInTheDocument()
  })

  it('renders open folder prompt', () => {
    render(<WelcomeScreen />)
    expect(screen.getByText('Open a folder to get started')).toBeInTheDocument()
  })

  it('renders keyboard shortcuts', () => {
    render(<WelcomeScreen />)
    expect(screen.getByText('Ctrl+Shift+O')).toBeInTheDocument()
    expect(screen.getByText('Open Folder')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+S')).toBeInTheDocument()
    expect(screen.getByText('Save File')).toBeInTheDocument()
  })
})

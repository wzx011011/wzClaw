import React from 'react'

/**
 * WelcomeScreen — shown when no tabs are open (per plan spec).
 * Displays wzxClaw branding, open folder prompt, and keyboard shortcuts.
 */
export default function WelcomeScreen(): JSX.Element {
  return (
    <div className="welcome-screen">
      <div className="welcome-title">wzxClaw</div>
      <div className="welcome-subtitle">AI Coding IDE</div>
      <div className="welcome-subtitle">Open a folder to get started</div>
      <div className="welcome-shortcuts">
        <div className="welcome-shortcut">
          <kbd>Ctrl+Shift+O</kbd>
          <span>Open Folder</span>
        </div>
        <div className="welcome-shortcut">
          <kbd>Ctrl+S</kbd>
          <span>Save File</span>
        </div>
      </div>
    </div>
  )
}

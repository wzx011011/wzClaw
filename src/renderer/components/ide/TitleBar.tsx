import React from 'react'

/**
 * TitleBar — custom draggable titlebar for frameless window.
 * Works with Electron's titleBarStyle: 'hidden' + titleBarOverlay.
 * The native window controls (minimize/maximize/close) are rendered
 * by the OS overlay on the right side.
 */
export default function TitleBar(): JSX.Element {
  return (
    <div className="ide-titlebar">
      <span className="ide-titlebar-brand">wzxClaw</span>
    </div>
  )
}

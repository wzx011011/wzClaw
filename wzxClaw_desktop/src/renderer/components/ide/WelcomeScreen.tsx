import React from 'react'
import { useT } from '../../i18n/useT'

/**
 * WelcomeScreen — shown when no tabs are open (per plan spec).
 * Displays wzxClaw branding, open folder prompt, and keyboard shortcuts.
 */
export default function WelcomeScreen(): JSX.Element {
  const t = useT()
  return (
    <div className="welcome-screen">
      <div className="welcome-title">wzxClaw</div>
      <div className="welcome-subtitle">{t('welcome.subtitle')}</div>
      <div className="welcome-subtitle">{t('welcome.prompt')}</div>
      <div className="welcome-shortcuts">
        <div className="welcome-shortcut">
          <kbd>Ctrl+Shift+O</kbd>
          <span>{t('welcome.openFolder')}</span>
        </div>
        <div className="welcome-shortcut">
          <kbd>Ctrl+S</kbd>
          <span>{t('welcome.saveFile')}</span>
        </div>
      </div>
    </div>
  )
}

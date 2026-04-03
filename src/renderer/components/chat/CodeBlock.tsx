import React, { useState } from 'react'
import { useTabStore } from '../../stores/tab-store'

// ============================================================
// CodeBlock — Syntax-highlighted code block with Apply + Copy (per D-60)
// ============================================================

interface CodeBlockProps {
  code: string
  language?: string
}

export default function CodeBlock({ code, language }: CodeBlockProps): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [applied, setApplied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }

  const handleApply = (): void => {
    const activeTab = useTabStore.getState().getActiveTab()
    if (!activeTab) {
      // No active editor tab — cannot apply
      return
    }
    useTabStore.getState().updateTabContent(activeTab.id, code)
    setApplied(true)
    setTimeout(() => setApplied(false), 2000)
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-language">{language || 'text'}</span>
        <div className="code-block-actions">
          <button className="code-block-btn" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button className="code-block-btn apply-btn" onClick={handleApply}>
            {applied ? 'Applied!' : 'Apply'}
          </button>
        </div>
      </div>
      <pre>
        <code className={language ? `language-${language}` : ''}>{code}</code>
      </pre>
    </div>
  )
}

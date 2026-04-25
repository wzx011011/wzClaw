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
  const [collapsed, setCollapsed] = useState(true)

  const lineCount = (code.match(/\n/g) || []).length + 1
  const isLong = lineCount > 15

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
          <button
            className={`code-block-btn${copied ? ' code-block-btn-success' : ''}`}
            onClick={handleCopy}
            aria-label={copied ? '已复制到剪贴板' : '复制代码'}
          >
            {copied ? <><span className="code-block-btn-icon" aria-hidden="true">✓</span> 已复制</> : '复制'}
          </button>
          <button
            className={`code-block-btn apply-btn${applied ? ' code-block-btn-success' : ''}`}
            onClick={handleApply}
          >
            {applied ? <><span className="code-block-btn-icon" aria-hidden="true">✓</span> 已应用</> : '应用'}
          </button>
        </div>
      </div>
      <pre className={isLong ? (collapsed ? 'code-block-collapsed' : 'code-block-expanded') : ''}>
        <code className={language ? `language-${language}` : ''}>{code}</code>
      </pre>
      {isLong && (
        <button className="code-block-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? `Show more (${lineCount} lines)` : 'Show less'}
        </button>
      )}
    </div>
  )
}

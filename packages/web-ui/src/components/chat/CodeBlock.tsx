// ============================================================
// CodeBlock — 语法高亮代码块 + 复制按钮
// 从桌面端提取，移除 Apply 按钮（web-ui 无 Monaco 编辑器）
// 使用 highlight.js 做轻量级语法高亮
// ============================================================

import React, { useState, useRef, useEffect } from 'react'
import hljs from 'highlight.js/lib/core'

// 按需注册常用语言（减小包体积）
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import sql from 'highlight.js/lib/languages/sql'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import yaml from 'highlight.js/lib/languages/yaml'
import diff from 'highlight.js/lib/languages/diff'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('css', css)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('svg', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c++', cpp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('text', plaintext)

interface CodeBlockProps {
  code: string
  language?: string
}

/**
 * CodeBlock — 带语法高亮的代码块
 * - 高亮使用 highlight.js（按需注册语言）
 * - 折叠长代码（> 15 行）
 * - 复制按钮
 */
export default function CodeBlock({ code, language }: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const codeRef = useRef<HTMLElement>(null)

  const lineCount = (code.match(/\n/g) || []).length + 1
  const isLong = lineCount > 15

  // 使用 highlight.js 进行语法高亮
  useEffect(() => {
    if (codeRef.current && language) {
      try {
        const result = hljs.highlight(code, { language })
        codeRef.current.innerHTML = result.value
      } catch {
        // 语言不支持或高亮失败，使用纯文本
        codeRef.current.textContent = code
      }
    } else if (codeRef.current) {
      codeRef.current.textContent = code
    }
  }, [code, language])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-language">{language || 'text'}</span>
        <div className="code-block-actions">
          <button
            className={`code-block-btn${copied ? ' code-block-btn-success' : ''}`}
            onClick={handleCopy}
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
        </div>
      </div>
      <pre className={isLong ? (collapsed ? 'code-block-collapsed' : 'code-block-expanded') : ''}>
        <code ref={codeRef} className={language ? `language-${language}` : ''}>
          {code}
        </code>
      </pre>
      {isLong && (
        <button className="code-block-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? `展开全部 (${lineCount} 行)` : '收起'}
        </button>
      )}
    </div>
  )
}

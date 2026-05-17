// ============================================================
// EditorPanel — Monaco 编辑器面板
//
// 懒加载 Monaco，显示当前活跃标签的文件内容。
// 支持 Ctrl+S 保存（通过 DataSource.fs.writeFile）。
// ============================================================

import React, { useEffect, useRef, useCallback } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'
import { useTabStore } from '../../stores/tab-store'
import WelcomeScreen from './WelcomeScreen'
import TabBar from './TabBar'

export default function EditorPanel(): React.ReactElement {
  const dataSource = useDataSource()
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const updateContent = useTabStore((s) => s.updateContent)
  const markSaved = useTabStore((s) => s.markSaved)

  const editorContainerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  const disposablesRef = useRef<Array<{ dispose(): void }>>([])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  // 初始化 Monaco
  useEffect(() => {
    if (!editorContainerRef.current) return

    let cancelled = false

    async function initMonaco() {
      const monaco = await import('monaco-editor')
      if (cancelled || !editorContainerRef.current) return

      monacoRef.current = monaco

      const editor = monaco.editor.create(editorContainerRef.current, {
        value: '',
        language: 'typescript',
        theme: 'vs-dark',
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 8 },
        lineNumbers: 'on',
        renderLineHighlight: 'all',
        bracketPairColorization: { enabled: true },
      })

      editorRef.current = editor
    }

    initMonaco()

    return () => {
      cancelled = true
      disposablesRef.current.forEach((d) => d.dispose())
      disposablesRef.current = []
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [])

  // 活跃标签变化 → 更新编辑器内容
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !activeTab) return

    const model = editor.getModel()
    if (model) {
      // 避免重复设置相同内容
      if (model.getValue() !== activeTab.content) {
        model.setValue(activeTab.content)
      }
      monaco.editor.setModelLanguage(model, activeTab.language)
    }
  }, [activeTab?.id, activeTab?.content, activeTab?.language])

  // 编辑器内容变化 → 更新 store
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !activeTab) return

    const disposable = editor.onDidChangeModelContent(() => {
      const value = editor.getValue()
      if (value !== activeTab.content) {
        updateContent(activeTab.id, value)
      }
    })
    disposablesRef.current.push(disposable)

    return () => {
      disposable.dispose()
    }
  }, [activeTab?.id])

  // Ctrl+S 保存
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      if (activeTab?.isDirty && dataSource?.fs) {
        dataSource.fs.writeFile(activeTab.filePath, activeTab.content).then(() => {
          markSaved(activeTab.id)
        })
      }
    }
  }, [activeTab, dataSource?.fs, markSaved])

  // 无标签 → 显示欢迎页
  if (tabs.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <WelcomeScreen />
      </div>
    )
  }

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <TabBar />
      <div ref={editorContainerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}

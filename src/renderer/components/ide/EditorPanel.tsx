import React, { useCallback, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useTabStore } from '../../stores/tab-store'

/**
 * EditorPanel — Monaco Editor wrapper (per D-42).
 * Renders the active tab's content with syntax highlighting.
 * Supports Ctrl+S save, content change tracking, and vs-dark theme.
 */

export default function EditorPanel(): JSX.Element {
  const activeTab = useTabStore((s) => {
    const tabId = s.activeTabId
    return s.tabs.find((t) => t.id === tabId)
  })
  const updateTabContent = useTabStore((s) => s.updateTabContent)
  const saveTab = useTabStore((s) => s.saveTab)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)

  const handleEditorMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor

      // Register Ctrl+S keybinding inside Monaco to prevent browser default
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          const currentActiveId = useTabStore.getState().activeTabId
          if (currentActiveId) {
            saveTab(currentActiveId)
          }
        }
      )
    },
    [saveTab]
  )

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeTab && value !== undefined) {
        updateTabContent(activeTab.id, value)
      }
    },
    [activeTab, updateTabContent]
  )

  if (!activeTab) {
    return <div className="editor-panel" />
  }

  return (
    <div className="editor-panel">
      <Editor
        height="100%"
        language={activeTab.language}
        value={activeTab.content}
        theme="vs-dark"
        onChange={handleChange}
        onMount={handleEditorMount}
        options={{
          fontSize: 14,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          tabSize: 2,
          renderWhitespace: 'selection'
        }}
        path={activeTab.filePath}
      />
    </div>
  )
}

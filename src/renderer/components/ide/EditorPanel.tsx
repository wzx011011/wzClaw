import React, { useCallback, useRef, useEffect } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useTabStore } from '../../stores/tab-store'
import { useDiffStore } from '../../stores/diff-store'

/**
 * EditorPanel — Monaco Editor wrapper (per D-42).
 * Renders the active tab's content with syntax highlighting.
 * Supports Ctrl+S save, content change tracking, and vs-dark theme.
 * When diff-store has an active diff for the current file, renders
 * inline red/green decorations for added/deleted/replace hunks.
 */

export default function EditorPanel(): JSX.Element {
  const activeTab = useTabStore((s) => {
    const tabId = s.activeTabId
    return s.tabs.find((t) => t.id === tabId)
  })
  const updateTabContent = useTabStore((s) => s.updateTabContent)
  const saveTab = useTabStore((s) => s.saveTab)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)

  // Diff state
  const activeDiffId = useDiffStore((s) => s.activeDiffId)
  const pendingDiffs = useDiffStore((s) => s.pendingDiffs)

  // Find the active diff that matches the current file
  const activeDiff = activeDiffId
    ? pendingDiffs.find((d) => d.id === activeDiffId && d.filePath === activeTab?.filePath)
    : null

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

  // Manage Monaco decorations for diff hunks
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    if (!activeDiff || activeDiff.hunks.length === 0) {
      // Clear all decorations
      editor.deltaDecorations(
        (editor as unknown as Record<string, string[]>).__diffDecorations ?? [],
        []
      )
      return
    }

    const decorations: MonacoEditor.IModelDeltaDecoration[] = []

    for (const hunk of activeDiff.hunks) {
      if (hunk.status !== 'pending') continue

      const startLine = hunk.startIndex + 1  // Monaco lines are 1-based
      const endLine = hunk.endIndex + 1

      // Add red background for deleted/replaced lines
      if (hunk.type === 'delete' || hunk.type === 'replace') {
        decorations.push({
          range: new monaco.Range(startLine, 1, endLine, 1),
          options: {
            isWholeLine: true,
            className: 'diff-deleted-line',
            glyphMarginClassName: 'diff-deleted-glyph',
            overviewRuler: {
              color: '#f48771',
              position: monaco.editor.OverviewRulerLane.Full
            }
          }
        })
      }

      // Add green background for added lines
      if (hunk.type === 'add') {
        decorations.push({
          range: new monaco.Range(startLine, 1, endLine, 1),
          options: {
            isWholeLine: true,
            className: 'diff-added-line',
            glyphMarginClassName: 'diff-added-glyph',
            overviewRuler: {
              color: '#89d185',
              position: monaco.editor.OverviewRulerLane.Full
            }
          }
        })
      }
    }

    const oldDecorations = (editor as unknown as Record<string, string[]>).__diffDecorations ?? []
    const newDecorations = editor.deltaDecorations(oldDecorations, decorations)
    ;(editor as unknown as Record<string, string[]>).__diffDecorations = newDecorations
  }, [activeDiff])

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

  // Switch editor to read-only when diff is active for this file
  const isDiffActive = activeDiff !== null && activeDiff !== undefined

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
          renderWhitespace: 'selection',
          readOnly: isDiffActive,
          glyphMargin: isDiffActive
        }}
        path={activeTab.filePath}
      />
    </div>
  )
}

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import type { MentionItem } from '../../../shared/types'

// ============================================================
// MentionPicker — Fuzzy file/folder picker dropdown triggered by @
// (per MENTION-01, MENTION-02, MENTION-03, MENTION-05)
// ============================================================

interface MentionPickerProps {
  visible: boolean
  filter: string
  onSelect: (item: MentionItem) => void
  onClose: () => void
}

interface FlatFileEntry {
  path: string  // relative path
  name: string  // filename or directory name only
  absPath: string
  isDirectory: boolean
}

/**
 * Flatten the workspace file tree into a list of relative-path entries,
 * including both files and directories as selectable items.
 */
function flattenTree(nodes: { name: string; path: string; isDirectory: boolean; children?: any[] }[], rootPath: string): FlatFileEntry[] {
  const results: FlatFileEntry[] = []
  for (const node of nodes) {
    const relative = node.path.replace(/\\/g, '/').startsWith(rootPath.replace(/\\/g, '/'))
      ? node.path.replace(/\\/g, '/').slice(rootPath.replace(/\\/g, '/').length + 1)
      : node.path

    if (node.isDirectory) {
      // Include directory as a selectable entry
      results.push({
        path: relative,
        name: node.name,
        absPath: node.path,
        isDirectory: true
      })
      // Also recurse into children
      if (node.children) {
        results.push(...flattenTree(node.children, rootPath))
      }
    } else {
      results.push({
        path: relative,
        name: node.name,
        absPath: node.path,
        isDirectory: false
      })
    }
  }
  return results
}

/**
 * Simple fuzzy match: each character in the query must appear in order
 * somewhere in the target. Returns match indices or null if no match.
 */
function fuzzyMatch(query: string, target: string): number[] | null {
  const lowerTarget = target.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const indices: number[] = []
  let targetIdx = 0

  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const ch = lowerQuery[qi]
    const found = lowerTarget.indexOf(ch, targetIdx)
    if (found === -1) return null
    indices.push(found)
    targetIdx = found + 1
  }
  return indices
}

export default function MentionPicker({ visible, filter, onSelect, onClose }: MentionPickerProps): JSX.Element | null {
  const tree = useWorkspaceStore((s) => s.tree)
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Flatten tree to file list
  const allFiles = useMemo(() => {
    if (!rootPath) return []
    return flattenTree(tree, rootPath)
  }, [tree, rootPath])

  // Filter files by fuzzy match
  const filteredFiles = useMemo(() => {
    if (!filter) return allFiles.slice(0, 50)
    const matched: { entry: FlatFileEntry; indices: number[] }[] = []
    for (const entry of allFiles) {
      const indices = fuzzyMatch(filter, entry.path)
      if (indices) {
        matched.push({ entry, indices })
      }
    }
    // Sort: prefer matches in filename, then path length
    matched.sort((a, b) => {
      const aInName = a.indices.some(i => i >= a.entry.path.length - a.entry.name.length)
      const bInName = b.indices.some(i => i >= b.entry.path.length - b.entry.name.length)
      if (aInName && !bInName) return -1
      if (!aInName && bInName) return 1
      return a.entry.path.length - b.entry.path.length
    })
    return matched.slice(0, 50).map(m => m.entry)
  }, [allFiles, filter])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filteredFiles.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filteredFiles[selectedIndex]) {
          handleSelect(filteredFiles[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [visible, filteredFiles, selectedIndex])

  const handleSelect = async (entry: FlatFileEntry) => {
    if (loading) return // prevent double-click
    setLoading(entry.path)
    try {
      if (entry.isDirectory) {
        // Read folder tree for directory mentions
        const result = await window.wzxclaw.readFolderTree({ dirPath: entry.path })
        if ('error' in result) {
          alert(`Cannot add ${entry.path}: ${result.error}`)
          return
        }
        const mention = {
          type: 'folder_mention' as const,
          path: result.path,
          content: result.tree,
          size: result.fileCount
        }
        onSelect(mention)
      } else {
        // Read file content for file mentions
        const result = await window.wzxclaw.readFileContent({ filePath: entry.path })
        if ('error' in result) {
          // File too large — show alert, don't add
          alert(`Cannot add ${entry.path}: ${result.error} (${(result.size / 1024).toFixed(1)}KB exceeds ${(result.limit / 1024).toFixed(0)}KB limit)`)
          return
        }
        const mention = {
          type: 'file_mention' as const,
          path: result.path,
          content: result.content,
          size: result.size
        }
        onSelect(mention)
      }
    } catch (err) {
      console.error('Failed to read entry for mention:', err)
    } finally {
      setLoading(null)
    }
  }

  if (!visible || filteredFiles.length === 0) return null

  /**
   * Render a file path with matched characters highlighted.
   */
  const renderPath = (entry: FlatFileEntry) => {
    if (!filter) return <span>{entry.path}</span>
    const indices = fuzzyMatch(filter, entry.path)
    if (!indices) return <span>{entry.path}</span>

    const chars = entry.path.split('')
    return (
      <span>
        {chars.map((ch, i) => {
          const isMatch = indices.includes(i)
          return isMatch
            ? <span key={i} className="mention-match">{ch}</span>
            : <span key={i}>{ch}</span>
        })}
      </span>
    )
  }

  return (
    <div className="mention-picker" ref={listRef}>
      {filteredFiles.map((entry, idx) => (
        <div
          key={entry.absPath}
          className={`mention-picker-item${idx === selectedIndex ? ' mention-picker-active' : ''}${entry.isDirectory ? ' mention-picker-folder' : ''}`}
          onClick={() => handleSelect(entry)}
          onMouseEnter={() => setSelectedIndex(idx)}
        >
          <span className="mention-picker-entry">
            {entry.isDirectory && <span className="mention-folder-icon">\uD83D\uDCC1</span>}
            {renderPath(entry)}
          </span>
          {loading === entry.path && <span className="mention-loading">...</span>}
        </div>
      ))}
    </div>
  )
}

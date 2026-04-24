import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTabStore } from '../../stores/tab-store'
import type { FileTreeNode } from '../../../shared/types'

/**
 * FileExplorer — recursive directory tree component (per D-45, D-47).
 * Lazy-loads children on expand. Supports context menu (D-48).
 */

// File extension to icon character + CSS class mapping
function getFileIcon(name: string): { char: string; className: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const dotfiles: Record<string, { char: string; className: string }> = {
    '.gitignore': { char: '', className: 'file-icon-git' },
    '.eslintrc': { char: '⬡', className: 'file-icon-config' },
    '.prettierrc': { char: '⬡', className: 'file-icon-config' },
  }
  if (dotfiles[name]) return dotfiles[name]

  const map: Record<string, { char: string; className: string }> = {
    ts: { char: 'TS', className: 'file-icon-ts' },
    tsx: { char: 'TX', className: 'file-icon-tsx' },
    js: { char: 'JS', className: 'file-icon-js' },
    jsx: { char: 'JX', className: 'file-icon-jsx' },
    json: { char: '{}', className: 'file-icon-json' },
    css: { char: '#', className: 'file-icon-css' },
    scss: { char: '#', className: 'file-icon-css' },
    html: { char: '<>', className: 'file-icon-html' },
    md: { char: 'M', className: 'file-icon-md' },
    py: { char: 'py', className: 'file-icon-py' },
    rs: { char: 'rs', className: 'file-icon-rs' },
    go: { char: 'go', className: 'file-icon-go' },
    yaml: { char: '⋮', className: 'file-icon-yaml' },
    yml: { char: '⋮', className: 'file-icon-yaml' },
    sh: { char: '$', className: 'file-icon-sh' },
    bash: { char: '$', className: 'file-icon-sh' },
    png: { char: '🖼', className: 'file-icon-image' },
    jpg: { char: '🖼', className: 'file-icon-image' },
    svg: { char: '◇', className: 'file-icon-image' },
    gif: { char: '🖼', className: 'file-icon-image' },
    ico: { char: '◆', className: 'file-icon-image' },
    toml: { char: '⋮', className: 'file-icon-config' },
    env: { char: '⬡', className: 'file-icon-config' },
    lock: { char: '🔒', className: 'file-icon-config' },
  }
  return map[ext] ?? { char: '·', className: '' }
}

interface TreeNodeProps {
  node: FileTreeNode
  depth: number
}

function TreeNodeItem({ node, depth }: TreeNodeProps): JSX.Element {
  const expandNode = useWorkspaceStore((s) => s.expandNode)
  const collapseNode = useWorkspaceStore((s) => s.collapseNode)
  const openTab = useTabStore((s) => s.openTab)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const handleDirectoryClick = useCallback(async () => {
    if (node.isExpanded) {
      collapseNode(node.path)
    } else {
      await expandNode(node.path)
    }
  }, [node.path, node.isExpanded, expandNode, collapseNode])

  const handleFileClick = useCallback(async () => {
    try {
      const result = await window.wzxclaw.readFile({ filePath: node.path })
      const fileName = node.name
      openTab(node.path, fileName, result.content, result.language)
      // Notify IDELayout to open the right sidebar with editor
      window.dispatchEvent(new CustomEvent('wzxclaw:file-opened'))
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  }, [node.path, node.name, openTab])

  const handleClick = useCallback(() => {
    if (node.isDirectory) {
      handleDirectoryClick()
    } else {
      handleFileClick()
    }
  }, [node.isDirectory, handleDirectoryClick, handleFileClick])

  const handleRenameCommit = useCallback(async () => {
    const trimmed = renameValue.trim()
    if (!trimmed || trimmed === node.name) {
      setRenaming(false)
      return
    }
    const dirPath = node.path.substring(0, node.path.length - node.name.length)
    const newPath = dirPath + trimmed
    try {
      const result = await window.wzxclaw.renameFile({ oldPath: node.path, newPath })
      if (result.success) {
        // Refresh the parent directory to show updated name
        const parentDir = dirPath.endsWith('/') || dirPath.endsWith('\\') ? dirPath.slice(0, -1) : dirPath
        if (parentDir) {
          useWorkspaceStore.getState().expandNode(parentDir)
        }
      }
    } catch (err) {
      console.error('Rename failed:', err)
    }
    setRenaming(false)
  }, [renameValue, node.path, node.name])

  const handleDelete = useCallback(async () => {
    const confirmed = window.confirm(`确定删除 "${node.name}" 吗？此操作不可撤销。`)
    if (!confirmed) return
    try {
      const result = await window.wzxclaw.deleteFile({ filePath: node.path })
      if (result.success) {
        // Refresh parent directory
        const dirPath = node.path.substring(0, node.path.length - node.name.length)
        const parentDir = dirPath.endsWith('/') || dirPath.endsWith('\\') ? dirPath.slice(0, -1) : dirPath
        if (parentDir) {
          useWorkspaceStore.getState().expandNode(parentDir)
        }
      }
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }, [node.path, node.name])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY })
    },
    []
  )

  // Close context menu on click elsewhere
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renaming])

  // Icon rendering
  const dirIcon = node.isExpanded ? '\u25BE' : '\u25B8'  // small triangles
  const fileIcon = getFileIcon(node.name)

  return (
    <>
      <div
        className="tree-node"
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={node.path}
      >
        {node.isDirectory ? (
          <span className="tree-icon dir-icon">{dirIcon}</span>
        ) : (
          <span className={`tree-icon file-icon ${fileIcon.className}`} style={{ fontSize: 9, fontWeight: 700 }}>{fileIcon.char}</span>
        )}
        {renaming ? (
          <input
            ref={renameInputRef}
            className="tree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameCommit()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tree-label">{node.name}</span>
        )}
      </div>

      {/* Render children if expanded directory */}
      {node.isDirectory && node.isExpanded && node.children && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              if (!node.isDirectory) handleFileClick()
              setContextMenu(null)
            }}
          >
            Open
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              setRenameValue(node.name)
              setRenaming(true)
              setContextMenu(null)
            }}
          >
            Rename
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              handleDelete()
              setContextMenu(null)
            }}
          >
            Delete
          </button>
        </div>
      )}
    </>
  )
}

export default function FileExplorer(): JSX.Element {
  const tree = useWorkspaceStore((s) => s.tree)

  if (tree.length === 0) {
    return <div style={{ padding: 12, color: 'var(--text-secondary)' }}>Empty workspace</div>
  }

  // When there are multiple root folders, show each with a section header
  const isMultiRoot = tree.length > 1 && tree.every((n) => n.isDirectory)

  return (
    <div className="file-explorer">
      {tree.map((node) => (
        <div key={node.path} className={isMultiRoot ? 'file-explorer-root-section' : undefined}>
          {isMultiRoot && (
            <div className="file-explorer-root-header" title={node.path}>
              <span className="file-explorer-root-label">{node.name.toUpperCase()}</span>
            </div>
          )}
          <TreeNodeItem node={node} depth={0} />
        </div>
      ))}
    </div>
  )
}

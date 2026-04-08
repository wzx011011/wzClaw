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
        <span className="tree-label">{node.name}</span>
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
              console.log('Rename stub:', node.path)
              setContextMenu(null)
            }}
          >
            Rename
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              console.log('Delete stub:', node.path)
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

  return (
    <div className="file-explorer">
      {tree.map((node) => (
        <TreeNodeItem key={node.path} node={node} depth={0} />
      ))}
    </div>
  )
}

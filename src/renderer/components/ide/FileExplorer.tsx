import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTabStore } from '../../stores/tab-store'
import type { FileTreeNode } from '../../../shared/types'

/**
 * FileExplorer — recursive directory tree component (per D-45, D-47).
 * Lazy-loads children on expand. Supports context menu (D-48).
 */

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
  const icon = node.isDirectory
    ? node.isExpanded
      ? '\u25BC'   // down-pointing triangle (expanded)
      : '\u25B6'   // right-pointing triangle (collapsed)
    : '\u25CB'     // circle (file)

  const iconClass = node.isDirectory ? 'tree-icon dir-icon' : 'tree-icon file-icon'

  return (
    <>
      <div
        className="tree-node"
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={node.path}
      >
        <span className={iconClass}>{icon}</span>
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

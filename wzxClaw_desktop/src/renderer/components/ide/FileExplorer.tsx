import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTabStore } from '../../stores/tab-store'
import ContextMenu from '../ui/ContextMenu'
import type { ContextMenuItem } from '../ui/ContextMenu'
import type { FileTreeNode } from '../../../shared/types'

/**
 * FileExplorer — 增强版递归目录树组件
 * 新增：工具栏、搜索过滤、扩展右键菜单、更多文件类型图标
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

  // 无扩展名的特殊文件名
  if (name === 'Dockerfile' || name === 'dockerfile') return { char: 'Dk', className: 'file-icon-docker' }
  if (name === 'Makefile' || name === 'makefile') return { char: 'Mk', className: 'file-icon-config' }

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
    // 新增文件类型
    dart: { char: 'Da', className: 'file-icon-dart' },
    kt: { char: 'Kt', className: 'file-icon-kt' },
    java: { char: 'Ja', className: 'file-icon-java' },
    gradle: { char: 'Gr', className: 'file-icon-gradle' },
    xml: { char: '</>', className: 'file-icon-xml' },
    c: { char: 'C', className: 'file-icon-c' },
    h: { char: 'H', className: 'file-icon-c' },
    cpp: { char: 'C+', className: 'file-icon-cpp' },
    cs: { char: 'C#', className: 'file-icon-cs' },
    swift: { char: 'Sw', className: 'file-icon-swift' },
    rb: { char: 'Rb', className: 'file-icon-rb' },
    php: { char: 'Ph', className: 'file-icon-php' },
    sql: { char: 'DB', className: 'file-icon-sql' },
  }
  return map[ext] ?? { char: '·', className: '' }
}

/** 递归过滤文件树，保留匹配节点及其父目录 */
function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes
  const lower = query.toLowerCase()
  return nodes.reduce<FileTreeNode[]>((acc, node) => {
    if (node.isDirectory && node.children) {
      const filteredChildren = filterTree(node.children, query)
      if (filteredChildren.length > 0) {
        acc.push({ ...node, children: filteredChildren, isExpanded: true })
      }
    } else if (node.name.toLowerCase().includes(lower)) {
      acc.push(node)
    }
    return acc
  }, [])
}

/** 获取节点所属的父目录路径 */
function getParentDir(nodePath: string): string {
  const normalized = nodePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash > 0 ? normalized.substring(0, lastSlash) : ''
}

interface TreeNodeProps {
  node: FileTreeNode
  depth: number
  rootPath: string
  onCreateNew: (dirPath: string, type: 'file' | 'directory') => void
}

function TreeNodeItem({ node, depth, rootPath, onCreateNew }: TreeNodeProps): JSX.Element {
  const expandNode = useWorkspaceStore((s) => s.expandNode)
  const collapseNode = useWorkspaceStore((s) => s.collapseNode)
  const openTab = useTabStore((s) => s.openTab)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
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
      openTab(node.path, node.name, result.content, result.language)
      window.dispatchEvent(new CustomEvent('wzxclaw:file-opened'))
    } catch (err) {
      console.error('Failed to open file:', err)
    }
  }, [node.path, node.name, openTab])

  const handleClick = useCallback(() => {
    if (node.isDirectory) handleDirectoryClick()
    else handleFileClick()
  }, [node.isDirectory, handleDirectoryClick, handleFileClick])

  const handleRenameCommit = useCallback(async () => {
    const trimmed = renameValue.trim()
    if (!trimmed || trimmed === node.name) {
      setRenaming(false)
      return
    }
    const dirPath = getParentDir(node.path)
    const newPath = dirPath ? `${dirPath}/${trimmed}` : trimmed
    try {
      const result = await window.wzxclaw.renameFile({ oldPath: node.path, newPath })
      if (result.success && dirPath) {
        useWorkspaceStore.getState().expandNode(dirPath)
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
        const dirPath = getParentDir(node.path)
        if (dirPath) useWorkspaceStore.getState().expandNode(dirPath)
      }
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }, [node.path, node.name])

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(node.path)
  }, [node.path])

  const handleCopyRelativePath = useCallback(() => {
    const rel = node.path.replace(/\\/g, '/').replace(rootPath.replace(/\\/g, '/') + '/', '')
    navigator.clipboard.writeText(rel)
  }, [node.path, rootPath])

  const handleRevealInExplorer = useCallback(() => {
    window.wzxclaw.openInExplorer(node.path)
  }, [node.path])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!node.isDirectory) {
      return [
        { label: '打开', onClick: handleFileClick },
        { label: '重命名', shortcut: 'F2', onClick: () => { setRenameValue(node.name); setRenaming(true) } },
        { label: '复制路径', onClick: handleCopyPath },
        { label: '复制相对路径', onClick: handleCopyRelativePath },
        { label: '在文件管理器中显示', onClick: handleRevealInExplorer },
        { separator: true, label: '', onClick: () => {} },
        { label: '删除', shortcut: 'Del', onClick: handleDelete },
      ]
    }
    return [
      { label: '新建文件', onClick: () => onCreateNew(node.path, 'file') },
      { label: '新建文件夹', onClick: () => onCreateNew(node.path, 'directory') },
      { separator: true, label: '', onClick: () => {} },
      { label: '重命名', shortcut: 'F2', onClick: () => { setRenameValue(node.name); setRenaming(true) } },
      { label: '复制路径', onClick: handleCopyPath },
      { label: '复制相对路径', onClick: handleCopyRelativePath },
      { label: '在文件管理器中显示', onClick: handleRevealInExplorer },
      { separator: true, label: '', onClick: () => {} },
      { label: '删除', shortcut: 'Del', onClick: handleDelete },
    ]
  }, [node, handleFileClick, onCreateNew, handleCopyPath, handleCopyRelativePath, handleRevealInExplorer, handleDelete])

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renaming])

  const dirIcon = node.isExpanded ? '\u25BE' : '\u25B8'
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

      {node.isDirectory && node.isExpanded && node.children && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              rootPath={rootPath}
              onCreateNew={onCreateNew}
            />
          ))}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}

export default function FileExplorer(): JSX.Element {
  const tree = useWorkspaceStore((s) => s.tree)
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const collapseAll = useWorkspaceStore((s) => s.collapseAll)
  const loadTree = useWorkspaceStore((s) => s.loadTree)
  const expandNode = useWorkspaceStore((s) => s.expandNode)

  const [filterQuery, setFilterQuery] = useState('')
  const [creatingNew, setCreatingNew] = useState<{ dirPath: string; type: 'file' | 'directory' } | null>(null)
  const [newName, setNewName] = useState('')
  const [newInputKey, setNewInputKey] = useState(0) // 用于强制重新挂载 input
  const newInputRef = useRef<HTMLInputElement>(null)

  // 搜索过滤
  const displayTree = useMemo(() => {
    if (!filterQuery.trim()) return tree
    return filterTree(tree, filterQuery.trim())
  }, [tree, filterQuery])

  // 自动聚焦新建输入框
  useEffect(() => {
    if (creatingNew && newInputRef.current) {
      newInputRef.current.focus()
    }
  }, [creatingNew, newInputKey])

  const handleCreateNew = useCallback((dirPath: string, type: 'file' | 'directory') => {
    setCreatingNew({ dirPath, type })
    setNewName('')
    setNewInputKey(k => k + 1)
  }, [])

  const handleCommitNew = useCallback(async () => {
    if (!creatingNew || !newName.trim()) {
      setCreatingNew(null)
      return
    }
    try {
      const result = await window.wzxclaw.createFile({
        dirPath: creatingNew.dirPath,
        name: newName.trim(),
        type: creatingNew.type,
      })
      if (result.success) {
        // 刷新父目录
        await expandNode(creatingNew.dirPath)
        // 如果是文件，直接打开
        if (creatingNew.type === 'file') {
          const fullPath = result.filePath.replace(/\\/g, '/')
          const fileName = newName.trim()
          try {
            const content = await window.wzxclaw.readFile({ filePath: fullPath })
            useTabStore.getState().openTab(fullPath, fileName, content.content, content.language)
            window.dispatchEvent(new CustomEvent('wzxclaw:file-opened'))
          } catch {
            // ignore read error for empty files
          }
        }
      }
    } catch (err) {
      console.error('Failed to create:', err)
    }
    setCreatingNew(null)
  }, [creatingNew, newName])

  const handleRefresh = useCallback(async () => {
    if (rootPath) {
      await loadTree(rootPath, 1)
    }
  }, [rootPath, loadTree])

  if (tree.length === 0) {
    return <div style={{ padding: 12, color: 'var(--text-secondary)' }}>Empty workspace</div>
  }

  const isMultiRoot = tree.length > 1 && tree.every((n) => n.isDirectory)

  return (
    <div className="file-explorer">
      {/* 工具栏 */}
      <div className="explorer-toolbar">
        <button className="explorer-toolbar-btn" title="新建文件" onClick={() => handleCreateNew(rootPath ?? '', 'file')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button className="explorer-toolbar-btn" title="新建文件夹" onClick={() => handleCreateNew(rootPath ?? '', 'directory')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <button className="explorer-toolbar-btn" title="折叠全部" onClick={collapseAll}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
        <button className="explorer-toolbar-btn" title="刷新" onClick={handleRefresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* 搜索过滤 */}
      <div className="explorer-search">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="过滤文件..."
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
        {filterQuery && (
          <button className="explorer-search-clear" onClick={() => setFilterQuery('')}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* 新建输入框 */}
      {creatingNew && (
        <div className="explorer-new-item">
          <span className="tree-icon file-icon file-icon-config" style={{ fontSize: 9, fontWeight: 700 }}>
            {creatingNew.type === 'file' ? '{}' : '📁'}
          </span>
          <input
            key={newInputKey}
            ref={newInputRef}
            className="tree-rename-input"
            value={newName}
            placeholder={creatingNew.type === 'file' ? '文件名...' : '文件夹名...'}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={handleCommitNew}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCommitNew()
              if (e.key === 'Escape') setCreatingNew(null)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* 文件树 */}
      {displayTree.length === 0 && filterQuery ? (
        <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
          没有匹配的文件
        </div>
      ) : (
        displayTree.map((node) => (
          <div key={node.path} className={isMultiRoot ? 'file-explorer-root-section' : undefined}>
            {isMultiRoot && (
              <div className="file-explorer-root-header" title={node.path}>
                <span className="file-explorer-root-label">{node.name.toUpperCase()}</span>
              </div>
            )}
            <TreeNodeItem node={node} depth={0} rootPath={rootPath ?? ''} onCreateNew={handleCreateNew} />
          </div>
        ))
      )}
    </div>
  )
}

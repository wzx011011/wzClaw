// ============================================================
// FileExplorer — 文件树浏览器
//
// 递归渲染文件树，支持展开/折叠、搜索过滤。
// 文件操作通过 DataSource.fs 通道。
// ============================================================

import React, { useState, useEffect, useCallback } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'
import { useTabStore } from '../../stores/tab-store'
import type { FileTreeNode } from '../../data-source/types'

/** 文件图标映射 */
function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const icons: Record<string, string> = {
    ts: '📘', tsx: '📘', js: '📙', jsx: '📙',
    json: '📋', md: '📝', css: '🎨', scss: '🎨',
    html: '🌐', py: '🐍', rs: '🦀', go: '🐹',
    yaml: '⚙️', yml: '⚙️', toml: '⚙️', sh: '🖥️',
    gitignore: '🚫', env: '🔒',
  }
  return icons[ext] ?? '📄'
}

/** 树节点状态 */
interface TreeNodeState {
  expanded: boolean
  children: FileTreeNode[]
  loaded: boolean
}

export default function FileExplorer(): React.ReactElement {
  const dataSource = useDataSource()
  const openFile = useTabStore((s) => s.openFile)
  const [rootNodes, setRootNodes] = useState<FileTreeNode[]>([])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [nodeChildren, setNodeChildren] = useState<Map<string, FileTreeNode[]>>(new Map())
  const [searchFilter, setSearchFilter] = useState('')
  const [loading, setLoading] = useState(false)

  // 加载根目录
  useEffect(() => {
    async function loadRoot() {
      if (!dataSource?.fs) return
      setLoading(true)
      try {
        const nodes = await dataSource.fs.tree('/', 1)
        setRootNodes(nodes)
      } catch (err) {
        console.error('FileExplorer: 加载根目录失败', err)
      } finally {
        setLoading(false)
      }
    }
    loadRoot()
  }, [dataSource?.fs])

  // 切换展开/折叠
  const toggleExpand = useCallback(async (node: FileTreeNode) => {
    if (node.type !== 'directory') return

    const newPath = new Set(expandedPaths)
    if (newPath.has(node.path)) {
      newPath.delete(node.path)
      setExpandedPaths(newPath)
    } else {
      newPath.add(node.path)
      setExpandedPaths(newPath)

      // 懒加载子节点
      if (!nodeChildren.has(node.path) && dataSource?.fs) {
        try {
          const children = await dataSource.fs.tree(node.path, 1)
          setNodeChildren((prev) => new Map(prev).set(node.path, children))
        } catch (err) {
          console.error('FileExplorer: 加载子目录失败', err)
        }
      }
    }
  }, [expandedPaths, nodeChildren, dataSource?.fs])

  // 打开文件
  const handleFileClick = useCallback(async (node: FileTreeNode) => {
    if (node.type !== 'file' || !dataSource?.fs) return
    try {
      const { content } = await dataSource.fs.readFile(node.path)
      openFile(node.path, content)
    } catch (err) {
      console.error('FileExplorer: 读取文件失败', err)
    }
  }, [dataSource?.fs, openFile])

  // 过滤节点
  const filterNodes = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
    if (!searchFilter) return nodes
    return nodes.filter((n) =>
      n.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
      (n.type === 'directory' && n.children?.some?.((c) =>
        c.name.toLowerCase().includes(searchFilter.toLowerCase())
      ))
    )
  }, [searchFilter])

  // 渲染树节点
  function renderNode(node: FileTreeNode, depth: number): React.ReactElement {
    const isExpanded = expandedPaths.has(node.path)
    const children = nodeChildren.get(node.path) ?? node.children ?? []
    const filteredChildren = filterNodes(children)
    const matchesFilter = searchFilter
      ? node.name.toLowerCase().includes(searchFilter.toLowerCase())
      : true

    return (
      <div key={node.path}>
        <div
          onClick={(e) => {
            e.stopPropagation()
            if (node.type === 'directory') {
              toggleExpand(node)
            } else {
              handleFileClick(node)
            }
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px 2px ' + (depth * 16 + 8) + 'px',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            opacity: matchesFilter ? 1 : 0.4,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        >
          {/* 展开/折叠箭头 */}
          {node.type === 'directory' ? (
            <span style={{
              fontSize: '10px',
              width: '12px',
              textAlign: 'center',
              transition: 'transform 0.15s',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}>
              ▶
            </span>
          ) : (
            <span style={{ width: '12px' }} />
          )}
          <span>{node.type === 'directory' ? '📁' : getFileIcon(node.name)}</span>
          <span>{node.name}</span>
        </div>
        {/* 递归渲染子节点 */}
        {isExpanded && filteredChildren.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      {/* 标题 + 搜索 */}
      <div style={{
        padding: 'var(--sp-2) var(--sp-3)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-1)',
      }}>
        <div style={{
          fontSize: 'var(--font-size-xs)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          资源管理器
        </div>
        <input
          type="text"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          placeholder="搜索文件..."
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '4px 8px',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-primary)',
            outline: 'none',
            width: '100%',
          }}
        />
      </div>

      {/* 文件树 */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: 'var(--sp-1) 0',
      }}>
        {loading ? (
          <div style={{
            padding: 'var(--sp-3)',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-size-xs)',
            textAlign: 'center',
          }}>
            加载中...
          </div>
        ) : rootNodes.length === 0 ? (
          <div style={{
            padding: 'var(--sp-3)',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-size-xs)',
            textAlign: 'center',
          }}>
            {dataSource?.fs ? '无文件' : '文件系统不可用'}
          </div>
        ) : (
          filterNodes(rootNodes).map((node) => renderNode(node, 0))
        )}
      </div>
    </div>
  )
}

// ============================================================
// DataSourceProvider — React Context 提供 DataSource 实例
//
// 职责：
// - 根据环境创建 DataSource（WebSocket 或 IPC）
// - 管理 DataSource 生命周期（connect / disconnect）
// - 配置变更时重建 DataSource
// - 提供 useDataSource() hook 供子组件获取实例
// - 提供 useConnectionState() hook 获取连接状态
// ============================================================

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { createDataSource } from '../data-source'
import type { DataSource } from '../data-source/types'

/** DataSource Context */
const DataSourceContext = createContext<DataSource | null>(null)

/** 连接状态 Context */
const ConnectionStateContext = createContext<boolean>(false)

/** 配置变更触发器类型 — 父组件通过此函数通知 Provider 重建 DataSource */
export type ReconnectTrigger = (agentUrl: string, token?: string) => void

/** 重连触发器 Context */
const ReconnectContext = createContext<ReconnectTrigger>(() => {})

/** DataSourceProvider Props */
interface DataSourceProviderProps {
  /** 初始 Agent Server URL */
  initialUrl?: string
  /** 初始 Token */
  initialToken?: string
  /** 子组件 */
  children: React.ReactNode
}

/**
 * DataSourceProvider — 管理 DataSource 实例并提供给组件树
 *
 * 生命周期：
 * 1. 挂载时创建 DataSource 并连接
 * 2. 配置变更时断开旧连接，创建新 DataSource，重新连接
 * 3. 卸载时断开连接
 */
export function DataSourceProvider({
  initialUrl,
  initialToken,
  children,
}: DataSourceProviderProps): React.ReactElement {
  const [dataSource, setDataSource] = useState<DataSource | null>(null)
  const [connected, setConnected] = useState(false)
  const dsRef = useRef<DataSource | null>(null)

  /**
   * 创建 DataSource 并连接
   */
  const connectDataSource = useCallback(async (url?: string, token?: string) => {
    // 断开旧连接
    if (dsRef.current) {
      dsRef.current.disconnect()
      dsRef.current = null
    }

    setConnected(false)

    // 创建新 DataSource
    const ds = createDataSource(url, token)
    dsRef.current = ds
    setDataSource(ds)

    // 监听连接状态
    ds.onConnectionChange((isConnected) => {
      setConnected(isConnected)
    })

    // 尝试连接
    try {
      await ds.connect()
    } catch {
      // 连接失败，状态已通过 onConnectionChange 更新
    }
  }, [])

  /**
   * 重连触发器 — 配置变更时调用
   */
  const triggerReconnect = useCallback((agentUrl: string, token?: string) => {
    connectDataSource(agentUrl, token)
  }, [connectDataSource])

  // 挂载时初始化
  useEffect(() => {
    connectDataSource(initialUrl, initialToken)

    return () => {
      // 卸载时断开
      if (dsRef.current) {
        dsRef.current.disconnect()
        dsRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <DataSourceContext.Provider value={dataSource}>
      <ConnectionStateContext.Provider value={connected}>
        <ReconnectContext.Provider value={triggerReconnect}>
          {children}
        </ReconnectContext.Provider>
      </ConnectionStateContext.Provider>
    </DataSourceContext.Provider>
  )
}

/**
 * useDataSource — 获取 DataSource 实例
 *
 * 在 DataSourceProvider 内部使用。
 * 返回 null 表示 Provider 尚未初始化。
 */
export function useDataSource(): DataSource | null {
  return useContext(DataSourceContext)
}

/**
 * useConnectionState — 获取连接状态
 *
 * 返回 true 表示已连接，false 表示未连接。
 */
export function useConnectionState(): boolean {
  return useContext(ConnectionStateContext)
}

/**
 * useReconnect — 获取重连触发器
 *
 * 配置变更时调用此函数重建 DataSource 并连接。
 */
export function useReconnect(): ReconnectTrigger {
  return useContext(ReconnectContext)
}

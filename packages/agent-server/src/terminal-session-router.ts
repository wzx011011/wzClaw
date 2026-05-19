// ============================================================
// TerminalSessionRouter — terminalId 路由表
// 跟踪 terminalId 与 clientWs / handId 的映射，用于：
// - terminal:data / terminal:exit 从 Hand 推送到正确的 client
// - terminal:write/resize/kill 路由到原始的 Hand
// - 客户端或 Hand 断连时清理对应资源
// ============================================================

import type { WebSocket } from 'ws'

interface TerminalEntry {
  clientWs: WebSocket
  handId: string
}

export class TerminalSessionRouter {
  private readonly terminals = new Map<string, TerminalEntry>()

  /** 注册 terminalId 与 client/hand 的绑定 */
  register(terminalId: string, clientWs: WebSocket, handId: string): void {
    this.terminals.set(terminalId, { clientWs, handId })
  }

  /** 注销 terminalId */
  unregister(terminalId: string): void {
    this.terminals.delete(terminalId)
  }

  /** 获取 terminalId 对应的客户端 ws；未注册时返回 null */
  getClient(terminalId: string): WebSocket | null {
    return this.terminals.get(terminalId)?.clientWs ?? null
  }

  /** 获取 terminalId 对应的 handId；未注册时返回 null */
  getHandId(terminalId: string): string | null {
    return this.terminals.get(terminalId)?.handId ?? null
  }

  /** 返回属于指定客户端的所有 terminalId（用于客户端断连时清理） */
  getTerminalsForClient(clientWs: WebSocket): string[] {
    const ids: string[] = []
    for (const [id, entry] of this.terminals) {
      if (entry.clientWs === clientWs) ids.push(id)
    }
    return ids
  }

  /** 返回属于指定 Hand 的所有 terminalId（用于 Hand 断连时清理） */
  getTerminalsForHand(handId: string): string[] {
    const ids: string[] = []
    for (const [id, entry] of this.terminals) {
      if (entry.handId === handId) ids.push(id)
    }
    return ids
  }

  /** 当前已注册 terminal 总数（用于测试） */
  size(): number {
    return this.terminals.size
  }
}

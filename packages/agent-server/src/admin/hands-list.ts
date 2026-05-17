import type { ServerResponse, IncomingMessage } from 'http'
import type { HandsRouter, HandEntry } from '../hands-router.js'

interface HandInfo {
  id: string
  type: 'desktop' | 'docker'
  capabilities: string[]
  priority: number
  lastHeartbeat: number
}

export function handleHandsList(
  _req: IncomingMessage,
  res: ServerResponse,
  handsRouter: HandsRouter
): void {
  const hands: HandEntry[] = handsRouter.getAllHands()
  const now = Date.now()
  const healthy = hands.filter((h) => now - (h.lastHeartbeat || 0) < 30000)

  const result: HandInfo[] = healthy.map((h) => ({
    id: h.id || 'unknown',
    type: (h.id?.includes('docker') || h.id?.includes('nas')) ? 'docker' as const : 'desktop' as const,
    capabilities: h.capabilities || [],
    priority: h.priority || 0,
    lastHeartbeat: h.lastHeartbeat || 0,
  }))

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

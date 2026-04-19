import { EventEmitter } from 'events'
import WebSocket from 'ws'

const RELAY_URL = 'wss://relay.5945.top/'
const HEARTBEAT_INTERVAL = 15_000
const HEARTBEAT_TIMEOUT = 8_000
const RECONNECT_BASE = 1_000
const RECONNECT_MAX = 30_000
const JITTER_MAX = 500

export interface RelayStatus {
  connected: boolean
  connecting: boolean
  reconnectAttempt: number
  mobileConnected: boolean
  mobileIdentity: string | null
}

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null
  private token = ''
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private _connected = false
  private _connecting = false
  private disposed = false
  private _mobileConnected = false
  private _mobileIdentity: string | null = null

  get connected(): boolean {
    return this._connected
  }

  connect(token: string): void {
    this.token = token
    this.reconnectAttempt = 0
    this._doConnect()
  }

  disconnect(): void {
    this._mobileConnected = false
    this._mobileIdentity = null
    this.reconnectAttempt = 0
    this._clearTimers()
    this._closeWs()
    this._updateState(false, false)
    this.emitStatus()
  }

  broadcast(event: string, data: unknown): void {
    this._send(JSON.stringify({ event, data }))
  }

  getStatus(): RelayStatus {
    return {
      connected: this._connected,
      connecting: this._connecting,
      reconnectAttempt: this.reconnectAttempt,
      mobileConnected: this._mobileConnected,
      mobileIdentity: this._mobileIdentity,
    }
  }

  dispose(): void {
    this.disposed = true
    this.disconnect()
  }

  private _doConnect(): void {
    if (this.disposed || !this.token) return
    // Guard against concurrent connection attempts
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return

    this._clearTimers()
    this._closeWs()
    this._updateState(false, true)
    this.emitStatus()

    const url = `${RELAY_URL}?role=desktop&token=${encodeURIComponent(this.token)}`

    try {
      this.ws = new WebSocket(url)
    } catch {
      this._scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      console.log('[RelayClient] connected')
      this._updateState(true, false)
      this.reconnectAttempt = 0
      this._startHeartbeat()
      this.emitStatus()
      // Announce desktop identity to mobile
      this._send(JSON.stringify({
        event: 'identity:announce',
        data: { name: 'wzxClaw', platform: process.platform }
      }))
    })

    this.ws.on('message', (raw: WebSocket.Data) => {
      const rawStr = typeof raw === 'string' ? raw : raw.toString()
      try {
        const msg = JSON.parse(rawStr)
        const event = msg.event as string

        if (event === 'pong') {
          // Clear heartbeat timeout — server is alive
          if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer)
            this.heartbeatTimeoutTimer = null
          }
          return
        }

        // Mobile identity announcement
        if (event === 'identity:mobile_announce') {
          this._mobileIdentity = msg.data?.name ?? 'Unknown'
          this.emitStatus()
          return
        }

        // System events from relay
        if (event === 'system:mobile_connected') {
          this._mobileConnected = true
          this.emitStatus()
          this.emit('mobile-connected')
          return
        }
        if (event === 'system:mobile_disconnected') {
          this._mobileConnected = false
          this._mobileIdentity = null
          this.emitStatus()
          return
        }
        if (event === 'system:desktop_disconnected') {
          return
        }

        // Forward to app as client-message (same shape as MobileServer)
        this.emit('client-message', {
          clientId: 'relay-mobile',
          event,
          data: msg.data
        })
      } catch {
        // ignore malformed JSON
      }
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log('[RelayClient] close code=%d reason=%s', code, reason?.toString() || '')
      this._stopHeartbeat()
      // 4001 = invalid token — do NOT reconnect, clear saved token
      if (code === 4001) {
        console.warn('[RelayClient] token rejected by server, stopping reconnect')
        this._updateState(false, false)
        this.emitStatus()
        return
      }
      if (!this.disposed && (this._connected || this._connecting)) {
        this._updateState(false, false)
        this._scheduleReconnect()
      }
    })

    this.ws.on('error', (err: Error) => {
      console.error('[RelayClient] error:', err.message)
      // handled by close
    })
  }

  private _send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data)
      } catch {
        // ignore
      }
    }
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this._send(JSON.stringify({ event: 'ping' }))
      this.heartbeatTimeoutTimer = setTimeout(() => {
        // Pong timeout — force reconnect
        this._closeWs()
        this._updateState(false, false)
        this._scheduleReconnect()
      }, HEARTBEAT_TIMEOUT)
    }, HEARTBEAT_INTERVAL)
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = null
    }
  }

  private _scheduleReconnect(): void {
    if (this.disposed) return
    // Correctly cancel any pending reconnect timer before scheduling a new one
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const baseMs = Math.min(RECONNECT_BASE * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX)
    const jitter = Math.floor(Math.random() * JITTER_MAX)
    this.reconnectAttempt++
    this._updateState(false, false)
    this.emitStatus()
    this.reconnectTimer = setTimeout(() => this._doConnect(), baseMs + jitter)
  }

  private _closeWs(): void {
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.removeAllListeners()
      // Add noop error handler AFTER removeAllListeners to prevent
      // 'WebSocket closed before connection established' from becoming
      // an unhandled error event that crashes the main process.
      ws.on('error', () => {})
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }

  private _clearTimers(): void {
    this._stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private _updateState(connected: boolean, connecting: boolean): void {
    this._connected = connected
    this._connecting = connecting
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}

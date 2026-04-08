import type { AddressInfo } from 'net'
import https from 'https'
import http from 'http'

/**
 * TunnelManager — creates a public URL for the local mobile server
 * using localtunnel, enabling WAN access.
 * Includes retry logic and post-open verification.
 */
export class TunnelManager {
  private tunnel: any = null
  private _url: string | null = null

  get url(): string | null {
    return this._url
  }

  get isConnected(): boolean {
    return this.tunnel !== null && this._url !== null
  }

  /**
   * Open a tunnel to expose the given local port to the internet.
   * Retries up to 3 times with 2s backoff. Verifies tunnel reachability.
   * Returns the public URL.
   */
  async open(localPort: number): Promise<string> {
    if (this.tunnel) {
      await this.close()
    }

    const maxRetries = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const localtunnel = require('localtunnel')
        this.tunnel = await localtunnel({
          port: localPort,
          local_host: '127.0.0.1'
        })
        this._url = this.tunnel.url

        this.tunnel.on('close', () => {
          this._url = null
          this.tunnel = null
        })

        this.tunnel.on('error', (err: Error) => {
          console.error('[TunnelManager] Tunnel error:', err.message)
        })

        // Verify tunnel is reachable with a quick HTTP GET
        const reachable = await this.verifyTunnel(this._url!)
        if (reachable) {
          return this._url!
        }

        // Tunnel opened but not reachable — close and retry
        console.warn(`[TunnelManager] Tunnel not reachable (attempt ${attempt}/${maxRetries})`)
        this.tunnel.close()
        this.tunnel = null
        this._url = null
        lastError = new Error('Tunnel created but not reachable')
      } catch (err: any) {
        lastError = err
        console.warn(`[TunnelManager] Attempt ${attempt}/${maxRetries} failed:`, err.message)
        this.tunnel = null
        this._url = null
      }

      // Wait before retry (except on last attempt)
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    throw lastError ?? new Error('Failed to create tunnel after retries')
  }

  async close(): Promise<void> {
    if (this.tunnel) {
      this.tunnel.close()
      this.tunnel = null
      this._url = null
    }
  }

  /**
   * Quick HTTP GET to verify tunnel URL is reachable.
   * Returns true if we get any response (even 4xx), false on network error/timeout.
   */
  private verifyTunnel(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000)
      const getter = url.startsWith('https') ? https.get : http.get
      const req = getter(url, (res) => {
        clearTimeout(timeout)
        res.resume() // drain response
        resolve(true)
      })
      req.on('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })
  }
}

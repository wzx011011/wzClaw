// ============================================================
// L4 E2E Harness — Relay Fixture
// ============================================================
// Forks the real `relay/server.js` as a child Node process on an
// ephemeral port, isolated from production deployment. Returns the
// chosen port + a teardown function.
//
// Each scenario gets its own relay instance for hermetic isolation.
// ============================================================

import { fork, type ChildProcess } from 'child_process'
import path from 'path'
import net from 'net'

export interface RelayHandle {
  port: number
  url: string
  proc: ChildProcess
  close(): Promise<void>
}

/** Pick a free TCP port by binding to 0 and reading back the assigned port. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Failed to allocate port')))
      }
    })
  })
}

/** Wait until the relay's HTTP /health endpoint responds 200. */
async function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Relay did not become ready within ${timeoutMs}ms on port ${port}`)
}

/**
 * Start a real relay server in a forked child process.
 *
 * The child enables explicit dev-mode auth for hermetic local testing.
 * PORT is set to the chosen free port.
 */
export async function startRelay(): Promise<RelayHandle> {
  const port = await pickFreePort()
  // Path to repo-root relay/server.js. This file lives at
  //   wzxClaw_desktop/src/main/__tests__/e2e-session/harness/
  // so we go up six levels to repo root.
  const serverPath = path.resolve(
    __dirname,
    '../../../../../../relay/server.js',
  )

  const proc = fork(serverPath, [], {
    env: {
      ...process.env,
      PORT: String(port),
      // Force dev-mode auth: any non-empty token accepted
      AUTH_TOKEN: '',
      RELAY_ALLOW_DEV_AUTH: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    silent: true,
  })

  // Surface child output for debugging when DEBUG_E2E env var is set
  if (process.env.DEBUG_E2E) {
    proc.stdout?.on('data', (d) => process.stdout.write(`[relay-${port}] ${d}`))
    proc.stderr?.on('data', (d) => process.stderr.write(`[relay-${port}] ${d}`))
  }

  await waitForReady(port)

  const close = (): Promise<void> => {
    return new Promise((resolve) => {
      if (!proc.connected && proc.exitCode !== null) {
        resolve()
        return
      }
      const onExit = () => resolve()
      proc.once('exit', onExit)
      proc.kill('SIGTERM')
      // Force-kill if it doesn't exit in 2s
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }, 2000)
    })
  }

  return {
    port,
    url: `ws://127.0.0.1:${port}/`,
    proc,
    close,
  }
}

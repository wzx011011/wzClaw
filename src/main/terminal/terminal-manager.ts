// ============================================================
// TerminalManager — PTY lifecycle manager for terminal panel
// (per TERM-01 through TERM-07)
// ============================================================

import { TERMINAL_BUFFER_SIZE, TERMINAL_DEFAULT_COLS, TERMINAL_DEFAULT_ROWS } from '../../shared/constants'

interface TerminalEntry {
  pty: import('node-pty').IPty
  buffer: string
  cols: number
  rows: number
}

// Lazily loaded node-pty module (native module, may fail to load)
let ptyModule: typeof import('node-pty') | null = null
let ptyLoadAttempted = false

function getPtyModule(): typeof import('node-pty') | null {
  if (ptyLoadAttempted) return ptyModule
  ptyLoadAttempted = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty')
  } catch (err) {
    console.warn('node-pty failed to load. Terminal panel will not be available.', err)
  }
  return ptyModule
}

export class TerminalManager {
  private terminals: Map<string, TerminalEntry> = new Map()
  private nextId: number = 1
  private dataCallbacks: Map<string, Set<(data: string) => void>> = new Map()

  /**
   * Spawn a new PTY process and return its ID.
   * On Windows uses COMSPEC or cmd.exe; on other platforms uses SHELL or /bin/bash.
   */
  createTerminal(cwd: string, cols: number = TERMINAL_DEFAULT_COLS, rows: number = TERMINAL_DEFAULT_ROWS): string {
    const pty = getPtyModule()
    if (!pty) {
      throw new Error('node-pty module is not available. Cannot create terminal.')
    }

    const id = `term-${this.nextId++}`
    const isWindows = process.platform === 'win32'
    const shell = isWindows
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/bash')

    const ptyProcess = pty.spawn(shell, [], {
      cwd,
      cols,
      rows,
      name: 'xterm-256color',
      ...(isWindows ? { useConpty: true, conptyInheritCursor: true } : {})
    })

    const entry: TerminalEntry = {
      pty: ptyProcess,
      buffer: '',
      cols,
      rows
    }

    this.terminals.set(id, entry)

    // Wire PTY output to buffer and callbacks
    ptyProcess.onData((data: string) => {
      entry.buffer += data
      // Trim buffer from start if it exceeds max size
      if (entry.buffer.length > TERMINAL_BUFFER_SIZE) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - TERMINAL_BUFFER_SIZE)
      }
      // Notify all subscribers
      const callbacks = this.dataCallbacks.get(id)
      if (callbacks) {
        for (const cb of callbacks) {
          cb(data)
        }
      }
    })

    return id
  }

  /**
   * Kill a terminal process and remove it from the map.
   */
  killTerminal(id: string): void {
    const entry = this.terminals.get(id)
    if (entry) {
      entry.pty.kill()
      this.terminals.delete(id)
      this.dataCallbacks.delete(id)
    }
  }

  /**
   * Write data to a terminal's PTY stdin.
   */
  writeToTerminal(id: string, data: string): void {
    const entry = this.terminals.get(id)
    if (entry) {
      entry.pty.write(data)
    }
  }

  /**
   * Subscribe to PTY output for a given terminal.
   * Returns an unsubscribe function.
   */
  onTerminalData(id: string, callback: (data: string) => void): () => void {
    let callbacks = this.dataCallbacks.get(id)
    if (!callbacks) {
      callbacks = new Set()
      this.dataCallbacks.set(id, callbacks)
    }
    callbacks.add(callback)
    return () => {
      callbacks!.delete(callback)
      if (callbacks!.size === 0) {
        this.dataCallbacks.delete(id)
      }
    }
  }

  /**
   * Get the current output buffer for a terminal (for agent analysis).
   */
  getOutputBuffer(id: string): string {
    const entry = this.terminals.get(id)
    return entry ? entry.buffer : ''
  }

  /**
   * Resize a terminal's PTY.
   */
  resizeTerminal(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id)
    if (entry) {
      entry.pty.resize(cols, rows)
      entry.cols = cols
      entry.rows = rows
    }
  }

  /**
   * Get the first active terminal ID (for agent command routing).
   */
  getActiveTerminalId(): string | null {
    const keys = Array.from(this.terminals.keys())
    return keys.length > 0 ? keys[0] : null
  }

  /**
   * Run a command in a terminal and capture output for agent analysis.
   * Writes command + newline, then captures output for up to 30 seconds.
   */
  async runCommandInTerminal(id: string, command: string): Promise<string> {
    const entry = this.terminals.get(id)
    if (!entry) {
      return `Error: Terminal ${id} not found`
    }

    // Record the buffer length before the command
    const bufferBefore = entry.buffer.length

    // Write the command to the PTY
    entry.pty.write(command + '\r\n')

    // Wait and collect output for up to 30 seconds
    const CAPTURE_TIMEOUT = 30000
    const CHECK_INTERVAL = 200

    return new Promise<string>((resolve) => {
      const startTime = Date.now()
      let capturedOutput = ''

      const collectOutput = (data: string): void => {
        capturedOutput += data
      }

      // Subscribe to data events
      const unsub = this.onTerminalData(id, collectOutput)

      const timer = setInterval(() => {
        const elapsed = Date.now() - startTime
        // If we have output and enough time passed for the command to complete
        if (elapsed > 2000 && capturedOutput.length > 0) {
          // Check if output seems stable (no new data for 500ms)
          // For simplicity, we resolve after timeout or a reasonable wait
        }
        if (elapsed >= CAPTURE_TIMEOUT) {
          clearInterval(timer)
          unsub()
          // Also include buffer content that accumulated since the command
          const fullBuffer = entry.buffer.slice(bufferBefore)
          resolve(fullBuffer || capturedOutput)
        }
      }, CHECK_INTERVAL)

      // Early exit if the command is simple and we get output quickly
      setTimeout(() => {
        // Check after 3 seconds if we have any output
        if (capturedOutput.length > 0) {
          // Don't resolve yet, wait for more output or timeout
        }
      }, 3000)
    })
  }

  /**
   * Kill all terminals and clean up.
   */
  dispose(): void {
    for (const [id] of this.terminals) {
      this.killTerminal(id)
    }
    this.terminals.clear()
    this.dataCallbacks.clear()
  }
}

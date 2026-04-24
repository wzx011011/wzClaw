import { describe, it, expect, beforeAll } from 'vitest'
import { TerminalManager } from '../terminal-manager'

// Skip PTY-dependent tests unless TERMINAL_TESTS env is set
// (node-pty may not rebuild for Electron in CI without Visual Studio)
const describeWithPty = process.env.TERMINAL_TESTS ? describe : describe.skip

describe('TerminalManager', () => {
  describe('Unit tests (no PTY required)', () => {
    it('getOutputBuffer returns empty string for unknown terminal', () => {
      const manager = new TerminalManager()
      expect(manager.getOutputBuffer('nonexistent')).toBe('')
    })

    it('killTerminal does not throw for unknown terminal', () => {
      const manager = new TerminalManager()
      expect(() => manager.killTerminal('nonexistent')).not.toThrow()
    })

    it('writeToTerminal does not throw for unknown terminal', () => {
      const manager = new TerminalManager()
      expect(() => manager.writeToTerminal('nonexistent', 'test')).not.toThrow()
    })

    it('resizeTerminal does not throw for unknown terminal', () => {
      const manager = new TerminalManager()
      expect(() => manager.resizeTerminal('nonexistent', 120, 40)).not.toThrow()
    })

    it('getActiveTerminalId returns null when no terminals exist', () => {
      const manager = new TerminalManager()
      expect(manager.getActiveTerminalId()).toBeNull()
    })

    it('dispose clears all terminals without error', () => {
      const manager = new TerminalManager()
      expect(() => manager.dispose()).not.toThrow()
    })
  })

  describeWithPty('PTY integration tests', () => {
    let manager: TerminalManager

    beforeAll(() => {
      manager = new TerminalManager()
    })

    it('createTerminal returns a string id', () => {
      const id = manager.createTerminal(process.cwd())
      expect(typeof id).toBe('string')
      expect(id).toMatch(/^term-\d+$/)
      manager.killTerminal(id)
    })

    it('getActiveTerminalId returns the first terminal id', () => {
      const id = manager.createTerminal(process.cwd())
      expect(manager.getActiveTerminalId()).toBe(id)
      manager.killTerminal(id)
    })

    it('killTerminal removes terminal from map', () => {
      const id = manager.createTerminal(process.cwd())
      manager.killTerminal(id)
      expect(manager.getActiveTerminalId()).toBeNull()
    })

    it('writeToTerminal does not throw for valid terminal', () => {
      const id = manager.createTerminal(process.cwd())
      expect(() => manager.writeToTerminal(id, 'echo hello\r\n')).not.toThrow()
      manager.killTerminal(id)
    })

    it('onTerminalData receives output callback', async () => {
      const id = manager.createTerminal(process.cwd())
      const receivedData: string[] = []
      const unsub = manager.onTerminalData(id, (data) => {
        receivedData.push(data)
      })

      // Write a command that produces output
      manager.writeToTerminal(id, 'echo test_terminal_output\r\n')

      // Wait for output
      await new Promise((resolve) => setTimeout(resolve, 2000))

      unsub()
      manager.killTerminal(id)

      // Should have received some data (shell prompt + echo output)
      expect(receivedData.length).toBeGreaterThan(0)
    })
  })
})

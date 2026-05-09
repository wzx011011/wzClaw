// ============================================================
// SshExecutor — 远程命令执行 + 流式输出
// ============================================================

import { Client } from 'ssh2'
import type { Host } from '../../shared/types'
import type { SshExecEvent } from '../../shared/types'
import type { SshManager } from './ssh-manager'

export interface ExecResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
}

export class SshExecutor {
  private manager: SshManager

  constructor(manager: SshManager) {
    this.manager = manager
  }

  /** 执行远程命令，等待完成后返回完整结果 */
  async exec(host: Host, command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const client = await this.manager.connect(host)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`命令执行超时 (${timeoutMs}ms): ${command.slice(0, 50)}`))
      }, timeoutMs)

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          resolve({
            success: false,
            exitCode: -1,
            stdout: '',
            stderr: err.message
          })
          return
        }

        let stdout = ''
        let stderr = ''
        let exitCode = 0

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        stream.on('close', (code: number | null) => {
          clearTimeout(timer)
          exitCode = code ?? -1
          resolve({
            success: exitCode === 0,
            exitCode,
            stdout,
            stderr
          })
        })

        stream.on('error', (streamErr: Error) => {
          clearTimeout(timer)
          resolve({
            success: false,
            exitCode: -1,
            stdout,
            stderr: stderr + streamErr.message
          })
        })
      })
    })
  }

  /**
   * 执行远程命令，流式输出事件（用于终端面板）
   * 返回 AsyncGenerator，调用方逐个消费事件
   */
  async *execStream(host: Host, command: string, timeoutMs = 60_000): AsyncGenerator<SshExecEvent> {
    const client = await this.manager.connect(host)

    const events: SshExecEvent[] = []
    let done = false
    let error: Error | null = null

    const timer = setTimeout(() => {
      error = new Error(`命令执行超时 (${timeoutMs}ms)`)
      done = true
    }, timeoutMs)

    client.exec(command, (err, stream) => {
      if (err) {
        events.push({ type: 'stderr', data: err.message })
        events.push({ type: 'exit', data: '', exitCode: -1 })
        done = true
        clearTimeout(timer)
        return
      }

      stream.on('data', (data: Buffer) => {
        events.push({ type: 'stdout', data: data.toString() })
      })

      stream.stderr.on('data', (data: Buffer) => {
        events.push({ type: 'stderr', data: data.toString() })
      })

      stream.on('close', (code: number | null) => {
        events.push({ type: 'exit', data: '', exitCode: code ?? -1 })
        done = true
        clearTimeout(timer)
      })

      stream.on('error', (streamErr: Error) => {
        events.push({ type: 'stderr', data: streamErr.message })
        events.push({ type: 'exit', data: '', exitCode: -1 })
        done = true
        clearTimeout(timer)
      })
    })

    // 将事件逐个 yield 给调用方
    while (!done || events.length > 0) {
      if (events.length > 0) {
        yield events.shift()!
      } else if (!done) {
        // 等待新事件
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (error) throw error
    }
  }
}

// ============================================================
// BackgroundTaskManager — 后台 shell 任务管理器
// 管理通过 Bash run_in_background=true 启动的后台进程
// ============================================================

import { exec, ChildProcess } from 'child_process'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'
import iconv from 'iconv-lite'

export interface BackgroundTask {
  id: string
  command: string
  pid?: number
  status: 'running' | 'completed' | 'error' | 'aborted'
  output: string
  exitCode: number | null
  startedAt: number
  completedAt: number | null
  cwd: string
}

type TaskCompletionCallback = (task: BackgroundTask) => void

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>()
  private processes = new Map<string, ChildProcess>()
  private completionCallbacks: TaskCompletionCallback[] = []
  private idCounter = 0

  /** 注册任务完成回调（用于通知 agent loop） */
  onTaskComplete(cb: TaskCompletionCallback): () => void {
    this.completionCallbacks.push(cb)
    return () => {
      this.completionCallbacks = this.completionCallbacks.filter(c => c !== cb)
    }
  }

  /** 启动后台命令，立即返回任务 ID */
  startTask(command: string, options: {
    cwd: string
    timeout?: number
    shell?: string
    abortSignal?: AbortSignal
  }): string {
    const id = `bg-${Date.now()}-${++this.idCounter}`
    const task: BackgroundTask = {
      id,
      command,
      status: 'running',
      output: '',
      exitCode: null,
      startedAt: Date.now(),
      completedAt: null,
      cwd: options.cwd,
    }
    this.tasks.set(id, task)

    const isWindowsCmd = process.platform === 'win32' && !options.shell
    const child = exec(command, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: isWindowsCmd ? 'buffer' : 'utf8',
      shell: options.shell,
      env: process.platform === 'win32'
        ? { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        : process.env,
    }, (error, stdout, stderr) => {
      const decode = (buf: Buffer | string): string => {
        if (typeof buf === 'string') return buf
        const utf8 = buf.toString('utf8')
        if (buf.length < 2 || !utf8.includes('\ufffd')) return utf8
        return iconv.decode(buf, 'gbk')
      }

      let output = decode(stdout as Buffer | string) || ''
      const stderrText = decode(stderr as Buffer | string)
      if (stderrText) {
        output += (output ? '\nSTDERR:\n' : 'STDERR:\n') + stderrText
      }
      if (output.length > MAX_TOOL_RESULT_CHARS) {
        output = output.substring(0, MAX_TOOL_RESULT_CHARS) + '\n... [output truncated]'
      }

      task.output = output
      task.exitCode = error ? (error as NodeJS.ErrnoException).code === 'ABORTERR' ? null : (error as any).status ?? 1 : 0
      task.completedAt = Date.now()

      if (options.abortSignal?.aborted) {
        task.status = 'aborted'
      } else if (error) {
        task.status = 'error'
        if (!output) task.output = error.message
      } else {
        task.status = 'completed'
      }

      this.processes.delete(id)
      this.completionCallbacks.forEach(cb => cb(task))
    })

    task.pid = child.pid
    this.processes.set(id, child)

    // 监听 abort
    if (options.abortSignal) {
      const onAbort = (): void => { child.kill(); task.status = 'aborted' }
      if (options.abortSignal.aborted) { onAbort() }
      else { options.abortSignal.addEventListener('abort', onAbort, { once: true }) }
    }

    return id
  }

  /** 获取任务信息 */
  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)
  }

  /** 获取任务输出（若仍在运行返回当前累积输出） */
  getTaskOutput(id: string): { output: string; status: string; exitCode: number | null } | null {
    const task = this.tasks.get(id)
    if (!task) return null
    return { output: task.output, status: task.status, exitCode: task.exitCode }
  }

  /** 停止后台任务 */
  stopTask(id: string): boolean {
    const proc = this.processes.get(id)
    const task = this.tasks.get(id)
    if (proc) {
      proc.kill()
      this.processes.delete(id)
    }
    if (task && task.status === 'running') {
      task.status = 'aborted'
      task.completedAt = Date.now()
      return true
    }
    return false
  }

  /** 列出所有后台任务 */
  listTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values())
  }
}

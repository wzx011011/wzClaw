// ============================================================
// Agent 代码优化器 — 根据弱点分析自动修改 AgentLoop 相关代码
// 优化目标：file-edit 匹配、stall 检测、loop 检测
// 回滚机制：git checkout 恢复修改前的文件
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { WeaknessReport } from './types'

const execAsync = promisify(execFile)

/** 项目根目录 */
const ROOT = resolve(__dirname, '../..')

/** 持久化备份目录 */
const BACKUP_DIR = resolve(ROOT, '.eval-reports/code-backups')

/** 可优化的目标文件（相对于项目根目录） */
const TARGETS = {
  fileEdit: 'src/main/tools/file-edit.ts',
  agentLoop: 'src/main/agent/agent-loop.ts',
  loopDetector: 'src/main/agent/loop-detector.ts',
} as const

/** 优化记录（用于回滚） */
interface AppliedOptimization {
  file: string
  description: string
  backupContent: string
}

export class AgentOptimizer {
  private applied: AppliedOptimization[] = []

  constructor() {
    // 启动时尝试从磁盘恢复备份记录
    this.loadBackupManifest()
  }

  /**
   * 根据弱点报告应用代码优化
   * @returns 应用的优化列表（空列表表示无变更）
   */
  async optimize(report: WeaknessReport): Promise<string[]> {
    const changes: string[] = []

    for (const category of report.categories) {
      switch (category.name) {
        case 'test_failure_high':
        case 'test_failure_moderate': {
          // 编辑匹配失败 → 增强 file-edit 的模糊匹配
          const applied = await this.applyFileEditFuzzyMatch()
          if (applied) changes.push(applied)
          break
        }
        case 'high_turn_count': {
          // 高轮次 → 添加 stall 检测 + 增强 loop 检测
          const stall = await this.applyStallDetection()
          if (stall) changes.push(stall)
          const loop = await this.applyLoopDetectorEnhancement()
          if (loop) changes.push(loop)
          break
        }
        case 'easy_tasks_failing': {
          // 简单题失败 → 可能是编辑匹配问题
          const applied = await this.applyFileEditFuzzyMatch()
          if (applied) changes.push(applied)
          break
        }
        case 'low_efficiency': {
          // 低效率 → 增强 loop 检测
          const applied = await this.applyLoopDetectorEnhancement()
          if (applied) changes.push(applied)
          break
        }
      }
    }

    return changes
  }

  /**
   * 回滚所有已应用的优化（恢复原始代码）
   * 从磁盘持久化备份中恢复，确保进程崩溃后也能回滚
   */
  async rollback(): Promise<void> {
    for (const opt of this.applied.slice().reverse()) {
      try {
        // 优先从磁盘备份恢复
        const backupPath = resolve(BACKUP_DIR, opt.file.replace(/\//g, '__'))
        let content = opt.backupContent
        if (existsSync(backupPath)) {
          content = readFileSync(backupPath, 'utf-8')
        }
        writeFileSync(resolve(ROOT, opt.file), content)
        // 清理磁盘备份
        try { writeFileSync(backupPath, '') } catch { /* ignore */ }
        console.log(`  Rolled back: ${opt.file}`)
      } catch (e: any) {
        console.error(`  Rollback FAILED for ${opt.file}: ${e.message}`)
      }
    }
    this.applied = []
    this.saveBackupManifest()
  }

  /**
   * 持久化备份到磁盘（在应用优化时调用）
   */
  private persistBackup(file: string, content: string): void {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
    const backupPath = resolve(BACKUP_DIR, file.replace(/\//g, '__'))
    writeFileSync(backupPath, content)
  }

  /**
   * 保存备份清单（记录哪些文件有活跃备份）
   */
  private saveBackupManifest(): void {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
    const manifest = this.applied.map(a => ({ file: a.file, description: a.description }))
    writeFileSync(resolve(BACKUP_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  }

  /**
   * 加载备份清单（进程重启后恢复状态）
   */
  private loadBackupManifest(): void {
    const manifestPath = resolve(BACKUP_DIR, 'manifest.json')
    if (!existsSync(manifestPath)) return
    try {
      const manifest: Array<{ file: string; description: string }> = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      for (const entry of manifest) {
        const backupPath = resolve(BACKUP_DIR, entry.file.replace(/\//g, '__'))
        if (existsSync(backupPath)) {
          const backupContent = readFileSync(backupPath, 'utf-8')
          if (backupContent.length > 0) {
            this.applied.push({ file: entry.file, description: entry.description, backupContent })
          }
        }
      }
      if (this.applied.length > 0) {
        console.log(`  [agent-optimizer] Restored ${this.applied.length} backup(s) from disk`)
      }
    } catch { /* corrupted manifest, start fresh */ }
  }

  // ---- 优化规则实现 ----

  /**
   * 优化 1: file-edit.ts 增加空白字符模糊匹配
   * 当精确匹配失败时，尝试空白字符归一化后的匹配
   */
  private async applyFileEditFuzzyMatch(): Promise<string | null> {
    const filePath = resolve(ROOT, TARGETS.fileEdit)
    const content = readFileSync(filePath, 'utf-8')

    // 检查是否已应用
    if (content.includes('EVAL-OPT: fuzzy-match')) {
      return null
    }

    // 找到精确匹配失败后的位置，插入模糊匹配逻辑
    // 搜索特征：matchCount === 0 时的返回逻辑
    const marker = 'EVAL-OPT: fuzzy-match'
    const fuzzyBlock = `
    // ${marker}: 空白字符归一化模糊匹配（迭代引擎自动添加）
    if (matchCount === 0) {
      const normalize = (s: string) => s.replace(/\\r\\n/g, '\\n').replace(/[ \\t]+/g, ' ')
      const normContent = normalize(content)
      const normOld = normalize(old_string)
      const normIndex = normContent.indexOf(normOld)
      if (normIndex !== -1) {
        // 检查归一化后的唯一性
        let normCount = 0
        let nsi = 0
        while (true) {
          const idx = normContent.indexOf(normOld, nsi)
          if (idx === -1) break
          normCount++
          nsi = idx + 1
        }
        if (normCount === 1) {
          // 将归一化位置映射回原始位置
          let origPos = 0, normPos = 0
          while (normPos < normIndex && origPos < content.length) {
            const normChar = normContent[normPos]
            const origChar = content[origPos]
            if (normChar === origChar) {
              normPos++
              origPos++
            } else {
              origPos++ // 跳过被归一化掉的字符
            }
          }
          // 在原始内容中找到对应的结束位置
          let origEnd = origPos
          let normEndChars = 0
          while (normEndChars < normOld.length && origEnd < content.length) {
            const normChar = normContent[normPos + normEndChars]
            const origChar = content[origEnd]
            if (normChar === origChar) {
              normEndChars++
              origEnd++
            } else {
              origEnd++
            }
          }
          // 执行替换
          const newContent = content.slice(0, origPos) + new_string + content.slice(origEnd)
          writeFileSync(filePath, newContent)
          return { content: newContent }
        }
      }
    }
`

    // 在 "return { error: ..." 之前插入（精确匹配失败时）
    const insertPoint = content.indexOf("return { error: 'No match found")
    if (insertPoint === -1) {
      console.log('  [agent-optimizer] Could not find insertion point in file-edit.ts')
      return null
    }

    // 找到这一行的开头
    const lineStart = content.lastIndexOf('\n', insertPoint) + 1
    const indent = content.slice(lineStart, insertPoint).match(/^(\s*)/)?.[1] ?? '    '

    this.applied.push({
      file: TARGETS.fileEdit,
      description: 'file-edit fuzzy whitespace matching',
      backupContent: content,
    })
    this.persistBackup(TARGETS.fileEdit, content)
    this.saveBackupManifest()

    const newContent = content.slice(0, lineStart) + fuzzyBlock + content.slice(lineStart)
    writeFileSync(filePath, newContent)

    // 验证编译
    if (!(await this.verifyCompile())) {
      // 回滚此次修改
      writeFileSync(filePath, content)
      this.applied.pop()
      console.log('  [agent-optimizer] file-edit optimization rolled back (compile failed)')
      return null
    }

    return 'file-edit: added whitespace-normalized fuzzy match'
  }

  /**
   * 优化 2: agent-loop.ts 添加 stall 检测
   * 连续 3 轮无文件写入时提前终止
   */
  private async applyStallDetection(): Promise<string | null> {
    const filePath = resolve(ROOT, TARGETS.agentLoop)
    const content = readFileSync(filePath, 'utf-8')

    if (content.includes('EVAL-OPT: stall-detection')) {
      return null
    }

    // 搜索：turn 结束后跟踪 token 使用的位置附近
    // 找到 turn++ 或 turn counting 的位置，在其后插入 stall 检测
    const marker = 'EVAL-OPT: stall-detection'
    const stallBlock = `
      // ${marker}: 连续无文件编辑时提前终止（迭代引擎自动添加）
      {
        const lastCalls = turnResult as any
        const hasFileEdit = lastCalls?.toolCalls?.some(
          (tc: any) => tc.name === 'FileEdit' || tc.name === 'FileWrite'
        ) ?? false
        if (!hasFileEdit) {
          stallCount++
          if (stallCount >= 3) {
            yield { type: 'agent:done', usage: totalUsage, turnCount: turn + 1 } as any
            return
          }
        } else {
          stallCount = 0
        }
      }
`

    // 在 token tracking 之后插入（搜索特征：totalUsage）
    const searchPattern = 'totalUsage.outputTokens +='
    const insertPoint = content.indexOf(searchPattern)
    if (insertPoint === -1) {
      console.log('  [agent-optimizer] Could not find insertion point in agent-loop.ts')
      return null
    }

    // 找到这一行结束后
    const lineEnd = content.indexOf('\n', insertPoint) + 1
    // 找到下一个闭合花括号的位置（当前代码块的结束处）
    const nextLineEnd = content.indexOf('\n', lineEnd) + 1

    // 在 loop 开始前初始化 stallCount
    const loopStart = content.indexOf('for (let turn')
    if (loopStart === -1) {
      return null
    }
    const loopLineStart = content.lastIndexOf('\n', loopStart) + 1

    const initLine = '    let stallCount = 0  // EVAL-OPT: stall-detection-init\n'

    this.applied.push({
      file: TARGETS.agentLoop,
      description: 'stall detection in agent loop',
      backupContent: content,
    })
    this.persistBackup(TARGETS.agentLoop, content)
    this.saveBackupManifest()

    let newContent = content
    // 插入初始化
    newContent = newContent.slice(0, loopLineStart) + initLine + newContent.slice(loopLineStart)
    // 插入检测逻辑（需要重新计算位置）
    const newSearchIdx = newContent.indexOf(searchPattern)
    if (newSearchIdx === -1) {
      writeFileSync(filePath, content)
      this.applied.pop()
      return null
    }
    const newLineEnd = newContent.indexOf('\n', newSearchIdx) + 1
    newContent = newContent.slice(0, newLineEnd) + stallBlock + newContent.slice(newLineEnd)

    writeFileSync(filePath, newContent)

    if (!(await this.verifyCompile())) {
      writeFileSync(filePath, content)
      this.applied.pop()
      console.log('  [agent-optimizer] stall detection rolled back (compile failed)')
      return null
    }

    return 'agent-loop: added stall detection (3 turns no file edit → stop)'
  }

  /**
   * 优化 3: loop-detector.ts 增强循环检测
   * 从"连续3次相同"扩展为"滑动窗口6次内出现3次"
   */
  private async applyLoopDetectorEnhancement(): Promise<string | null> {
    const filePath = resolve(ROOT, TARGETS.loopDetector)
    const content = readFileSync(filePath, 'utf-8')

    if (content.includes('EVAL-OPT: sliding-window')) {
      return null
    }

    const marker = 'EVAL-OPT: sliding-window'

    // 搜索 isLooping 方法
    const methodStart = content.indexOf('isLooping()')
    if (methodStart === -1) {
      console.log('  [agent-optimizer] Could not find isLooping() in loop-detector.ts')
      return null
    }

    // 找到方法体（从 { 到下一个 }）
    const bodyStart = content.indexOf('{', methodStart)
    let braceCount = 0
    let bodyEnd = bodyStart
    for (let i = bodyStart; i < content.length; i++) {
      if (content[i] === '{') braceCount++
      if (content[i] === '}') {
        braceCount--
        if (braceCount === 0) {
          bodyEnd = i
          break
        }
      }
    }

    const originalMethod = content.slice(methodStart, bodyEnd + 1)

    const enhancedMethod = `isLooping(): boolean {
    if (this.history.length < 3) return false

    // Original: 3 consecutive identical calls
    const len = this.history.length
    const a = this.history[len - 3]
    const b = this.history[len - 2]
    const c = this.history[len - 1]
    if (a.name === b.name && b.name === c.name &&
        a.inputKey === b.inputKey && b.inputKey === c.inputKey) {
      return true
    }

    // ${marker}: 滑动窗口检测（6次调用内同一调用出现3次）
    const windowSize = Math.min(6, this.history.length)
    const window = this.history.slice(-windowSize)
    const counts = new Map<string, number>()
    for (const entry of window) {
      const key = entry.name + ':' + entry.inputKey
      const count = (counts.get(key) ?? 0) + 1
      if (count >= 3) return true
      counts.set(key, count)
    }

    return false
  }`

    this.applied.push({
      file: TARGETS.loopDetector,
      description: 'enhanced loop detection with sliding window',
      backupContent: content,
    })
    this.persistBackup(TARGETS.loopDetector, content)
    this.saveBackupManifest()

    const newContent = content.slice(0, methodStart) + enhancedMethod + content.slice(bodyEnd + 1)
    writeFileSync(filePath, newContent)

    if (!(await this.verifyCompile())) {
      writeFileSync(filePath, content)
      this.applied.pop()
      console.log('  [agent-optimizer] loop detector enhancement rolled back (compile failed)')
      return null
    }

    return 'loop-detector: added sliding window loop detection (3-in-6 check)'
  }

  // ---- 编译验证 ----

  private async verifyCompile(): Promise<boolean> {
    try {
      await execAsync('npx', ['tsc', '--noEmit'], {
        cwd: ROOT,
        shell: true,
        timeout: 60_000,
      })
      return true
    } catch {
      return false
    }
  }
}

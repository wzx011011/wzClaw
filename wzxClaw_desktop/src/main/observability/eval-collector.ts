// ============================================================
// EvalCollector — Agent 会话质量指标采集器
// 在 Agent 运行期间收集工具调用、turn、压缩、错误恢复数据，
// 会话结束时计算评分并推送到 Langfuse。
//
// 评分列表（11 个，含 eval-judge.ts 的 3 个 LLM Judge 评分）：
//   Tier 1 自动评分（本文件）：
//     tool_success_rate  NUMERIC  0-1    工具调用成功率
//     tool_diversity     NUMERIC  0-1    唯一工具数/总调用数
//     edit_success_rate  NUMERIC  0-1    FileEdit/FileWrite 成功率
//     context_pressure   NUMERIC  0-1    峰值 token 占上下文窗口比
//     compaction_count   NUMERIC  0+     压缩事件次数
//     error_recovery     CATEGORICAL     none/recovered/partial/failed
//     loop_detected      NUMERIC  0/1    是否检测到循环
//     avg_output_per_turn NUMERIC 0+     每轮平均输出 token 数
//   Tier 2 LLM Judge（eval-judge.ts）：
//     task_completion    CATEGORICAL     complete/partial/failed/abandoned
//     code_safety        CATEGORICAL     safe/caution/unsafe
//     response_clarity   NUMERIC  1-5
// ============================================================

export interface ScoreEntry {
  name: string
  value: number | string
  dataType: 'NUMERIC' | 'CATEGORICAL'
}

export class EvalCollector {
  // ---- 工具调用统计 ----
  private totalCalls = 0
  private successCalls = 0
  private editTotal = 0
  private editSuccess = 0
  private uniqueTools = new Set<string>()
  private anyLoopDetected = false

  // ---- Turn 统计 ----
  private turnCount = 0
  private totalOutputTokens = 0

  // ---- 上下文压力 ----
  private maxContextPressure = 0

  // ---- 压缩和恢复 ----
  private compactionCount = 0
  private errorRecoveryLevel: 'none' | 'recovered' | 'partial' | 'failed' = 'none'

  // ---- 破坏性工具使用（用于 judge 触发判断）----
  private destructiveToolUsed = false
  private hadAnyError = false

  /**
   * 记录一次工具调用
   * 在 turn-manager.ts createExecuteToolFn() 的每个出口调用
   */
  recordToolCall(name: string, isError: boolean, loopDetected: boolean): void {
    this.totalCalls++
    if (!isError) this.successCalls++
    this.uniqueTools.add(name)
    if (loopDetected) this.anyLoopDetected = true
    if (isError) this.hadAnyError = true

    if (name === 'FileEdit' || name === 'FileWrite' || name === 'Bash') {
      this.destructiveToolUsed = true
      this.editTotal++
      if (!isError) this.editSuccess++
    }
  }

  /**
   * 记录一个 turn 完成
   * 在 agent-loop.ts 每个 turn 结束后调用
   */
  recordTurn(outputTokens: number): void {
    this.turnCount++
    this.totalOutputTokens += outputTokens
  }

  /**
   * 记录一次上下文压缩
   * 在 agent-loop.ts doCompaction() 和 reactive compact 中调用
   */
  recordCompaction(): void {
    this.compactionCount++
  }

  /**
   * 记录错误恢复事件
   * 在 agent-loop.ts catch PromptTooLongError 的三个分支调用
   */
  recordErrorRecovery(level: 'reactive_compact' | 'tools_disabled' | 'fatal'): void {
    this.hadAnyError = true
    if (level === 'reactive_compact') {
      this.errorRecoveryLevel = 'recovered'
    } else if (level === 'tools_disabled') {
      // 只有当还没 recovered 时才设为 partial
      if (this.errorRecoveryLevel === 'none') {
        this.errorRecoveryLevel = 'partial'
      }
    } else {
      this.errorRecoveryLevel = 'failed'
    }
  }

  /**
   * 记录上下文压力
   * 在 agent-loop.ts 压缩检查处调用
   */
  recordContextPressure(estimatedTokens: number, contextWindow: number): void {
    if (contextWindow > 0) {
      const pressure = estimatedTokens / contextWindow
      if (pressure > this.maxContextPressure) {
        this.maxContextPressure = pressure
      }
    }
  }

  /**
   * 计算所有自动评分
   * 在 langfuse-observer.ts endTrace() 中调用
   */
  computeScores(): ScoreEntry[] {
    const scores: ScoreEntry[] = []

    // 1. tool_success_rate — 仅在有工具调用时输出
    if (this.totalCalls > 0) {
      scores.push({
        name: 'tool_success_rate',
        value: parseFloat((this.successCalls / this.totalCalls).toFixed(3)),
        dataType: 'NUMERIC',
      })
    }

    // 2. tool_diversity — 仅在有工具调用时输出
    if (this.totalCalls > 0) {
      scores.push({
        name: 'tool_diversity',
        value: parseFloat((this.uniqueTools.size / this.totalCalls).toFixed(3)),
        dataType: 'NUMERIC',
      })
    }

    // 3. edit_success_rate — 仅在有编辑操作时输出
    if (this.editTotal > 0) {
      scores.push({
        name: 'edit_success_rate',
        value: parseFloat((this.editSuccess / this.editTotal).toFixed(3)),
        dataType: 'NUMERIC',
      })
    }

    // 4. context_pressure — 始终输出
    scores.push({
      name: 'context_pressure',
      value: parseFloat(this.maxContextPressure.toFixed(3)),
      dataType: 'NUMERIC',
    })

    // 5. compaction_count
    scores.push({
      name: 'compaction_count',
      value: this.compactionCount,
      dataType: 'NUMERIC',
    })

    // 6. error_recovery — 仅在有恢复事件时输出
    // Langfuse CATEGORICAL 用数字值: None=0, Recovered=1, Partial=2, Failed=3
    if (this.errorRecoveryLevel !== 'none') {
      const recoveryMap: Record<string, number> = { none: 0, recovered: 1, partial: 2, failed: 3 }
      scores.push({
        name: 'error_recovery',
        value: recoveryMap[this.errorRecoveryLevel] ?? 0,
        dataType: 'CATEGORICAL',
      })
    }

    // 7. loop_detected
    if (this.anyLoopDetected) {
      scores.push({
        name: 'loop_detected',
        value: 1,
        dataType: 'NUMERIC',
      })
    }

    // 8. avg_output_per_turn — 仅在有 turn 时输出
    if (this.turnCount > 0) {
      scores.push({
        name: 'avg_output_per_turn',
        value: Math.round(this.totalOutputTokens / this.turnCount),
        dataType: 'NUMERIC',
      })
    }

    return scores
  }

  // ---- Judge 触发判断 ----

  /** 是否使用了破坏性工具 */
  get hasDestructiveTools(): boolean {
    return this.destructiveToolUsed
  }

  /** 是否有任何错误 */
  get hasError(): boolean {
    return this.hadAnyError
  }

  /** 获取 turn 数（用于 judge 的最小 turn 门槛） */
  get totalTurns(): number {
    return this.turnCount
  }

  /** 获取所有工具调用数据摘要（供 judge prompt 使用） */
  getToolSummary(): { total: number; success: number; errors: number; uniqueTools: string[]; editTotal: number; editSuccess: number } {
    return {
      total: this.totalCalls,
      success: this.successCalls,
      errors: this.totalCalls - this.successCalls,
      uniqueTools: [...this.uniqueTools],
      editTotal: this.editTotal,
      editSuccess: this.editSuccess,
    }
  }
}

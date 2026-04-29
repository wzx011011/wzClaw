// ============================================================
// ELO / Bradley-Terry 排名系统
// 参考 LMSYS Chatbot Arena 的方法论
// 为每次迭代的 prompt variant 计算相对排名
// ============================================================

import type { RunSummary, TaskEvalResult } from './types'

/** 一个参赛选手（prompt variant） */
export interface ELOPlayer {
  id: string
  iteration: number
  rating: number
  matchCount: number
  wins: number
  losses: number
  draws: number
}

/** 一次对局记录 */
export interface ELOMatch {
  playerA: string
  playerB: string
  taskId: string
  /** 1 = A 赢, 0 = B 赢, 0.5 = 平局 */
  outcome: number
}

/** ELO 排名系统 */
export class ELORanking {
  private players: Map<string, ELOPlayer> = new Map()
  private matches: ELOMatch[] = []
  private K: number

  /**
   * @param K ELO K 因子（默认 32，标准国际象棋值）
   */
  constructor(K: number = 32) {
    this.K = K
  }

  /**
   * 注册一个新选手（prompt variant）
   */
  registerPlayer(id: string, iteration: number): void {
    if (!this.players.has(id)) {
      this.players.set(id, {
        id,
        iteration,
        rating: 1500,
        matchCount: 0,
        wins: 0,
        losses: 0,
        draws: 0,
      })
    }
  }

  /**
   * 从两次运行结果生成对局并更新排名
   * 逐工作区对比：A 通过 B 不通过 → A 赢，反之亦然，都通过/都不通过 → 平局
   */
  recordRunComparison(
    playerAId: string, summaryA: RunSummary,
    playerBId: string, summaryB: RunSummary,
  ): { wins: number; losses: number; draws: number } {
    const indexA = indexByTaskId(summaryA.perTaskResults)
    const indexB = indexByTaskId(summaryB.perTaskResults)

    const allTaskIds = new Set([...Object.keys(indexA), ...Object.keys(indexB)])
    let wins = 0, losses = 0, draws = 0

    for (const taskId of allTaskIds) {
      const a = indexA[taskId]
      const b = indexB[taskId]
      if (!a || !b) continue

      const scoreA = taskScore(a)
      const scoreB = taskScore(b)

      let outcome: number
      if (scoreA > scoreB) {
        outcome = 1
        wins++
      } else if (scoreA < scoreB) {
        outcome = 0
        losses++
      } else {
        outcome = 0.5
        draws++
      }

      this.matches.push({ playerA: playerAId, playerB: playerBId, taskId, outcome })
      this.updateELO(playerAId, playerBId, outcome)
    }

    return { wins, losses, draws }
  }

  /**
   * Bradley-Terry 模型估计
   * 通过最大似然估计（迭代法）计算每个选手的强度参数
   * 更稳健的替代 ELO，适合样本小的场景
   */
  bradleyTerryEstimate(maxIter: number = 100, tol: number = 1e-6): Map<string, number> {
    const playerIds = [...this.players.keys()]
    if (playerIds.length < 2) {
      return new Map(playerIds.map(id => [id, 1.0]))
    }

    // 初始强度 = 1.0
    const strength = new Map<string, number>(playerIds.map(id => [id, 1.0]))

    // 统计胜负矩阵
    const wins = new Map<string, Map<string, number>>()
    for (const id of playerIds) wins.set(id, new Map())

    for (const match of this.matches) {
      const w = wins.get(match.playerA)!
      const l = wins.get(match.playerB)!
      if (match.outcome === 1) {
        w.set(match.playerB, (w.get(match.playerB) ?? 0) + 1)
      } else if (match.outcome === 0) {
        l.set(match.playerA, (l.get(match.playerA) ?? 0) + 1)
      } else {
        // 平局算半赢
        w.set(match.playerB, (w.get(match.playerB) ?? 0) + 0.5)
        l.set(match.playerA, (l.get(match.playerA) ?? 0) + 0.5)
      }
    }

    // 迭代更新
    for (let iter = 0; iter < maxIter; iter++) {
      let maxDelta = 0

      for (const i of playerIds) {
        const winsI = wins.get(i)!
        let numerator = 0
        let denominator = 0

        for (const j of playerIds) {
          if (i === j) continue
          const wij = winsI.get(j) ?? 0
          const wji = wins.get(j)!.get(i) ?? 0
          const nij = wij + wji
          if (nij === 0) continue

          numerator += wij
          denominator += nij / (strength.get(i)! + strength.get(j)!)
        }

        if (denominator > 0) {
          const newStrength = numerator / denominator
          const delta = Math.abs(newStrength - strength.get(i)!)
          maxDelta = Math.max(maxDelta, delta)
          strength.set(i, newStrength)
        }
      }

      // 归一化（使平均强度 = 1）
      const avg = [...strength.values()].reduce((a, b) => a + b, 0) / strength.size
      if (avg > 0) {
        for (const id of playerIds) {
          strength.set(id, strength.get(id)! / avg)
        }
      }

      if (maxDelta < tol) break
    }

    return strength
  }

  /**
   * 获取排名榜
   */
  getLeaderboard(): ELOPlayer[] {
    return [...this.players.values()].sort((a, b) => b.rating - a.rating)
  }

  /**
   * 输出排名为 Markdown
   */
  formatLeaderboard(): string {
    const leaderboard = this.getLeaderboard()
    const btStrength = this.bradleyTerryEstimate()

    const lines: string[] = []
    lines.push('## ELO / Bradley-Terry Leaderboard')
    lines.push('')
    lines.push('| Rank | Player | Iteration | ELO | BT Strength | W/L/D |')
    lines.push('|------|--------|-----------|-----|-------------|-------|')

    for (let i = 0; i < leaderboard.length; i++) {
      const p = leaderboard[i]
      const bt = btStrength.get(p.id) ?? 1.0
      lines.push(`| ${i + 1} | ${p.id} | ${p.iteration} | ${Math.round(p.rating)} | ${bt.toFixed(3)} | ${p.wins}/${p.losses}/${p.draws} |`)
    }
    lines.push('')

    return lines.join('\n')
  }

  /**
   * 序列化状态（持久化用）
   */
  serialize(): { players: ELOPlayer[]; matches: ELOMatch[] } {
    return {
      players: [...this.players.values()],
      matches: this.matches,
    }
  }

  /**
   * 从序列化状态恢复
   */
  static deserialize(data: { players: ELOPlayer[]; matches: ELOMatch[] }): ELORanking {
    const ranking = new ELORanking()
    for (const p of data.players) {
      ranking.players.set(p.id, p)
    }
    ranking.matches = data.matches
    return ranking
  }

  // ---- Internal ----

  private updateELO(playerAId: string, playerBId: string, outcome: number): void {
    const a = this.players.get(playerAId)!
    const b = this.players.get(playerBId)!

    const expectedA = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400))
    const expectedB = 1 - expectedA

    a.rating += this.K * (outcome - expectedA)
    b.rating += this.K * ((1 - outcome) - expectedB)

    a.matchCount++
    b.matchCount++

    if (outcome === 1) { a.wins++; b.losses++ }
    else if (outcome === 0) { a.losses++; b.wins++ }
    else { a.draws++; b.draws++ }
  }
}

// ---- Helpers ----

function indexByTaskId(results: TaskEvalResult[]): Record<string, TaskEvalResult> {
  const map: Record<string, TaskEvalResult> = {}
  for (const r of results) map[r.taskId] = r
  return map
}

/**
 * 工作区评分（0-3），与 comparison-report.ts 保持一致
 */
function taskScore(r: TaskEvalResult): number {
  if (r.error) return 0
  if (r.testPassed === true) {
    const judge = r.judgeScores['task_completion'] ?? 3
    return judge >= 4 ? 3 : 2
  }
  if (r.testPassed === false) return r.turnCount > 1 ? 1 : 0
  const judge = r.judgeScores['task_completion'] ?? 0
  return judge >= 4 ? 3 : judge >= 3 ? 2 : judge >= 1 ? 1 : 0
}

// ============================================================
// 数据集分割扩展器 — 增加 test set 覆盖，降低统计噪声
// 支持从完整数据集中按分层抽样重新划分 train/test
// ============================================================

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { BenchmarkTask } from './types'

export interface SplitConfig {
  /** test set 占比（默认 0.3） */
  testRatio: number
  /** 随机种子（确保可重现） */
  seed: number
  /** 按此字段分层抽样（确保各层在 train/test 中比例一致） */
  stratifyBy: ('language' | 'difficulty' | 'category')[]
}

const DEFAULT_SPLIT_CONFIG: SplitConfig = {
  testRatio: 0.3,
  seed: 42,
  stratifyBy: ['language', 'difficulty'],
}

/**
 * 分析当前数据集的 train/test 分割质量
 */
export function analyzeSplit(dataFile: string): SplitAnalysis {
  const tasks = loadTasks(dataFile)
  const train = tasks.filter(t => t.metadata.split === 'train')
  const test = tasks.filter(t => t.metadata.split === 'test')
  const unassigned = tasks.filter(t => !t.metadata.split)

  const trainByLang = groupCount(train, t => t.language)
  const testByLang = groupCount(test, t => t.language)
  const trainByDiff = groupCount(train, t => t.difficulty)
  const testByDiff = groupCount(test, t => t.difficulty)
  const trainByCat = groupCount(train, t => t.metadata.category)
  const testByCat = groupCount(test, t => t.metadata.category)

  // 统计噪声：1-flip delta for test set
  const testFlipDelta = test.length > 0 ? 1 / test.length : Infinity

  // 分层覆盖缺口：test 中缺失的 strata
  const missingInTest: string[] = []
  for (const lang of Object.keys(trainByLang)) {
    if (!testByLang[lang]) missingInTest.push(`language:${lang}`)
  }
  for (const diff of Object.keys(trainByDiff)) {
    if (!testByDiff[diff]) missingInTest.push(`difficulty:${diff}`)
  }
  for (const cat of Object.keys(trainByCat)) {
    if (!testByCat[cat]) missingInTest.push(`category:${cat}`)
  }

  return {
    total: tasks.length,
    trainCount: train.length,
    testCount: test.length,
    unassignedCount: unassigned.length,
    testRatio: test.length / Math.max(tasks.length, 1),
    testFlipDelta,
    trainByLanguage: trainByLang,
    testByLanguage: testByLang,
    trainByDifficulty: trainByDiff,
    testByDifficulty: testByDiff,
    trainByCategory: trainByCat,
    testByCategory: testByCat,
    missingInTest,
    recommendations: generateRecommendations(tasks.length, train.length, test.length, testFlipDelta, missingInTest),
  }
}

/**
 * 重新划分 train/test（分层抽样）
 * 将结果直接写回数据文件（修改 metadata.split 字段）
 */
export function resplitDataset(dataFile: string, config: Partial<SplitConfig> = {}): { trainCount: number; testCount: number } {
  const cfg = { ...DEFAULT_SPLIT_CONFIG, ...config }
  const tasks = loadTasks(dataFile)

  // 分层分组
  const strata = new Map<string, BenchmarkTask[]>()
  for (const task of tasks) {
    const key = cfg.stratifyBy.map(field => {
      if (field === 'language') return task.language
      if (field === 'difficulty') return task.difficulty
      if (field === 'category') return task.metadata.category
      return 'unknown'
    }).join('|')
    if (!strata.has(key)) strata.set(key, [])
    strata.get(key)!.push(task)
  }

  // 确定性 shuffle + 分割
  const rng = seededRng(cfg.seed)
  let trainCount = 0
  let testCount = 0

  for (const [, group] of strata) {
    // Fisher-Yates shuffle with seeded RNG
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]]
    }

    const testSize = Math.max(1, Math.round(group.length * cfg.testRatio))
    for (let i = 0; i < group.length; i++) {
      group[i].metadata.split = i < testSize ? 'test' : 'train'
    }
    testCount += testSize
    trainCount += group.length - testSize
  }

  // 写回
  const raw = readFileSync(resolve(dataFile), 'utf-8')
  const parsed = JSON.parse(raw)
  const isList = Array.isArray(parsed)
  const taskList: BenchmarkTask[] = isList ? parsed : parsed.tasks
  // 用 id 映射更新
  const splitMap = new Map(tasks.map(t => [t.id, t.metadata.split]))
  for (const task of taskList) {
    const newSplit = splitMap.get(task.id)
    if (newSplit) task.metadata.split = newSplit
  }
  writeFileSync(resolve(dataFile), JSON.stringify(isList ? taskList : { ...parsed, tasks: taskList }, null, 2))

  return { trainCount, testCount }
}

/**
 * 输出 Markdown 格式的分割分析报告
 */
export function formatSplitAnalysis(analysis: SplitAnalysis, datasetName: string): string {
  const lines: string[] = []
  lines.push(`## Split Analysis: ${datasetName}`)
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Total tasks | ${analysis.total} |`)
  lines.push(`| Train | ${analysis.trainCount} (${(analysis.trainCount / analysis.total * 100).toFixed(0)}%) |`)
  lines.push(`| Test | ${analysis.testCount} (${(analysis.testCount / analysis.total * 100).toFixed(0)}%) |`)
  lines.push(`| Unassigned | ${analysis.unassignedCount} |`)
  lines.push(`| Test 1-flip Δ | ±${(analysis.testFlipDelta * 100).toFixed(1)}% |`)
  lines.push('')

  if (analysis.missingInTest.length > 0) {
    lines.push(`**⚠ Missing in test set:** ${analysis.missingInTest.join(', ')}`)
    lines.push('')
  }

  // 语言分布
  lines.push('### By Language')
  lines.push('| Language | Train | Test | Ratio |')
  lines.push('|----------|-------|------|-------|')
  const allLangs = new Set([...Object.keys(analysis.trainByLanguage), ...Object.keys(analysis.testByLanguage)])
  for (const lang of allLangs) {
    const tr = analysis.trainByLanguage[lang] ?? 0
    const te = analysis.testByLanguage[lang] ?? 0
    lines.push(`| ${lang} | ${tr} | ${te} | ${te > 0 ? (te / (tr + te) * 100).toFixed(0) + '%' : '—'} |`)
  }
  lines.push('')

  // 难度分布
  lines.push('### By Difficulty')
  lines.push('| Difficulty | Train | Test |')
  lines.push('|------------|-------|------|')
  const allDiffs = new Set([...Object.keys(analysis.trainByDifficulty), ...Object.keys(analysis.testByDifficulty)])
  for (const d of allDiffs) {
    lines.push(`| ${d} | ${analysis.trainByDifficulty[d] ?? 0} | ${analysis.testByDifficulty[d] ?? 0} |`)
  }
  lines.push('')

  if (analysis.recommendations.length > 0) {
    lines.push('### Recommendations')
    for (const r of analysis.recommendations) lines.push(`- ${r}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ---- Types ----

export interface SplitAnalysis {
  total: number
  trainCount: number
  testCount: number
  unassignedCount: number
  testRatio: number
  testFlipDelta: number
  trainByLanguage: Record<string, number>
  testByLanguage: Record<string, number>
  trainByDifficulty: Record<string, number>
  testByDifficulty: Record<string, number>
  trainByCategory: Record<string, number>
  testByCategory: Record<string, number>
  missingInTest: string[]
  recommendations: string[]
}

// ---- Helpers ----

function loadTasks(dataFile: string): BenchmarkTask[] {
  const raw = readFileSync(resolve(dataFile), 'utf-8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : parsed.tasks ?? []
}

function groupCount<T>(arr: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of arr) {
    const k = keyFn(item)
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts
}

function generateRecommendations(total: number, train: number, test: number, flipDelta: number, missing: string[]): string[] {
  const recs: string[] = []
  if (test < 30) {
    recs.push(`Test set has only ${test} tasks. Recommend expanding to ≥50 for statistical reliability (1-flip Δ ≤ 2%).`)
  }
  if (flipDelta > 0.05) {
    recs.push(`1-flip delta is ${(flipDelta * 100).toFixed(1)}% — too noisy. Each task flip causes >${(flipDelta * 100).toFixed(0)}% swing in pass rate.`)
  }
  if (missing.length > 0) {
    recs.push(`${missing.length} strata missing from test set: ${missing.join(', ')}. Use resplitDataset() with stratified sampling.`)
  }
  if (test / total < 0.2) {
    recs.push(`Test ratio is ${(test / total * 100).toFixed(0)}% (< 20%). Consider increasing to 25-30% via resplitDataset().`)
  }
  if (test / total > 0.4) {
    recs.push(`Test ratio is ${(test / total * 100).toFixed(0)}% (> 40%). Train set may be too small for effective optimization.`)
  }
  return recs
}

/**
 * 确定性伪随机数生成器 (Mulberry32)
 */
function seededRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

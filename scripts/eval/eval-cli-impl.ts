#!/usr/bin/env npx tsx
// ============================================================
// wzxClaw Eval CLI — 评测命令行工具
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { runBatch } from '../../src/eval/batch-runner'
import { analyzeWeaknesses } from '../../src/eval/weakness-analyzer'
import { compareRuns } from '../../src/eval/comparison-report'
import { IterationEngine } from '../../src/eval/iteration-engine'
import {
  generateSummaryReport,
  generateWeaknessReport,
  generateComparisonReport,
  saveReport,
} from '../../src/eval/report-generator'
import type { RunSummary } from '../../src/eval/types'
import { analyzeSplit, formatSplitAnalysis } from '../../src/eval/dataset-splitter'

// ---- 配置 ----

const DATASETS = {
  'aider-polyglot': {
    name: 'aider-polyglot-regression',
    file: 'data/eval/aider-polyglot-curated.json',
  },
  'swebench-curated': {
    name: 'swebench-verified-curated',
    file: 'data/eval/swebench-verified-curated.json',
  },
} as const

type DatasetKey = keyof typeof DATASETS

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const raw = args[i].slice(2)
      // 支持 --key=value 和 --key value 两种格式
      const eqIdx = raw.indexOf('=')
      if (eqIdx !== -1) {
        parsed[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1)
      } else {
        const val = args[i + 1]?.startsWith('--') ? 'true' : (args[i + 1] ?? 'true')
        parsed[raw] = val
        if (val !== 'true') i++
      }
    }
  }
  return parsed
}

function getEnv(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? ''
}

// ---- 命令 ----

async function cmdImport(args: Record<string, string>) {
  // 动态导入 import-datasets
  console.log('Importing datasets to Langfuse...')
  const { execFileSync } = await import('child_process')
  const dataset = args['dataset'] ?? 'all'

  // 直接调用 import-datasets.ts 的逻辑
  const scriptPath = resolve(__dirname, 'import-datasets.js')
  try {
    execFileSync('npx', ['tsx', resolve(__dirname, 'import-datasets.ts'), `--dataset=${dataset}`], {
      stdio: 'inherit',
      env: process.env,
    })
  } catch (e: any) {
    // import-datasets.ts 可能通过直接 import 运行
    console.log('Trying direct import...')
    await import('./import-datasets')
  }
}

async function cmdRun(args: Record<string, string>) {
  const dataset = (args['dataset'] ?? 'aider-polyglot') as DatasetKey
  const dsConfig = DATASETS[dataset]
  if (!dsConfig) {
    console.error(`Unknown dataset: ${dataset}. Available: ${Object.keys(DATASETS).join(', ')}`)
    process.exit(1)
  }

  const model = args['model'] || getEnv('DEFAULT_MODEL', 'glm-5.1')
  const provider = args['provider'] ?? (model.startsWith('claude') || model.startsWith('glm-5') ? 'anthropic' : 'openai')
  const apiKey = args['api-key'] || getEnv('OPENAI_API_KEY') || getEnv('ANTHROPIC_API_KEY') || getEnv('DEEPSEEK_API_KEY')
  const baseURL = args['base-url'] ?? getDefaultBaseURL(provider)
  const runName = args['run-name'] ?? `run-${new Date().toISOString().slice(0, 10)}-${model}`
  const limit = args['limit'] ? parseInt(args['limit']) : 0
  const maxTurns = args['max-turns'] ? parseInt(args['max-turns']) : 15
  const keepWorkspaces = args['keep'] === 'true'
  const splitFilter = args['split'] as 'train' | 'test' | undefined

  if (!apiKey) {
    console.error('No API key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY in .env')
    process.exit(1)
  }

  // Judge 配置（用便宜的模型，走智谱 OpenAI 兼容接口）
  const judgeModel = args['judge-model'] ?? 'glm-4-flash'
  const judgeApiKey = getEnv('OPENAI_API_KEY') || getEnv('DEEPSEEK_API_KEY') || apiKey
  const judgeBaseURL = getEnv('OPENAI_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4'

  const summary = await runBatch({
    datasetName: dsConfig.name,
    dataFile: resolve(dsConfig.file),
    runName,
    agentConfig: {
      model,
      provider: provider as 'openai' | 'anthropic',
      apiKey,
      baseURL,
      maxTurns,
    },
    limit: limit > 0 ? limit : undefined,
    judgeConfig: {
      apiKey: judgeApiKey,
      baseURL: judgeBaseURL,
      judgeModel: judgeModel,
    },
    keepWorkspaces,
    splitFilter,
  })

  // 保存报告
  const report = generateSummaryReport(summary)
  const reportPath = await saveReport(report, `${runName}.md`)
  console.log(`\nReport saved to: ${reportPath}`)

  // 同时保存 JSON 结果
  const jsonPath = await saveReport(JSON.stringify(summary, null, 2), `${runName}.json`)
  console.log(`JSON results saved to: ${jsonPath}`)
}

async function cmdReport(args: Record<string, string>) {
  const runName = args['run-name']
  if (!runName) {
    console.error('Usage: eval:report --run-name <name>')
    process.exit(1)
  }

  const jsonPath = resolve('.eval-reports', `${runName}.json`)
  if (!existsSync(jsonPath)) {
    console.error(`No results found for run: ${runName}`)
    process.exit(1)
  }

  const summary: RunSummary = JSON.parse(readFileSync(jsonPath, 'utf-8'))

  // 生成摘要报告
  const report = generateSummaryReport(summary)
  const reportPath = await saveReport(report, `${runName}-summary.md`)
  console.log(`Summary report: ${reportPath}`)

  // 生成弱点报告
  const weakness = analyzeWeaknesses(summary)
  const weaknessReport = generateWeaknessReport(weakness)
  const weaknessPath = await saveReport(weaknessReport, `${runName}-weakness.md`)
  console.log(`Weakness report: ${weaknessPath}`)

  // 输出 top 建议
  console.log(`\n--- Top Recommendations ---`)
  for (const rec of weakness.topRecommendations) {
    console.log(rec)
  }
}

async function cmdCompare(args: Record<string, string>) {
  const runA = args['run-a']
  const runB = args['run-b']
  if (!runA || !runB) {
    console.error('Usage: eval:compare --run-a <name> --run-b <name>')
    process.exit(1)
  }

  const pathA = resolve('.eval-reports', `${runA}.json`)
  const pathB = resolve('.eval-reports', `${runB}.json`)

  if (!existsSync(pathA)) { console.error(`Run not found: ${runA}`); process.exit(1) }
  if (!existsSync(pathB)) { console.error(`Run not found: ${runB}`); process.exit(1) }

  const summaryA: RunSummary = JSON.parse(readFileSync(pathA, 'utf-8'))
  const summaryB: RunSummary = JSON.parse(readFileSync(pathB, 'utf-8'))

  const comparison = compareRuns(summaryA, summaryB)
  const report = generateComparisonReport(comparison, summaryA, summaryB)
  const reportPath = await saveReport(report, `compare-${runA}-vs-${runB}.md`)
  console.log(`Comparison report: ${reportPath}`)

  console.log(`\n--- Summary ---`)
  console.log(`Improved: ${comparison.improved.length} tasks`)
  console.log(`Regressed: ${comparison.regressed.length} tasks`)
  console.log(comparison.summary)
}

async function cmdAnalyze(args: Record<string, string>) {
  const runName = args['run-name']
  if (!runName) {
    console.error('Usage: eval:analyze --run-name <name>')
    process.exit(1)
  }

  const jsonPath = resolve('.eval-reports', `${runName}.json`)
  if (!existsSync(jsonPath)) {
    console.error(`No results found for run: ${runName}`)
    process.exit(1)
  }

  const summary: RunSummary = JSON.parse(readFileSync(jsonPath, 'utf-8'))
  const weakness = analyzeWeaknesses(summary)
  const report = generateWeaknessReport(weakness)

  const outputPath = args['output'] ?? `${runName}-weakness.md`
  const reportPath = await saveReport(report, outputPath)
  console.log(`Weakness report: ${reportPath}`)

  // 输出到控制台
  console.log(`\n--- Weakness Analysis ---`)
  for (const cat of weakness.categories) {
    console.log(`[${cat.severity.toUpperCase()}] ${cat.name}: ${cat.evidence}`)
    console.log(`  Fix: ${cat.recommendation}`)
  }
}

async function cmdIterate(args: Record<string, string>) {
  const model = args['model'] || getEnv('DEFAULT_MODEL', 'glm-5.1')
  const provider = args['provider'] ?? (model.startsWith('claude') || model.startsWith('glm-5') ? 'anthropic' : 'openai')
  const apiKey = args['api-key'] || getEnv('OPENAI_API_KEY') || getEnv('ANTHROPIC_API_KEY') || getEnv('DEEPSEEK_API_KEY')
  const baseURL = args['base-url'] ?? getDefaultBaseURL(provider)
  const maxIterations = args['max-iterations'] ? parseInt(args['max-iterations']) : 20
  const maxTurns = args['max-turns'] ? parseInt(args['max-turns']) : 15
  const validationInterval = args['validation-interval'] ? parseInt(args['validation-interval']) : 3
  const maxStagnation = args['max-stagnation'] ? parseInt(args['max-stagnation']) : 3
  const repeatRuns = args['repeat-runs'] ? parseInt(args['repeat-runs']) : 1

  const targetAider = args['target-aider'] ? parseInt(args['target-aider']) / 100 : 0.85
  const targetSwebench = args['target-swebench'] ? parseInt(args['target-swebench']) / 100 : 0.75

  if (!apiKey) {
    console.error('No API key found. Set ANTHROPIC_API_KEY in .env')
    process.exit(1)
  }

  // Judge 配置
  const judgeModel = args['judge-model'] ?? 'glm-4-flash'
  const judgeApiKey = getEnv('OPENAI_API_KEY') || getEnv('DEEPSEEK_API_KEY') || apiKey
  const judgeBaseURL = getEnv('OPENAI_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4'

  const engine = new IterationEngine({
    maxIterations,
    model,
    provider: provider as 'openai' | 'anthropic',
    apiKey,
    baseURL,
    maxTurns,
    targetPassRate: {
      'aider-polyglot': targetAider,
      'swebench-curated': targetSwebench,
    },
    validationInterval,
    maxStagnation,
    repeatRuns,
    judgeConfig: {
      apiKey: judgeApiKey,
      baseURL: judgeBaseURL,
      judgeModel: judgeModel,
    },
  })

  await engine.run()
}

// ---- Helpers ----

function getDefaultBaseURL(provider: string): string {
  if (provider === 'anthropic') return getEnv('ANTHROPIC_BASE_URL', 'https://open.bigmodel.cn/api/anthropic')
  if (provider === 'openai') return getEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
  return getEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
}

// ---- Main ----

async function cmdSplitAnalyze(args: Record<string, string>) {
  const dsKey = args.dataset ?? 'aider-polyglot'
  const ds = DATASETS[dsKey as keyof typeof DATASETS]
  if (!ds) {
    console.error(`Unknown dataset: ${dsKey}`)
    process.exit(1)
  }
  const dataFile = resolve(ds.file)
  const analysis = analyzeSplit(dataFile)
  console.log(formatSplitAnalysis(analysis))
}

async function main() {
  // 加载 .env
  try {
    const dotenv = await import('dotenv')
    dotenv.config({ path: resolve(process.cwd(), '.env') })
  } catch { /* .env not found, use env vars */ }

  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))

  switch (command) {
    case 'import':
      await cmdImport(args)
      break
    case 'run':
      await cmdRun(args)
      break
    case 'report':
      await cmdReport(args)
      break
    case 'compare':
      await cmdCompare(args)
      break
    case 'analyze':
      await cmdAnalyze(args)
      break
    case 'iterate':
      await cmdIterate(args)
      break
    case 'split-analyze':
      await cmdSplitAnalyze(args)
      break
    default:
      console.log(`wzxClaw Eval CLI

Usage: npx tsx scripts/eval/eval-cli.ts <command> [options]

Commands:
  import   Import benchmark datasets to Langfuse
  run      Run evaluation against a dataset
  report   Generate reports from a completed run
  compare  Compare two runs
  analyze  Analyze weaknesses in a run
  iterate  Self-iteration: evaluate → analyze → fix → re-evaluate

Options:
  --dataset=<name>      Dataset: aider-polyglot | swebench-curated (default: aider-polyglot)
  --model=<model>       Model to evaluate (default: glm-5.1)
  --provider=<type>     Provider: openai | anthropic (auto-detected)
  --run-name=<name>     Name for this evaluation run
  --limit=<n>           Only run N tasks (for quick testing)
  --max-turns=<n>       Max agent turns per task (default: 15)
  --judge-model=<model> Model for LLM Judge (default: glm-4-flash)
  --keep                Keep workspaces after evaluation
  --split=<type>        Only run train or test split tasks
  --run-a=<name>        First run for comparison
  --run-b=<name>        Second run for comparison
  --output=<file>       Output filename for analysis report
  --max-iterations=<n>  Max iterations for self-iteration (default: 20)
  --target-aider=<pct>  Target pass rate for Aider dataset (default: 85)
  --target-swebench=<pct> Target pass rate for SWE-bench dataset (default: 75)
  --validation-interval=<n> Test split validation every N iterations (default: 3)
  --max-stagnation=<n> Early stop after N consecutive non-improving iterations (default: 3)
  --repeat-runs=<n>   Repeat each eval N times, pick median to reduce noise (default: 1, recommended: 3)

Commands:
  split-analyze  Analyze train/test split quality for a dataset

Examples:
  npx tsx scripts/eval/eval-cli.ts split-analyze --dataset=aider-polyglot
  npx tsx scripts/eval/eval-cli.ts import
  npx tsx scripts/eval/eval-cli.ts run --dataset=aider-polyglot --model=glm-5.1 --limit=3
  npx tsx scripts/eval/eval-cli.ts run --dataset=aider-polyglot --split=train
  npx tsx scripts/eval/eval-cli.ts report --run-name=my-run
  npx tsx scripts/eval/eval-cli.ts compare --run-a=baseline --run-b=improved
  npx tsx scripts/eval/eval-cli.ts analyze --run-name=my-run
  npx tsx scripts/eval/eval-cli.ts iterate --max-iterations=10
  npx tsx scripts/eval/eval-cli.ts iterate --target-aider=90 --target-swebench=80`)
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})

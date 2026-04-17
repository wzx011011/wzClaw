// ============================================================
// 数据集导入脚本 — 将评测数据集推送到 Langfuse
// ============================================================

import { Langfuse } from 'langfuse'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Langfuse 配置 — 优先用 EVAL 专用 key，fallback 到通用 key
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_EVAL_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-78a706ff-29b5-49a6-8e68-222b9f88962e'
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_EVAL_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY ?? 'sk-lf-ab1adf9a-2420-4d78-ad5e-04b81e633ffb'
const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000'

interface DatasetItem {
  id: string
  source: string
  language: string
  difficulty: string
  description: string
  startingFiles: Record<string, string>
  testCommand?: string
  goldPatch?: string
  metadata: Record<string, string>
}

async function importDataset(datasetName: string, filePath: string, description: string): Promise<void> {
  const lf = new Langfuse({
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_BASE_URL,
  })

  // 读取数据文件
  const raw = readFileSync(resolve(filePath), 'utf-8')
  const items: DatasetItem[] = JSON.parse(raw)

  // 创建数据集（使用 v3 SDK 的 api 属性）
  try {
    await lf.api.datasetsCreate({
      name: datasetName,
      description,
      metadata: { version: '1.0', source: items[0]?.source ?? 'unknown', itemCount: items.length },
    })
    console.log(`Created dataset: ${datasetName}`)
  } catch (e: any) {
    if (e?.message?.includes('already exists') || e?.status === 409 || String(e).includes('409')) {
      console.log(`Dataset already exists: ${datasetName} (updating items)`)
    } else {
      console.log(`Dataset create note: ${e?.message ?? e}`)
    }
  }

  // 添加数据条目
  for (const item of items) {
    await lf.api.datasetItemsCreate({
      id: item.id,
      datasetName,
      input: {
        description: item.description,
        startingFiles: item.startingFiles,
        language: item.language,
      },
      expectedOutput: {
        testCommand: item.testCommand ?? null,
        goldPatch: item.goldPatch ?? null,
      },
      metadata: {
        difficulty: item.difficulty,
        category: item.metadata.category,
        source: item.source,
      },
    })
  }

  // 确保写入
  await lf.flushAsync()
  await lf.shutdownAsync()

  console.log(`Imported ${items.length} items into "${datasetName}"`)
}

async function main() {
  const dataset = process.argv.find(a => a.startsWith('--dataset='))?.split('=')[1] ?? 'all'

  const datasets = [
    {
      name: 'aider-polyglot-regression',
      file: 'data/eval/aider-polyglot-curated.json',
      description: 'Aider Polyglot regression benchmark — 10 code editing tasks for quick agent evaluation',
    },
    {
      name: 'swebench-verified-curated',
      file: 'data/eval/swebench-verified-curated.json',
      description: 'SWE-bench Verified curated — 5 bug-fix tasks for deep capability evaluation',
    },
  ]

  const toImport = dataset === 'all'
    ? datasets
    : datasets.filter(d => d.name.includes(dataset))

  for (const d of toImport) {
    await importDataset(d.name, d.file, d.description)
  }

  console.log('\nDone! Check Langfuse UI at http://192.168.100.78:3000')
}

main().catch(e => {
  console.error('Import failed:', e)
  process.exit(1)
})

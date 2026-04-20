// ============================================================
// Langfuse Dataset Run 清理工具
// 删除旧版版本化 runName 的废弃记录
// ============================================================

import { Langfuse } from 'langfuse'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

dotenvConfig({ path: resolve(process.cwd(), '.env') })

const DATASETS = [
  'aider-polyglot-regression',
  'swebench-verified-curated',
]

async function main(): Promise<void> {
  const lf = new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
    baseUrl: process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000',
  })

  let totalDeleted = 0

  for (const dsName of DATASETS) {
    console.log(`\nScanning dataset: ${dsName}`)
    try {
      const runs = await lf.api.datasetsGetRuns({ datasetName: dsName })
      const staleRuns = (runs.data ?? []).filter(
        r => /^iterate-(train|test)-v\d+/.test(r.name),
      )

      if (staleRuns.length === 0) {
        console.log('  No stale runs found.')
        continue
      }

      console.log(`  Found ${staleRuns.length} stale runs:`)
      for (const run of staleRuns) {
        process.stdout.write(`    Deleting ${run.name}...`)
        try {
          await lf.api.datasetsDeleteRun(dsName, run.name)
          console.log(' OK')
          totalDeleted++
        } catch (err) {
          console.log(` FAILED: ${err}`)
        }
      }
    } catch (err) {
      console.log(`  Error: ${err}`)
    }
  }

  await lf.shutdownAsync()
  console.log(`\nCleanup complete. Deleted ${totalDeleted} stale runs.`)
}

main().catch(console.error)

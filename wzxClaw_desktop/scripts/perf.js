#!/usr/bin/env node
// 运行 perf 测试（可选对比模式）
// 用法：
//   node scripts/perf.js              # 建立/刷新基线
//   node scripts/perf.js --compare    # 对比基线
const { spawnSync } = require('child_process')
const args = process.argv.slice(2)
const compare = args.includes('--compare')
const env = { ...process.env }
if (compare) env.PERF_COMPARE = '1'
const r = spawnSync('npx', ['playwright', 'test', 'test/perf/'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
})
process.exit(r.status ?? 1)

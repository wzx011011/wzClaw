// ============================================================
// SWE-bench 数据准备脚本 — 从 HuggingFace 下载并筛选题目
// ============================================================

import { writeFileSync } from 'fs'
import { resolve } from 'path'

/**
 * 从 HuggingFace SWE-bench Verified 数据集中筛选并转换任务
 *
 * 使用方法:
 * 1. 安装: pip install datasets
 * 2. 运行: python -c "from datasets import load_dataset; import json;
 *    ds = load_dataset('princeton-nlp/SWE-bench_Verified', split='test');
 *    items = [{'id': f'swebench-{i:03d}', 'source': 'swebench-verified',
 *    'language': 'python', 'difficulty': 'hard',
 *    'description': x['problem_statement'][:500],
 *    'startingFiles': {}, 'testCommand': None,
 *    'goldPatch': x['patch'],
 *    'metadata': {'category': 'bug-fix', 'repo': x['repo'],
 *    'instanceId': x['instance_id'], 'baseCommit': x['base_commit']}}
 *    for i, x in enumerate(ds)];
 *    json.dump(items, open('data/eval/swebench-verified-curated.json', 'w'), indent=2)"
 *
 * 注意：SWE-bench 的完整评测需要 Docker + 大量磁盘空间
 * 当前 data/eval/swebench-verified-curated.json 包含的是手工精简的简化题目
 * 完整的 SWE-bench Verified 数据集有 500 条真实 GitHub issue
 */

// 手动精选的一些代表性 SWE-bench 风格任务（已在 swebench-verified-curated.json 中）
// 如需完整的 SWE-bench 数据，请使用上面的 Python 命令下载

console.log('SWE-bench data preparation')
console.log('')
console.log('For the full SWE-bench Verified dataset (500 tasks):')
console.log('  1. pip install datasets')
console.log('  2. Run the Python snippet in this file')
console.log('')
console.log('Current curated dataset: data/eval/swebench-verified-curated.json (5 simplified tasks)')
console.log('These are standalone tasks that can run without cloning real repos.')

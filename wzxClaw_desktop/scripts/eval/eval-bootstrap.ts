#!/usr/bin/env npx tsx
// ============================================================
// wzxClaw Eval CLI 入口
//
// 这个文件必须在所有 Langfuse 相关 import 之前执行，
// 确保评测数据写入 wzxclaw-eval 项目而非生产项目。
// ============================================================

import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'

// 1. 加载 .env
dotenvConfig({ path: resolve(process.cwd(), '.env') })

// 2. 切换到评测项目的 key（在 langfuse-observer singleton 初始化之前）
if (process.env.LANGFUSE_EVAL_PUBLIC_KEY) {
  process.env.LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_EVAL_PUBLIC_KEY
}
if (process.env.LANGFUSE_EVAL_SECRET_KEY) {
  process.env.LANGFUSE_SECRET_KEY = process.env.LANGFUSE_EVAL_SECRET_KEY
}

// 3. 现在才 import 会用到 Langfuse 的模块
//    langfuse-observer.ts 的 getClient() 会读取已覆盖的 env vars
void import('./eval-cli-impl')

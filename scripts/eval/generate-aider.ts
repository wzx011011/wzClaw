#!/usr/bin/env npx tsx
// 从 Aider Polyglot benchmark 拉取真实练习题（v4 - 直接用 raw URL，绕过 GitHub API 限流）
// 文件命名规则（从 GitHub API 已确认）：
//   Python:     exercise_name.py + exercise_name_test.py
//   JavaScript: exercise-name.js + exercise-name.spec.js
//   Go:         exercise_name.go + exercise_name_test.go (+ cases_test.go)
//   Rust:       src/lib.rs + tests/exercise-name.rs + Cargo.toml

import { writeFileSync, readFileSync } from 'fs'
import { resolve } from 'path'

const OUTPUT = resolve(__dirname, '../../data/eval/aider-polyglot-curated.json')
const RAW = 'https://raw.githubusercontent.com/Aider-AI/polyglot-benchmark/main'

// snake_case for Python/Go files, kebab-case for JS, varies for Rust
function snakeCase(s: string): string {
  return s.replace(/-/g, '_')
}

const EXERCISES: [string, string, string, string][] = [
  // Python 20
  ['python', 'beer-song', 'medium', 'implementation'],
  ['python', 'book-store', 'hard', 'algorithm'],
  ['python', 'bowling', 'medium', 'algorithm'],
  ['python', 'connect', 'hard', 'algorithm'],
  ['python', 'dominoes', 'hard', 'algorithm'],
  ['python', 'food-chain', 'medium', 'implementation'],
  ['python', 'forth', 'hard', 'parsing'],
  ['python', 'grade-school', 'medium', 'data-structure'],
  ['python', 'grep', 'medium', 'parsing'],
  ['python', 'hangman', 'medium', 'implementation'],
  ['python', 'list-ops', 'medium', 'data-structure'],
  ['python', 'phone-number', 'medium', 'parsing'],
  ['python', 'poker', 'hard', 'algorithm'],
  ['python', 'proverb', 'easy', 'implementation'],
  ['python', 'react', 'hard', 'data-structure'],
  ['python', 'robot-name', 'medium', 'implementation'],
  ['python', 'simple-linked-list', 'medium', 'data-structure'],
  ['python', 'transpose', 'medium', 'implementation'],
  ['python', 'wordy', 'medium', 'parsing'],
  ['python', 'zebra-puzzle', 'hard', 'algorithm'],
  // JavaScript 10
  ['javascript', 'beer-song', 'medium', 'implementation'],
  ['javascript', 'bowling', 'medium', 'algorithm'],
  ['javascript', 'complex-numbers', 'medium', 'implementation'],
  ['javascript', 'food-chain', 'medium', 'implementation'],
  ['javascript', 'grade-school', 'medium', 'data-structure'],
  ['javascript', 'pig-latin', 'medium', 'parsing'],
  ['javascript', 'say', 'medium', 'implementation'],
  ['javascript', 'simple-linked-list', 'medium', 'data-structure'],
  ['javascript', 'wordy', 'medium', 'parsing'],
  ['javascript', 'palindrome-products', 'hard', 'algorithm'],
  // Go 5
  ['go', 'beer-song', 'medium', 'implementation'],
  ['go', 'bowling', 'medium', 'algorithm'],
  ['go', 'pig-latin', 'medium', 'parsing'],
  ['go', 'simple-linked-list', 'medium', 'data-structure'],
  ['go', 'wordy', 'medium', 'parsing'],
  // Rust 5
  ['rust', 'acronym', 'easy', 'implementation'],
  ['rust', 'beer-song', 'medium', 'implementation'],
  ['rust', 'pig-latin', 'medium', 'parsing'],
  ['rust', 'grade-school', 'medium', 'data-structure'],
  ['rust', 'wordy', 'medium', 'parsing'],
]

const LANG_TEST_CMD: Record<string, string> = {
  python: 'cd $WORKSPACE && python -m pytest',
  javascript: 'cd $WORKSPACE && npm test',
  go: 'cd $WORKSPACE && go test -v ./...',
  rust: 'cd $WORKSPACE && cargo test',
}

// 构建文件 URL 列表（按优先级）
function getFileURLs(lang: string, exercise: string): { stubURLs: string[], testURLs: string[], extraURLs: Record<string, string> } {
  const base = `${RAW}/${lang}/exercises/practice/${exercise}`
  const sc = snakeCase(exercise)

  switch (lang) {
    case 'python':
      return {
        stubURLs: [`${base}/${sc}.py`],
        testURLs: [`${base}/${sc}_test.py`],
        extraURLs: {},
      }
    case 'javascript':
      return {
        stubURLs: [`${base}/${exercise}.js`],
        testURLs: [`${base}/${exercise}.spec.js`],
        extraURLs: {
          'package.json': `${base}/package.json`,
        },
      }
    case 'go':
      return {
        stubURLs: [`${base}/${sc}.go`],
        testURLs: [`${base}/${sc}_test.go`, `${base}/cases_test.go`],
        extraURLs: {
          'go.mod': `${base}/go.mod`,
        },
      }
    case 'rust':
      return {
        stubURLs: [`${base}/src/lib.rs`],
        testURLs: [`${base}/tests/${exercise}.rs`],
        extraURLs: {
          'Cargo.toml': `${base}/Cargo.toml`,
        },
      }
    default:
      return { stubURLs: [], testURLs: [], extraURLs: {} }
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'wzxClaw-eval' },
    })
    if (!resp.ok) return null
    return await resp.text()
  } catch { return null }
}

async function main() {
  console.log('Fetching real exercises from Aider Polyglot benchmark (v4 - raw URLs)...\n')

  const existing = JSON.parse(readFileSync(OUTPUT, 'utf-8'))
  // 给已有任务加 split 标记
  for (let i = 0; i < existing.length; i++) {
    if (!existing[i].metadata.split) {
      existing[i].metadata.split = ((i + 1) % 7 < 5) ? 'train' : 'test'
    }
  }
  console.log(`Existing tasks: ${existing.length}`)

  const tasks = [...existing]
  let taskNum = existing.length + 1

  for (const [lang, exerciseName, difficulty, category] of EXERCISES) {
    const { stubURLs, testURLs, extraURLs } = getFileURLs(lang, exerciseName)

    // Fetch stub (first successful URL)
    let stubContent: string | null = null
    let stubName: string = ''
    for (const url of stubURLs) {
      const content = await fetchText(url)
      if (content) {
        stubContent = content
        stubName = url.split('/').pop()!
        break
      }
    }

    // Fetch test files (all successful)
    const testFiles: Record<string, string> = {}
    for (const url of testURLs) {
      const content = await fetchText(url)
      if (content) {
        const name = url.split('/').pop()!
        testFiles[name] = content
      }
    }

    // Fetch extra files (package.json, go.mod, Cargo.toml)
    const extraFiles: Record<string, string> = {}
    for (const [name, url] of Object.entries(extraURLs)) {
      const content = await fetchText(url)
      if (content) extraFiles[name] = content
    }

    if (!stubContent || Object.keys(testFiles).length === 0) {
      console.log(`  SKIP ${lang}/${exerciseName}: stub=${!!stubContent} test=${Object.keys(testFiles).length > 0}`)
      continue
    }

    const id = `aider-pg-${String(taskNum).padStart(3, '0')}`
    const split = (taskNum % 7 < 5) ? 'train' : 'test'

    const startingFiles: Record<string, string> = {
      [stubName]: stubContent,
      ...testFiles,
      ...extraFiles,
    }

    // For Rust, adjust paths
    if (lang === 'rust' && stubName === 'lib.rs') {
      startingFiles['src/lib.rs'] = startingFiles['lib.rs']
      delete startingFiles['lib.rs']
    }

    // Determine primary test file for test command
    const primaryTest = Object.keys(testFiles).find(n => n.includes('_test.') || n.includes('.spec.')) || Object.keys(testFiles)[0]

    tasks.push({
      id,
      source: 'aider-polyglot',
      language: lang,
      difficulty,
      description: `Implement ${exerciseName.replace(/-/g, ' ')} in ${lang}`,
      startingFiles,
      testCommand: LANG_TEST_CMD[lang],
      metadata: { category, split },
    })

    taskNum++
    console.log(`  ✓ ${id}: ${lang}/${exerciseName} (${difficulty}) [${split}] - ${Object.keys(startingFiles).join(', ')}`)
    await new Promise(r => setTimeout(r, 100))
  }

  writeFileSync(OUTPUT, JSON.stringify(tasks, null, 2))
  const train = tasks.filter((t: any) => t.metadata.split === 'train').length
  const test = tasks.filter((t: any) => t.metadata.split === 'test').length
  const noSplit = tasks.filter((t: any) => !t.metadata.split).length
  console.log(`\nDone! ${tasks.length} total tasks (train: ${train}, test: ${test}, no-split: ${noSplit})`)
}

main().catch(e => { console.error(e); process.exit(1) })

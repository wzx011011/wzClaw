// ============================================================
// Prompt 优化器 — 根据 WeaknessReport 生成 system prompt 增补规则
// 规则映射到 weakness-analyzer.ts 的 7 个检测规则
// ============================================================

import type { WeaknessReport } from './types'

/** 弱点模式 → prompt 增补规则的映射 */
const OPTIMIZATION_RULES: Record<string, (evidence: string) => string> = {
  test_failure_high: () =>
    'CRITICAL: After writing or modifying code, you MUST run the test command to verify your solution. If any tests fail, read the test output carefully and fix the issues before finishing. Never submit code without running tests.',

  test_failure_moderate: () =>
    'Before implementing, read the test file to understand expected behavior and edge cases. Implement the solution to satisfy all test cases, then run the test command to verify.',

  high_turn_count: () =>
    'EFFICIENCY: Plan your approach before acting. Read all relevant files first, design your solution mentally, then implement it in as few steps as possible. Avoid re-reading files you have already seen. Minimize redundant tool calls.',

  easy_tasks_failing: () =>
    'For straightforward tasks, implement the solution directly without overthinking. Simple functions like palindromes, flatten, or word count should be implemented in a single pass. Do not add unnecessary complexity to simple problems.',

  low_efficiency: () =>
    'Be efficient with tool calls. Batch your reads: read all necessary files first, plan your edits, then apply them. Each tool call should serve a clear purpose. Avoid reading a file, making one small change, then reading it again.',

  runtime_errors: () =>
    'If a tool call fails, read the error message carefully and adjust your approach. Common issues: file paths must be relative to the workspace, shell commands must use correct syntax for the OS.',

  // 语言特定规则（动态匹配）
  weak_language_python: () =>
    'PYTHON GUIDANCE: Use type hints. Prefer list comprehensions over map/filter. Use f-strings for formatting. Handle edge cases: None, empty strings, empty lists. Use collections module for specialized data structures (Counter, defaultdict, deque).',

  weak_language_javascript: () =>
    'JAVASCRIPT GUIDANCE: Use const/let not var. For module exports use module.exports for CommonJS. Use Array methods (map, filter, reduce, flatMap). Handle edge cases: undefined, null, empty arrays. Use Object.entries/keys/values for object iteration.',

  weak_language_typescript: () =>
    'TYPESCRIPT GUIDANCE: Define proper interfaces and types. Use generics where appropriate. Use Array<T> methods. Handle undefined/null with optional chaining and nullish coalescing.',

  weak_language_go: () =>
    'GO GUIDANCE: Handle errors explicitly (if err != nil). Use range for iteration. Prefer slices over arrays. Use make() for maps and slices. Remember Go tests use t *testing.T and t.Errorf/t.Fatalf.',

  weak_language_rust: () =>
    'RUST GUIDANCE: Use Option<T> and Result<T, E> properly. Borrow with & and &mut. Use iter() and collect() for transformations. Use #[derive(Debug)] for structs. Handle .unwrap() carefully in production code.',

  // 类别特定规则
  weak_category_algorithm: () =>
    'ALGORITHM GUIDANCE: Consider time and space complexity. O(n) or O(n log n) solutions are usually expected. For search problems, consider binary search. For optimization, consider dynamic programming or greedy approaches.',

  weak_category_data_structure: () =>
    'DATA STRUCTURE GUIDANCE: Choose the right structure for the problem. HashMap/dict for O(1) lookups. Deque for FIFO/LIFO. Heap for top-K problems. Linked list for O(1) insertion/deletion. Tree for hierarchical data.',

  weak_category_bug_fix: () =>
    'BUG FIX GUIDANCE: Read the code carefully to identify the bug. Look for: off-by-one errors, wrong conditions (< vs <=), missing edge cases, incorrect regex patterns, type mismatches. Fix only the bug, do not refactor surrounding code.',

  weak_category_parsing: () =>
    'PARSING GUIDANCE: Handle all edge cases: empty input, malformed input, special characters. Use proper escaping for regex. Consider using state machines for complex parsers. Test with boundary inputs.',

  weak_category_error_handling: () =>
    'ERROR HANDLING GUIDANCE: Validate inputs at function entry. Raise appropriate exceptions with clear messages. Handle None/null/empty cases. Use try/except for operations that can fail (file I/O, parsing, network).',
}

/** 增补规则标记前缀（用于检测是否已添加） */
const MARKER_PREFIX = '/* EVAL-OPT:'

/**
 * 根据弱点报告生成 system prompt 增补
 *
 * @param currentPrompt 当前 system prompt
 * @param report 弱点分析报告
 * @returns { prompt: string, changes: string[] } 新 prompt 和变更列表
 */
export function optimizePrompt(
  currentPrompt: string,
  report: WeaknessReport,
): { prompt: string; changes: string[] } {
  const changes: string[] = []
  const additions: string[] = []

  for (const category of report.categories) {
    const ruleKey = category.name
    const ruleFn = OPTIMIZATION_RULES[ruleKey]

    if (!ruleFn) {
      // 尝试匹配语言特定规则（weak_language_xxx → weak_language_python 等）
      const langMatch = ruleKey.match(/^weak_language_(\w+)$/)
      if (langMatch) {
        const langRule = OPTIMIZATION_RULES[`weak_language_${langMatch[1]}`]
        if (langRule) {
          const addition = langRule(category.evidence)
          const marker = `${MARKER_PREFIX} ${ruleKey} */`
          if (!currentPrompt.includes(marker)) {
            additions.push(`${marker}\n${addition}`)
            changes.push(`Added ${ruleKey} guidance`)
          }
          continue
        }
      }
      // 尝试匹配类别特定规则
      const catMatch = ruleKey.match(/^weak_category_(\w+)$/)
      if (catMatch) {
        const catRule = OPTIMIZATION_RULES[`weak_category_${catMatch[1]}`]
        if (catRule) {
          const addition = catRule(category.evidence)
          const marker = `${MARKER_PREFIX} ${ruleKey} */`
          if (!currentPrompt.includes(marker)) {
            additions.push(`${marker}\n${addition}`)
            changes.push(`Added ${ruleKey} guidance`)
          }
          continue
        }
      }
      continue
    }

    const addition = ruleFn(category.evidence)
    const marker = `${MARKER_PREFIX} ${ruleKey} */`

    // 幂等：如果已存在此规则则跳过
    if (currentPrompt.includes(marker)) {
      continue
    }

    additions.push(`${marker}\n${addition}`)
    changes.push(`Added ${ruleKey} guidance`)
  }

  if (additions.length === 0) {
    return { prompt: currentPrompt, changes: [] }
  }

  const augmentation = `\n\n# Eval-Optimized Guidance\n\n${additions.join('\n\n')}\n`
  return {
    prompt: currentPrompt + augmentation,
    changes,
  }
}

/**
 * 从 prompt 中移除所有 eval-optimized 增补（用于完全回滚）
 */
export function stripOptimizations(prompt: string): string {
  const markerIndex = prompt.indexOf('# Eval-Optimized Guidance')
  if (markerIndex === -1) return prompt
  return prompt.slice(0, markerIndex).trimEnd()
}

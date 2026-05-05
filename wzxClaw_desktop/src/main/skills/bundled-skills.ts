// ============================================================
// Bundled Skills — skills that ship with the app
// Modeled after Claude Code's bundledSkills.ts
// ============================================================

import type { Skill, SkillSource } from '../../shared/types-skill'

export interface BundledSkillDefinition {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  /** Get the prompt content for this bundled skill */
  getPrompt: (args: string) => Promise<string>
}

// Internal registry
const bundledSkills: Skill[] = []

/**
 * Register a bundled skill that will be available to all users.
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const skill: Skill = {
    name: definition.name,
    displayName: definition.name,
    description: definition.description,
    hasUserSpecifiedDescription: true,
    source: 'bundled' as SkillSource,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    argumentNames: [],
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    executionContext: 'inline',
    isHidden: !(definition.userInvocable ?? true),
    contentLength: 0,
    isEnabled: definition.isEnabled?.() ?? true,
    aliases: definition.aliases,
    getPrompt: definition.getPrompt,
  }
  bundledSkills.push(skill)
}

/**
 * Get all registered bundled skills.
 */
export function getBundledSkills(): Skill[] {
  return [...bundledSkills]
}

/**
 * Clear bundled skills registry (for testing).
 */
export function clearBundledSkills(): void {
  bundledSkills.length = 0
}

// ============================================================
// Register all bundled skills at module load time
// ============================================================

registerBundledSkill({
  name: 'init',
  description: 'Analyze the codebase and generate a WZXCLAW.md project instructions file',
  argumentHint: '[project-path]',
  whenToUse: 'User wants to initialize project instructions, create a CLAUDE.md/WZXCLAW.md file, or analyze project structure',
  getPrompt: async (_args: string) => {
    return `Please analyze this codebase and create a WZXCLAW.md file in the project root.

First, explore the project to understand:
- Package manager and key scripts (package.json, Cargo.toml, pyproject.toml, Makefile, etc.)
- README and existing documentation
- Directory structure and main source directories
- Test setup and how to run tests
- Lint/format configuration
- Any existing .cursorrules, CLAUDE.md, or similar instruction files

Then create WZXCLAW.md with ONLY the following (omit sections that don't apply):
1. **Build & Dev Commands** — non-obvious commands only
2. **Architecture Overview** — 3-5 sentences on how the codebase is organized
3. **Key Conventions** — coding style rules that differ from language defaults
4. **Development Notes** — gotchas, non-obvious setup, environment requirements

Rules:
- Only include info that would prevent mistakes if missing
- Do NOT include obvious conventions or describe every file
- Keep it under 100 lines
- Start the file with: "## Project\\n\\n[one-line project description]\\n\\n"
- If WZXCLAW.md already exists, suggest improvements rather than overwriting blindly`
  },
})

registerBundledSkill({
  name: 'commit',
  description: 'Analyze git changes and generate a commit message',
  whenToUse: 'User wants to commit code, generate a commit message, or review staged/unstaged changes for committing',
  getPrompt: async (_args: string) => {
    return `分析当前 git 变更并生成 commit message。

步骤：
1. 先运行 git status 查看有哪些文件变更
2. 运行 git diff 查看具体变更内容
3. 如果有暂存区变更，也运行 git diff --cached

然后生成一个 commit message，规则：
- message 用中文，格式：<type>: <简短描述>
- type 从 feat/fix/refactor/docs/test/chore 中选
- 如果变更较多，添加简短的正文说明关键改动
- 不要执行 git commit，只输出建议的 commit message
- 如果没有变更，告诉用户没有需要提交的内容`
  },
})

registerBundledSkill({
  name: 'review',
  description: 'Review current git changes for bugs, security issues, and code quality',
  whenToUse: 'User wants to review code changes, check for bugs, security issues, or code quality before committing',
  getPrompt: async (_args: string) => {
    return `审查当前 git 暂存区和工作区的代码变更。

步骤：
1. 运行 git status 查看变更文件
2. 运行 git diff 查看具体变更内容
3. 如果有暂存区变更，也运行 git diff --cached

审查规则：
- 按严重程度分级：Critical / High / Medium / Low
- 每个问题给出：文件路径、行号、问题描述、修复建议
- 关注：安全漏洞、逻辑错误、性能问题、代码风格
- 如果没有变更，告诉用户没有需要审查的内容
- 最后给出整体评价和建议`
  },
})

registerBundledSkill({
  name: 'compact',
  description: 'Compact the current conversation context to free up token space',
  whenToUse: 'User wants to reduce context window usage, compact conversation history, or free up token space',
  disableModelInvocation: true, // compact is handled as an action, not prompt injection
  getPrompt: async (_args: string) => {
    // Compact is handled as an action-type command in the renderer.
    // This prompt is a fallback if the model tries to invoke it directly.
    return `Please compact the current conversation context. Summarize the key information from our discussion so far into a concise summary that preserves the essential context needed to continue working.`
  },
})

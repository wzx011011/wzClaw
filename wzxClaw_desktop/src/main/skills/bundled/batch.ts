// ============================================================
// /batch — Parallel Work Orchestration (from Claude Code)
// Research and plan a large-scale change, then execute in parallel
// ============================================================

import { registerBundledSkill } from '../bundled-skills'

const MIN_AGENTS = 5
const MAX_AGENTS = 30

const WORKER_INSTRUCTIONS = `After you finish implementing the change:
1. **Simplify** — Review and clean up your changes.
2. **Run unit tests** — Run the project's test suite. If tests fail, fix them.
3. **Commit and push** — Commit all changes with a clear message.
4. **Report** — End with a single line: \`DONE: <summary>\` so the coordinator can track it.`

function buildBatchPrompt(instruction: string): string {
  return `# Batch: Parallel Work Orchestration

You are orchestrating a large, parallelizable change across this codebase.

## User Instruction

${instruction}

## Phase 1: Research and Plan (Plan Mode)

Enter plan mode first, then:

1. **Understand the scope.** Launch one or more subagents (in the foreground — you need their results) to deeply research what this instruction touches. Find all the files, patterns, and call sites that need to change. Understand the existing conventions so the migration is consistent.

2. **Decompose into independent units.** Break the work into ${MIN_AGENTS}–${MAX_AGENTS} self-contained units. Each unit must:
   - Be independently implementable (no shared state with sibling units)
   - Be roughly uniform in size (split large units, merge trivial ones)

   Scale the count to the actual work: few files → closer to ${MIN_AGENTS}; hundreds of files → closer to ${MAX_AGENTS}. Prefer per-directory or per-module slicing over arbitrary file lists.

3. **Write the plan.** In your plan file, include:
   - A summary of what you found during research
   - A numbered list of work units — for each: a short title, the list of files/directories it covers, and a one-line description of the change
   - The exact worker instructions you will give each agent (the shared template)

4. Present the plan for user approval.

## Phase 2: Spawn Workers (After Plan Approval)

Once the plan is approved, spawn one background agent per work unit using the Agent tool. All agents must run in parallel.

For each agent, the prompt must be fully self-contained. Include:
- The overall goal (the user's instruction)
- This unit's specific task (title, file list, change description — copied verbatim from your plan)
- Any codebase conventions you discovered that the worker needs to follow
- The worker instructions below, copied verbatim:

\`\`\`
${WORKER_INSTRUCTIONS}
\`\`\`

## Phase 3: Track Progress

After launching all workers, render an initial status table:

| # | Unit | Status |
|---|------|--------|
| 1 | <title> | running |
| 2 | <title> | running |

As background-agent completion notifications arrive, update the table with status (done / failed). Keep a brief failure note for any agent that failed.

When all agents have reported, render the final table and a one-line summary.`
}

const NOT_A_GIT_REPO_MESSAGE = `This is not a git repository. The \`/batch\` command works best with a git repo. Initialize a repo first, or run this from inside an existing one.`

const MISSING_INSTRUCTION_MESSAGE = `Provide an instruction describing the batch change you want to make.

Examples:
  /batch migrate from react to vue
  /batch replace all uses of lodash with native equivalents
  /batch add type annotations to all untyped function parameters`

export function registerBatchSkill(): void {
  registerBundledSkill({
    name: 'batch',
    description:
      'Research and plan a large-scale change, then execute it in parallel across multiple isolated agents.',
    whenToUse:
      'Use when the user wants to make a sweeping, mechanical change across many files (migrations, refactors, bulk renames) that can be decomposed into independent parallel units.',
    argumentHint: '<instruction>',
    userInvocable: true,
    disableModelInvocation: true,
    async getPrompt(args) {
      const instruction = args.trim()
      if (!instruction) {
        return MISSING_INSTRUCTION_MESSAGE
      }
      return buildBatchPrompt(instruction)
    },
  })
}

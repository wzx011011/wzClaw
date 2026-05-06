// ============================================================
// /verify — Verify code changes with testing (from Claude Code)
// Verifies that a change works correctly through testing
// ============================================================

import { registerBundledSkill } from '../bundled-skills'

const VERIFY_PROMPT = `# Verify: End-to-End Change Verification

Verify that the most recent change (or specified change) works correctly end-to-end.

## Step 1: Identify the Change

Run \`git diff\` or \`git diff HEAD\` to see what changed. If the user specified a particular change or PR, focus on that instead.

Summarize:
- What was changed (files and scope)
- What the change is supposed to do (from commit messages, PR description, or code comments)

## Step 2: Understand the Testing Landscape

1. **Find the test runner**: Check package.json scripts, Makefile, or common test commands (npm test, pytest, go test, cargo test, bun test, etc.)
2. **Find existing tests for the changed code**: Look for test files adjacent to or mirroring the changed files
3. **Check for CI configuration**: .github/workflows, Jenkinsfile, .gitlab-ci.yml — what tests does CI run?

## Step 3: Write and Run Tests

Based on the change:

1. **If existing tests cover the change**: Run them. If they pass, note what they verify.
2. **If no tests exist**: Write tests that verify:
   - The happy path (expected input → expected output)
   - Edge cases relevant to the change
   - Error handling if the change adds error paths
3. **Run all tests** and report results
4. **Fix any failing tests** — either adjust the tests if they were wrong, or fix the code if the tests found a real bug

## Step 4: Manual Verification (if applicable)

For changes that affect UI, CLI, or runtime behavior:
- Describe the manual steps to verify the change
- If there's a dev server, suggest how to start it and what to check
- If there's a CLI command, suggest what to run and expected output

## Step 5: Report

Provide a clear report:

\`\`\`
## Verification Report

**Change**: [summary]
**Files changed**: [list]
**Test coverage**: [existing/new/none]
**Test results**: [pass/fail with details]
**Manual verification**: [steps or "automated tests sufficient"]
**Verdict**: ✅ Verified / ❌ Issues found / ⚠️ Partially verified
\`\`\`

If issues were found, fix them and re-verify.`

export function registerVerifySkill(): void {
  registerBundledSkill({
    name: 'verify',
    description:
      'Verify that a code change works correctly by running tests and checking behavior end-to-end',
    whenToUse:
      'Use when the user wants to verify a change works, test their code, or check if something is correct. Examples: "verify this works", "test the change", "check if this is right".',
    argumentHint: '[description of what to verify]',
    userInvocable: true,
    async getPrompt(args) {
      let prompt = VERIFY_PROMPT
      if (args) {
        prompt += `\n\n## User Focus\n\n${args}`
      }
      return prompt
    },
  })
}

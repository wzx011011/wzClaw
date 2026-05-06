// ============================================================
// /skillify — Capture session process into a reusable skill
// (adapted from Claude Code's skillify bundled skill)
// ============================================================

import { registerBundledSkill } from '../bundled-skills'

const SKILLIFY_PROMPT = `# Skillify: Create a Reusable Skill from This Session

You are capturing this session's repeatable process as a reusable skill.

## Your Task

### Step 1: Analyze the Session

Before asking any questions, analyze the session to identify:
- What repeatable process was performed
- What the inputs/parameters were
- The distinct steps (in order)
- The success criteria for each step
- Where the user corrected or steered you
- What tools and permissions were needed
- What the goals and success artifacts were

### Step 2: Interview the User

Use AskUserQuestion to understand what the user wants to automate. Important notes:
- Use AskUserQuestion for ALL questions! Never ask questions via plain text.
- For each round, iterate as much as needed until the user is happy.
- The user always has a freeform "Other" option to type edits or feedback.

**Round 1: High level confirmation**
- Suggest a name and description for the skill based on your analysis. Ask the user to confirm or rename.
- Suggest high-level goal(s) and specific success criteria for the skill.

**Round 2: More details**
- Present the high-level steps you identified as a numbered list.
- If you think the skill will require arguments, suggest arguments based on what you observed.
- Ask where the skill should be saved. Options:
  - **This repo** (\`.wzxclaw/skills/<name>/SKILL.md\`) — for workflows specific to this project
  - **Personal** (\`~/.wzxclaw/skills/<name>/SKILL.md\`) — follows you across all repos

**Round 3: Breaking down each step**
For each major step, ask:
- What does this step produce that later steps need?
- What proves that this step succeeded?
- Should the user be asked to confirm before proceeding?
- Are any steps independent and could run in parallel?

You may do multiple rounds of AskUserQuestion here.

**Round 4: Final questions**
- Confirm when this skill should be invoked, and suggest trigger phrases.
- Ask for any other gotchas or things to watch out for.

Stop interviewing once you have enough information. Don't over-ask for simple processes!

### Step 3: Write the SKILL.md

Create the skill directory and file at the location the user chose in Round 2.

Use this format:

\`\`\`markdown
---
name: {{skill-name}}
description: {{one-line description}}
allowed-tools:
  {{list of tool permission patterns}}
when_to_use: {{detailed description of when to use, including trigger phrases}}
argument-hint: "{{hint showing argument placeholders}}"
arguments:
  {{list of argument names}}
---

# {{Skill Title}}

Description of skill.

## Inputs
- \`$arg_name\`: Description of this input

## Goal
Clearly stated goal. Best with clearly defined artifacts or criteria for completion.

## Steps

### 1. Step Name
What to do in this step. Be specific and actionable.

**Success criteria**: ALWAYS include this!

...
\`\`\`

**Per-step annotations**:
- **Success criteria** is REQUIRED on every step.
- **Artifacts**: Data this step produces that later steps need.
- **Human checkpoint**: When to pause and ask the user before proceeding.
- **Rules**: Hard rules for the workflow.

**Step structure tips:**
- Steps that can run concurrently use sub-numbers: 3a, 3b
- Keep simple skills simple -- a 2-step skill doesn't need annotations on every step

### Step 4: Confirm and Save

Before writing the file, output the complete SKILL.md content so the user can review. Then ask for confirmation using AskUserQuestion.

After writing, tell the user:
- Where the skill was saved
- How to invoke it: \`/{{skill-name}} [arguments]\`
- That they can edit the SKILL.md directly to refine it`

export function registerSkillifySkill(): void {
  registerBundledSkill({
    name: 'skillify',
    description:
      "Capture this session's repeatable process into a reusable skill.",
    allowedTools: [
      'FileRead',
      'FileWrite',
      'FileEdit',
      'Glob',
      'Grep',
      'AskUserQuestion',
    ],
    userInvocable: true,
    disableModelInvocation: true,
    argumentHint: '[description of the process you want to capture]',
    async getPrompt(args) {
      let prompt = SKILLIFY_PROMPT
      if (args) {
        prompt += `\n\n## User Description\n\nThe user described this process as: "${args}"`
      }
      return prompt
    },
  })
}

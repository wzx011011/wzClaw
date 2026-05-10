// ============================================================
// Compact Prompt Templates — Claude Code style
// Full migration from Claude Code src/services/compact/prompt.ts
// ============================================================
import type { PartialCompactDirection } from '../../shared/types'

const NO_TOOLS_PREAMBLE = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.\n- You already have all the context you need in the conversation above.\n- Tool calls will be REJECTED and will waste your only turn.\n- Your entire response must be plain text: an <analysis> block followed by a <summary> block.\n\n'

const ANALYSIS_BASE = 'Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis process:\n\n1. Chronologically analyze each message. For each section thoroughly identify:\n   - The user explicit requests and intents\n   - Your approach to addressing the user requests\n   - Key decisions, technical concepts and code patterns\n   - Specific details like file names, full code snippets, function signatures, file edits\n   - Errors that you ran into and how you fixed them\n   - Pay special attention to specific user feedback.\n2. Double-check for technical accuracy and completeness.'

const ANALYSIS_PARTIAL = 'Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis process:\n\n1. Analyze the recent messages chronologically. For each section identify:\n   - The user explicit requests and intents\n   - Key decisions, technical concepts and code patterns\n   - Specific details like file names, code snippets, function signatures\n   - Errors and how they were fixed\n   - Pay special attention to user feedback.\n2. Double-check for technical accuracy and completeness.'

const SECTIONS_FULL = '1. Primary Request and Intent: Capture all user explicit requests in detail\n2. Key Technical Concepts: List all important technical concepts discussed.\n3. Files and Code Sections: Enumerate specific files examined, modified, or created. Include full code snippets.\n4. Errors and fixes: List all errors and how they were fixed.\n5. Problem Solving: Document problems solved and ongoing troubleshooting.\n6. All user messages: List ALL user messages that are not tool results.\n7. Pending Tasks: Outline any pending tasks.\n8. Current Work: Describe in detail what was being worked on before this summary request.\n9. Optional Next Step: List the next step related to the most recent work. Include direct quotes.'

const SECTIONS_PARTIAL = '1. Primary Request and Intent from recent messages\n2. Key Technical Concepts discussed recently\n3. Files and Code Sections examined, modified, or created\n4. Errors and fixes\n5. Problem Solving\n6. All user messages from the recent portion\n7. Pending Tasks\n8. Current Work\n9. Optional Next Step'

const SECTIONS_UP_TO = '1. Primary Request and Intent\n2. Key Technical Concepts\n3. Files and Code Sections\n4. Errors and fixes\n5. Problem Solving\n6. All user messages\n7. Pending Tasks\n8. Work Completed\n9. Context for Continuing Work'

const EXAMPLE = '<example>\n<analysis>\n[Your thought process]\n</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   [Detailed description]\n\n2. Key Technical Concepts:\n   - [Concept]\n\n3. Files and Code Sections:\n   - [File Name]\n      - [Why important]\n      - [Code Snippet]\n\n4. Errors and fixes:\n    - [Error]: [Fix]\n\n5. Problem Solving:\n   [Description]\n\n6. All user messages:\n    - [Message]\n\n7. Pending Tasks:\n    - [Task]\n\n8. Current Work:\n   [Description]\n\n9. Optional Next Step:\n    [Step]\n</summary>\n</example>'

const BASE_COMPACT_PROMPT = 'Your task is to create a detailed summary of the conversation so far, paying close attention to the user explicit requests and your previous actions.\nThis summary should be thorough in capturing technical details, code patterns, and architectural decisions.\n\n' + ANALYSIS_BASE + '\n\nYour summary should include the following sections:\n\n' + SECTIONS_FULL + '\n\nHere is an example:\n\n' + EXAMPLE + '\n\nPlease provide your summary based on the conversation, following this structure.'

const PARTIAL_COMPACT_PROMPT = 'Your task is to create a detailed summary of the RECENT portion of the conversation. The earlier messages are being kept intact and do NOT need to be summarized. Focus on the recent messages only.\n\n' + ANALYSIS_PARTIAL + '\n\nYour summary should include:\n\n' + SECTIONS_PARTIAL + '\n\nPlease provide your summary based on the RECENT messages only.'

const PARTIAL_COMPACT_UP_TO_PROMPT = 'Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session. Summarize thoroughly.\n\n' + ANALYSIS_BASE + '\n\nYour summary should include:\n\n' + SECTIONS_UP_TO + '\n\nPlease provide your summary following this structure.'

const NO_TOOLS_TRAILER = '\n\nREMINDER: Do NOT call any tools. Respond with plain text only: an <analysis> block followed by a <summary> block.'

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
): string {
  const template = direction === 'up_to' ? PARTIAL_COMPACT_UP_TO_PROMPT : PARTIAL_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += '\n\nAdditional Instructions:\n' + customInstructions
  }
  return prompt + NO_TOOLS_TRAILER
}

export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += '\n\nAdditional Instructions:\n' + customInstructions
  }
  return prompt + NO_TOOLS_TRAILER
}

export function formatCompactSummary(summary: string): string {
  let formatted = summary
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const match = formatted.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/,
      'Summary:\n' + (match[1] || '').trim(),
    )
  }
  return formatted.replace(/\n\n+/g, '\n\n').trim()
}

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)
  let baseSummary =
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n' +
    formattedSummary

  if (recentMessagesPreserved) {
    baseSummary += '\n\nRecent messages are preserved verbatim.'
  }

  if (suppressFollowUpQuestions) {
    return baseSummary + '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly. Pick up the last task as if the break never happened.'
  }

  return baseSummary
}

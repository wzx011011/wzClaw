import { randomUUID } from 'crypto'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

// ============================================================
// AskUserQuestion Tool — interactive question with options
// ============================================================

export interface AskUserOption {
  label: string
  description: string
}

export interface AskUserAnswer {
  questionId: string
  selectedLabels: string[]
  customText?: string
}

const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export class AskUserQuestionTool implements Tool {
  readonly name = 'AskUserQuestion'
  readonly description =
    'Ask the user an interactive question with predefined options. ' +
    'Use this tool when you need the user to make a choice or provide direction before proceeding. ' +
    'Set multiSelect: true to allow choosing multiple options; ' +
    'in single-select mode clicking an option immediately submits. ' +
    'An "Other" option is always available for free-text responses. ' +
    'Returns the user\'s selected labels (and optional custom text).'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to display to the user'
      },
      options: {
        type: 'array',
        description: 'Predefined options for the user to choose from (1–8 items)',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short option label (button text)' },
            description: { type: 'string', description: 'Longer explanation shown below the label' }
          },
          required: ['label', 'description']
        },
        minItems: 1,
        maxItems: 8
      },
      multiSelect: {
        type: 'boolean',
        description: 'When true, user can select multiple options then click Submit (default: false)'
      }
    },
    required: ['question', 'options']
  }

  private pendingQuestions = new Map<string, (answer: AskUserAnswer) => void>()

  constructor(private getWebContents: () => Electron.WebContents | null) {}

  /** Called from the main-process IPC handler when the renderer sends back an answer. */
  resolveQuestion(answer: AskUserAnswer): void {
    const resolver = this.pendingQuestions.get(answer.questionId)
    if (resolver) {
      this.pendingQuestions.delete(answer.questionId)
      resolver(answer)
    }
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const question = input.question as string
    const options = input.options as AskUserOption[] | undefined
    const multiSelect = (input.multiSelect as boolean | undefined) ?? false

    if (!question || !Array.isArray(options) || options.length === 0) {
      return { output: 'Invalid input: question and non-empty options are required', isError: true }
    }

    const questionId = randomUUID()

    const answerPromise = new Promise<AskUserAnswer>((resolve) => {
      this.pendingQuestions.set(questionId, resolve)
    })

    const wc = this.getWebContents()
    if (!wc || wc.isDestroyed()) {
      this.pendingQuestions.delete(questionId)
      return { output: 'No renderer window available to display the question', isError: true }
    }

    wc.send('ask-user:question', { questionId, question, options, multiSelect })

    const noResponseAnswer: AskUserAnswer = { questionId, selectedLabels: [] }
    const timeoutPromise = new Promise<AskUserAnswer>((resolve) => {
      setTimeout(() => {
        this.pendingQuestions.delete(questionId)
        resolve(noResponseAnswer)
      }, TIMEOUT_MS)
    })

    const answer = await Promise.race([answerPromise, timeoutPromise])

    if (answer.selectedLabels.length === 0) {
      return { output: 'No response received from user (timed out after 5 minutes)', isError: false }
    }

    let result = `User selected: ${answer.selectedLabels.join(', ')}`
    if (answer.customText) {
      result += `\nUser provided additional text: ${answer.customText}`
    }
    return { output: result, isError: false }
  }
}

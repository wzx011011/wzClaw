// ============================================================
// ConversationExporter — 导出对话为 Markdown 或 JSON
// ============================================================

import fs from 'fs/promises'
import path from 'path'

interface ExportMessage {
  role: string
  content: string
  timestamp: number
  toolCalls?: unknown[]
  toolCallId?: string
  isError?: boolean
  usage?: { inputTokens: number; outputTokens: number }
}

export type ExportFormat = 'markdown' | 'json'

/**
 * 将对话消息导出为 Markdown 或 JSON 文件。
 */
export class ConversationExporter {
  /**
   * 导出对话到指定路径。
   * @returns 导出文件的绝对路径
   */
  static async exportToFile(
    messages: ExportMessage[],
    outputPath: string,
    format: ExportFormat = 'markdown'
  ): Promise<string> {
    const ext = format === 'json' ? '.json' : '.md'
    const filePath = outputPath.endsWith(ext) ? outputPath : outputPath + ext

    const content = format === 'json'
      ? ConversationExporter.toJson(messages)
      : ConversationExporter.toMarkdown(messages)

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return filePath
  }

  private static toMarkdown(messages: ExportMessage[]): string {
    const lines: string[] = []
    lines.push('# wzxClaw Conversation Export')
    lines.push('')
    lines.push(`Exported: ${new Date().toISOString()}`)
    lines.push(`Messages: ${messages.length}`)
    lines.push('')
    lines.push('---')
    lines.push('')

    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString()
      const roleLabel = msg.role === 'user' ? '**User**' : msg.role === 'tool_result' ? '**Tool Result**' : '**Assistant**'

      if (msg.role === 'tool_result') {
        lines.push(`### ${roleLabel} (${time})`)
        if (msg.toolCallId) lines.push(`Tool Call: ${msg.toolCallId}`)
        lines.push('```')
        lines.push(msg.content)
        lines.push('```')
        lines.push('')
        continue
      }

      lines.push(`### ${roleLabel} (${time})`)
      lines.push('')
      lines.push(msg.content)
      lines.push('')

      if (msg.toolCalls && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls as Array<{ id?: string; name?: string; input?: unknown }>) {
          lines.push(`> Tool: \`${tc.name ?? 'unknown'}\` (${tc.id ?? ''})`)
          if (tc.input) {
            lines.push(`> \`\`\`json`)
            lines.push(`> ${JSON.stringify(tc.input, null, 2).split('\n').join('\n> ')}`)
            lines.push(`> \`\`\``)
          }
          lines.push('')
        }
      }

      if (msg.usage) {
        lines.push(`*Tokens: ${msg.usage.inputTokens} in / ${msg.usage.outputTokens} out*`)
        lines.push('')
      }

      lines.push('---')
      lines.push('')
    }

    return lines.join('\n')
  }

  private static toJson(messages: ExportMessage[]): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    }, null, 2)
  }
}

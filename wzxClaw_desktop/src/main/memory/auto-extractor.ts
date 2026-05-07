// ============================================================
// AutoExtractor — 对话结束时自动提取重要信息写入 MEMORY.md
// 轻量级实现：用 LLM 从最近对话摘要中提取增量记忆
// ============================================================

import type { LLMGateway } from '../llm/gateway'
import type { Message } from '../../shared/types'
import fs from 'fs'
import path from 'path'

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Analyze the conversation below and extract ONLY durable, stable facts worth remembering for future sessions.

Rules:
- Extract: architecture decisions, user preferences, debugging findings, project conventions, key file locations, important patterns
- Do NOT extract: temporary state, specific code snippets, session-specific details, questions the user asked
- Return facts as a concise markdown bullet list (max 20 lines)
- If nothing worth remembering, output exactly: NO_NEW_MEMORY
- Do not duplicate facts already in the existing memory

Format:
- Each bullet should be one clear, self-contained fact
- Prefix with a category tag like [arch], [pref], [debug], [pattern], [config]

Example output:
- [arch] Database uses PostgreSQL 15 with connection pooling via PgBouncer
- [pref] User prefers Chinese comments in code
- [debug] The login timeout issue was caused by missing nginx proxy_read_timeout setting
- [pattern] All API routes follow /api/v1/{resource} convention`

export class AutoExtractor {
  /**
   * 从对话中提取增量记忆，追加到 MEMORY.md
   * @returns true if new memories were written, false otherwise
   */
  static async extractAndAppend(
    messages: Message[],
    existingMemory: string,
    memoryPath: string,
    gateway: LLMGateway,
    model: string,
    provider: string,
  ): Promise<boolean> {
    // 跳过过短的对话（< 4 条消息说明没有实质性内容）
    if (messages.length < 4) return false

    // 构建对话摘要（取最近的消息，避免全部发送）
    const recentMessages = messages.slice(-20)
    const conversationText = recentMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        const truncated = content.length > 500 ? content.substring(0, 500) + '...' : content
        return `[${m.role}]: ${truncated}`
      })
      .join('\n\n')

    if (conversationText.length < 200) return false

    try {
      const response = await gateway.sendMessage(
        [
          { role: 'user', content: EXTRACTION_PROMPT },
          { role: 'assistant', content: 'I will extract durable facts from the conversation. Please provide the conversation and existing memory.' },
          { role: 'user', content: `Existing memory:\n${existingMemory || '(empty)'}\n\n---\n\nRecent conversation:\n${conversationText}` },
        ],
        [],
        { model, provider, maxTokens: 1024, temperature: 0.1 },
      )

      // 从流式响应中收集文本
      let result = ''
      for await (const event of response) {
        if (event.type === 'text_delta') {
          result += event.content
        }
      }

      result = result.trim()
      if (!result || result === 'NO_NEW_MEMORY') return false

      // 追加到 MEMORY.md
      const timestamp = new Date().toISOString().slice(0, 10)
      const newBlock = `\n\n## Auto-extracted ${timestamp}\n${result}`

      // 确保目录存在
      const dir = path.dirname(memoryPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 追加写入
      const currentContent = fs.existsSync(memoryPath)
        ? await fs.promises.readFile(memoryPath, 'utf-8')
        : ''

      // 检查总行数，超过 200 行时裁剪最旧的部分
      const lines = (currentContent + newBlock).split('\n')
      const finalContent = lines.length > 200
        ? lines.slice(-200).join('\n')
        : currentContent + newBlock

      await fs.promises.writeFile(memoryPath, finalContent, 'utf-8')
      console.log(`[AutoExtractor] Appended new memories to ${memoryPath}`)
      return true
    } catch (err) {
      // 记忆提取失败不应影响用户体验，静默处理
      console.warn('[AutoExtractor] Failed to extract memories:', err)
      return false
    }
  }
}

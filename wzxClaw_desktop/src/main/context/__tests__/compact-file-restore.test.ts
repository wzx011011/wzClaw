import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  extractFilePathsFromToolCalls,
  extractRecentFilePaths,
  formatRestoredFilesMessage,
  restoreFiles,
  readFileContent,
} from '../compact-file-restore'
import type { ToolCall, Message } from '../../../shared/types'

describe('compact-file-restore', () => {
  describe('extractFilePathsFromToolCalls', () => {
    it('extracts file paths from FileRead/FileWrite/FileEdit tools', () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc1', name: 'FileRead', input: { path: '/src/index.ts' } },
        { id: 'tc2', name: 'FileWrite', input: { path: '/src/output.ts' } },
        { id: 'tc3', name: 'FileEdit', input: { path: '/src/edit.ts' } },
      ]
      const paths = extractFilePathsFromToolCalls(toolCalls)
      expect(paths).toEqual(['/src/index.ts', '/src/output.ts', '/src/edit.ts'])
    })

    it('extracts file paths from Bash commands (cat/head/tail)', () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc1', name: 'Bash', input: { command: 'cat /etc/hosts' } },
        { id: 'tc2', name: 'Bash', input: { command: 'tail /var/log/syslog.log' } },
      ]
      const paths = extractFilePathsFromToolCalls(toolCalls)
      expect(paths).toContain('/etc/hosts')
      expect(paths).toContain('/var/log/syslog.log')
    })

    it('skips Bash commands without file paths', () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc1', name: 'Bash', input: { command: 'npm install' } },
        { id: 'tc2', name: 'Bash', input: { command: 'ls -la' } },
      ]
      const paths = extractFilePathsFromToolCalls(toolCalls)
      expect(paths).toEqual([])
    })

    it('skips unknown tools', () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc1', name: 'WebSearch', input: { query: 'test' } },
        { id: 'tc2', name: 'UnknownTool', input: { path: '/foo.ts' } },
      ]
      const paths = extractFilePathsFromToolCalls(toolCalls)
      expect(paths).toEqual([])
    })
  })

  describe('extractRecentFilePaths', () => {
    it('extracts file paths from assistant tool calls, most recent first', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read file A', timestamp: 1 },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'FileRead', input: { path: '/a.ts' } }],
          timestamp: 2,
        },
        { role: 'tool_result', toolCallId: 'tc1', content: 'a content', isError: false, timestamp: 3 },
        { role: 'user', content: 'Read file B', timestamp: 4 },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc2', name: 'FileRead', input: { path: '/b.ts' } }],
          timestamp: 5,
        },
        { role: 'tool_result', toolCallId: 'tc2', content: 'b content', isError: false, timestamp: 6 },
      ]

      const paths = extractRecentFilePaths(messages)
      // Most recent first (scanned backwards)
      expect(paths[0]).toBe('/b.ts')
      expect(paths[1]).toBe('/a.ts')
    })

    it('deduplicates paths', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read file', timestamp: 1 },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'FileRead', input: { path: '/same.ts' } }],
          timestamp: 2,
        },
        { role: 'tool_result', toolCallId: 'tc1', content: 'content', isError: false, timestamp: 3 },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc2', name: 'FileRead', input: { path: '/same.ts' } }],
          timestamp: 4,
        },
      ]

      const paths = extractRecentFilePaths(messages)
      expect(paths.length).toBe(1)
      expect(paths[0]).toBe('/same.ts')
    })

    it('respects maxFiles limit', () => {
      const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: `tc${i}`, name: 'FileRead', input: { path: `/file${i}.ts` } }],
        timestamp: i,
      }))

      const paths = extractRecentFilePaths(messages, 5)
      expect(paths.length).toBe(5)
      // Should be most recent first
      expect(paths[0]).toContain('file19')
    })

    it('returns empty for messages without tool calls', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: 1 },
        { role: 'assistant', content: 'Hi there', toolCalls: [], timestamp: 2 },
      ]
      const paths = extractRecentFilePaths(messages)
      expect(paths).toEqual([])
    })
  })

  describe('readFileContent', () => {
    it('returns null for non-existent files', () => {
      const result = readFileContent('/nonexistent/path/file.ts', 10000)
      expect(result).toBeNull()
    })

    it('returns null for directories', () => {
      const result = readFileContent('/', 10000)
      expect(result).toBeNull()
    })
  })

  describe('formatRestoredFilesMessage', () => {
    it('returns empty string for empty files array', () => {
      expect(formatRestoredFilesMessage([])).toBe('')
    })

    it('formats files with markdown code blocks', () => {
      const files = [
        { path: '/src/index.ts', content: 'console.log("hello")', tokens: 10 },
      ]
      const msg = formatRestoredFilesMessage(files)
      expect(msg).toContain('### /src/index.ts')
      expect(msg).toContain('```ts')
      expect(msg).toContain('console.log("hello")')
      expect(msg).toContain('content restored')
    })

    it('formats multiple files', () => {
      const files = [
        { path: '/a.ts', content: 'const a = 1', tokens: 5 },
        { path: '/b.py', content: 'print("b")', tokens: 5 },
      ]
      const msg = formatRestoredFilesMessage(files)
      expect(msg).toContain('### /a.ts')
      expect(msg).toContain('### /b.py')
      expect(msg).toContain('```ts')
      expect(msg).toContain('```py')
    })
  })

  describe('restoreFiles', () => {
    it('returns empty for messages without file references', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: 1 },
        { role: 'assistant', content: 'Hi', toolCalls: [], timestamp: 2 },
      ]
      const result = restoreFiles(messages)
      expect(result).toEqual([])
    })

    it('returns empty for empty messages', () => {
      const result = restoreFiles([])
      expect(result).toEqual([])
    })
  })
})

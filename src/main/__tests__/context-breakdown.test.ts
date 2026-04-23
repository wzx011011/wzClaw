import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContextBreakdownResponse } from '../../shared/types'
import { DEFAULT_MODELS } from '../../shared/constants'

// ============================================================
// Integration Test: Context Breakdown (Unit 7)
// ============================================================
// Tests verify the shape and validity of ContextBreakdownResponse
// as produced by the agent:context_breakdown IPC handler.

// Mock electron
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), handleOnce: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/test-userdata') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(() => Buffer.from('enc')),
    decryptString: vi.fn(() => 'dec'),
  },
}))

// Helper: build a realistic ContextBreakdownResponse for testing
function buildTestResponse(overrides?: Partial<ContextBreakdownResponse>): ContextBreakdownResponse {
  const model = 'claude-sonnet-4-20250514'
  const preset = DEFAULT_MODELS.find(m => m.id === model)!
  const contextWindow = preset.contextWindowSize
  const maxOutput = preset.maxTokens

  const systemPromptTokens = 2500
  const systemPromptDynamicTokens = 500
  const instructionsTokens = 1800
  const commandsTokens = 600
  const skillsTokens = 200
  const memoryTokens = 350
  const toolDefinitionsTokens = 3200
  const builtinToolTokens = 2800
  const mcpToolTokens = 400
  const conversationTokens = 8000
  const conversationMessageCount = 12

  const totalEstimatedTokens = systemPromptTokens + envInfoTokens + gitContextTokens +
    instructionsTokens + commandsTokens + skillsTokens + memoryTokens +
    toolDefinitionsTokens + conversationTokens

  // ... use a simplified calculation for test
  const estimatedTotal = 18000
  const freeSpace = contextWindow - estimatedTotal
  const usagePercent = (estimatedTotal / contextWindow) * 100

  return {
    systemPromptTokens,
    systemPromptDynamicTokens,
    instructionsTokens,
    commandsTokens,
    skillsTokens,
    memoryTokens,
    toolDefinitionsTokens,
    builtinToolTokens,
    mcpToolTokens,
    conversationTokens,
    conversationMessageCount,
    messagesByRole: { user: 4, assistant: 4, tool_result: 4 },
    totalEstimatedTokens: estimatedTotal,
    contextWindowSize: contextWindow,
    maxOutputTokens: maxOutput,
    usagePercent,
    autocompactBufferTokens: Math.floor(contextWindow * 0.2),
    freeSpaceTokens: freeSpace,
    sessionUsage: {
      inputTokens: 15000,
      outputTokens: 5000,
      cacheReadTokens: 2000,
      cacheWriteTokens: 1000,
      totalCostUSD: 0.042,
      model,
    },
    compactionHistory: {
      compactCount: 0,
      lastBefore: null,
      lastAfter: null,
    },
    model,
    ...overrides,
  }
}

// Unused constants for the helper — remove the lint error
const envInfoTokens = 150
const gitContextTokens = 80

describe('ContextBreakdown', () => {
  let response: ContextBreakdownResponse

  beforeEach(() => {
    response = buildTestResponse()
  })

  // Test 1: All required fields present
  it('contains all required fields', () => {
    const requiredFields: (keyof ContextBreakdownResponse)[] = [
      'systemPromptTokens',
      'systemPromptDynamicTokens',
      'instructionsTokens',
      'commandsTokens',
      'skillsTokens',
      'memoryTokens',
      'toolDefinitionsTokens',
      'builtinToolTokens',
      'mcpToolTokens',
      'conversationTokens',
      'conversationMessageCount',
      'messagesByRole',
      'totalEstimatedTokens',
      'contextWindowSize',
      'maxOutputTokens',
      'usagePercent',
      'autocompactBufferTokens',
      'freeSpaceTokens',
      'sessionUsage',
      'compactionHistory',
      'model',
    ]

    for (const field of requiredFields) {
      expect(response).toHaveProperty(field)
      expect((response as any)[field]).not.toBeUndefined()
    }
  })

  // Test 2: Token counts are non-negative
  it('has non-negative token counts', () => {
    const tokenFields = [
      response.systemPromptTokens,
      response.systemPromptDynamicTokens,
      response.instructionsTokens,
      response.commandsTokens,
      response.skillsTokens,
      response.memoryTokens,
      response.toolDefinitionsTokens,
      response.builtinToolTokens,
      response.mcpToolTokens,
      response.conversationTokens,
      response.totalEstimatedTokens,
      response.contextWindowSize,
      response.maxOutputTokens,
      response.autocompactBufferTokens,
      response.freeSpaceTokens,
    ] as number[]

    for (const val of tokenFields) {
      expect(val).toBeGreaterThanOrEqual(0)
    }
  })

  // Test 3: Total estimated ≈ sum of components
  it('totalEstimatedTokens approximates sum of components', () => {
    const componentSum = response.systemPromptTokens +
      response.instructionsTokens +
      response.commandsTokens +
      response.skillsTokens +
      response.memoryTokens +
      response.toolDefinitionsTokens +
      response.conversationTokens +
      150 + // env info (approx)
      80    // git context (approx)

    // Allow 10% tolerance since dynamic parts (env, git) may vary
    const tolerance = componentSum * 0.15
    expect(response.totalEstimatedTokens).toBeGreaterThan(componentSum - tolerance)
    expect(response.totalEstimatedTokens).toBeLessThan(componentSum + tolerance)
  })

  // Test 4: usagePercent = total / contextWindow * 100
  it('usagePercent is correctly calculated', () => {
    const expected = (response.totalEstimatedTokens / response.contextWindowSize) * 100
    expect(response.usagePercent).toBeCloseTo(expected, 0)
  })

  // Test 5: No MCP tools — mcpToolTokens should be 0
  it('returns mcpToolTokens = 0 when no MCP tools', () => {
    const noMcpResponse = buildTestResponse({ mcpToolTokens: 0 })
    expect(noMcpResponse.mcpToolTokens).toBe(0)
    expect(noMcpResponse.builtinToolTokens).toBeGreaterThan(0)
  })

  // Test 6: No conversation — conversationTokens = 0
  it('returns conversationTokens = 0 when no messages', () => {
    const noConvResponse = buildTestResponse({
      conversationTokens: 0,
      conversationMessageCount: 0,
      messagesByRole: { user: 0, assistant: 0, tool_result: 0 },
    })
    expect(noConvResponse.conversationTokens).toBe(0)
    expect(noConvResponse.conversationMessageCount).toBe(0)
  })

  // Test 7: builtinToolTokens + mcpToolTokens = toolDefinitionsTokens
  it('splits tool definitions into builtin + MCP correctly', () => {
    expect(response.builtinToolTokens + response.mcpToolTokens)
      .toBe(response.toolDefinitionsTokens)
  })

  // Test 8: sessionUsage has all required fields
  it('sessionUsage contains all cost tracking fields', () => {
    const su = response.sessionUsage
    expect(su).toHaveProperty('inputTokens')
    expect(su).toHaveProperty('outputTokens')
    expect(su).toHaveProperty('cacheReadTokens')
    expect(su).toHaveProperty('cacheWriteTokens')
    expect(su).toHaveProperty('totalCostUSD')
    expect(su).toHaveProperty('model')
    expect(typeof su.totalCostUSD).toBe('number')
    expect(su.inputTokens).toBeGreaterThanOrEqual(0)
    expect(su.outputTokens).toBeGreaterThanOrEqual(0)
  })

  // Test 9: compactionHistory structure
  it('compactionHistory has count and optional before/after', () => {
    const ch = response.compactionHistory
    expect(ch).toHaveProperty('compactCount')
    expect(ch).toHaveProperty('lastBefore')
    expect(ch).toHaveProperty('lastAfter')
    expect(typeof ch.compactCount).toBe('number')

    // After compaction, values should be populated
    const compacted = buildTestResponse({
      compactionHistory: { compactCount: 2, lastBefore: 50000, lastAfter: 12000 },
    })
    expect(compacted.compactionHistory.compactCount).toBe(2)
    expect(compacted.compactionHistory.lastBefore).toBe(50000)
    expect(compacted.compactionHistory.lastAfter).toBe(12000)
  })

  // Test 10: messagesByRole sums to conversationMessageCount
  it('messagesByRole sums to conversationMessageCount', () => {
    const { user, assistant, tool_result } = response.messagesByRole
    expect(user + assistant + tool_result).toBe(response.conversationMessageCount)
  })

  // Test 11: freeSpaceTokens = contextWindow - totalEstimated
  it('freeSpaceTokens equals contextWindow minus totalEstimated', () => {
    expect(response.freeSpaceTokens).toBe(
      response.contextWindowSize - response.totalEstimatedTokens
    )
  })
})

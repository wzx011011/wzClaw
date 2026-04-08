import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoToDefinitionTool, FindReferencesTool, SearchSymbolsTool, handleSymbolResult } from '../symbol-nav'

// Mock getWebContents that never resolves (simulates no Monaco)
const nullGetWebContents = () => null

describe('GoToDefinitionTool', () => {
  let tool: GoToDefinitionTool

  beforeEach(() => {
    tool = new GoToDefinitionTool(nullGetWebContents)
  })

  it('has correct name and requiresApproval = false', () => {
    expect(tool.name).toBe('GoToDefinition')
    expect(tool.requiresApproval).toBe(false)
  })

  it('returns error for missing symbolName', async () => {
    const result = await tool.execute({}, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('returns error when no web contents available', async () => {
    const result = await tool.execute({ symbolName: 'myFunc' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('No web contents available')
  })

  it('has correct inputSchema', () => {
    const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> }
    expect(schema.required).toContain('symbolName')
    expect(schema.properties).toHaveProperty('symbolName')
    expect(schema.properties).toHaveProperty('filePath')
  })
})

describe('FindReferencesTool', () => {
  let tool: FindReferencesTool

  beforeEach(() => {
    tool = new FindReferencesTool(nullGetWebContents)
  })

  it('has correct name and requiresApproval = false', () => {
    expect(tool.name).toBe('FindReferences')
    expect(tool.requiresApproval).toBe(false)
  })

  it('returns error for missing symbolName', async () => {
    const result = await tool.execute({}, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('returns error when no web contents available', async () => {
    const result = await tool.execute({ symbolName: 'myFunc' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('No web contents available')
  })
})

describe('SearchSymbolsTool', () => {
  let tool: SearchSymbolsTool

  beforeEach(() => {
    tool = new SearchSymbolsTool(nullGetWebContents)
  })

  it('has correct name and requiresApproval = false', () => {
    expect(tool.name).toBe('SearchSymbols')
    expect(tool.requiresApproval).toBe(false)
  })

  it('returns error for missing query', async () => {
    const result = await tool.execute({}, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('returns error when no web contents available', async () => {
    const result = await tool.execute({ query: 'myFunc' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('No web contents available')
  })

  it('has correct inputSchema', () => {
    const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> }
    expect(schema.required).toContain('query')
    expect(schema.properties).toHaveProperty('query')
    expect(schema.properties).toHaveProperty('maxResults')
  })
})

describe('handleSymbolResult', () => {
  it('does not throw on unknown queryId', () => {
    expect(() =>
      handleSymbolResult({ queryId: 'nonexistent', result: [], isError: false })
    ).not.toThrow()
  })
})

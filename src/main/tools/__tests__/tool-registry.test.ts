import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRegistry, createDefaultTools } from '../tool-registry'
import type { Tool } from '../tool-interface'

// Create a mock tool for testing the registry
function createMockTool(name: string, requiresApproval: boolean = false): Tool {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    requiresApproval,
    execute: vi.fn().mockResolvedValue({ output: 'mock result', isError: false })
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('registers and looks up a tool by name', () => {
    const tool = createMockTool('TestTool')
    registry.register(tool)
    expect(registry.get('TestTool')).toBe(tool)
  })

  it('returns undefined for unregistered tool', () => {
    expect(registry.get('NonExistent')).toBeUndefined()
  })

  it('getAll returns all registered tools', () => {
    const tool1 = createMockTool('Tool1')
    const tool2 = createMockTool('Tool2')
    registry.register(tool1)
    registry.register(tool2)
    expect(registry.getAll()).toHaveLength(2)
    expect(registry.getAll()).toContain(tool1)
    expect(registry.getAll()).toContain(tool2)
  })

  it('getDefinitions returns ToolDefinition array', () => {
    const tool = createMockTool('FileRead')
    registry.register(tool)
    const defs = registry.getDefinitions()
    expect(defs).toHaveLength(1)
    expect(defs[0]).toEqual({
      name: 'FileRead',
      description: 'Mock FileRead tool',
      inputSchema: { type: 'object', properties: {} }
    })
  })

  it('getApprovalRequired returns only tools with requiresApproval=true', () => {
    const readOnlyTool = createMockTool('FileRead', false)
    const destructiveTool = createMockTool('Bash', true)
    registry.register(readOnlyTool)
    registry.register(destructiveTool)
    const names = registry.getApprovalRequired()
    expect(names).toEqual(['Bash'])
  })

  it('getApprovalRequired returns empty array when only read-only tools registered', () => {
    const tool = createMockTool('FileRead', false)
    registry.register(tool)
    expect(registry.getApprovalRequired()).toEqual([])
  })
})

describe('createDefaultTools', () => {
  it('creates a registry with 8 tools (6 core + 2 web, no symbol tools without getWebContents)', () => {
    const registry = createDefaultTools('/test/project')
    const tools = registry.getAll()
    expect(tools.length).toBe(8)
  })

  it('creates a registry with 11 tools when getWebContents is provided', () => {
    const registry = createDefaultTools('/test/project', undefined, () => null)
    const tools = registry.getAll()
    expect(tools.length).toBe(11)
  })

  it('registers FileRead tool', () => {
    const registry = createDefaultTools('/test/project')
    expect(registry.get('FileRead')).toBeDefined()
    expect(registry.get('FileRead')?.requiresApproval).toBe(false)
  })

  it('registers Grep tool', () => {
    const registry = createDefaultTools('/test/project')
    expect(registry.get('Grep')).toBeDefined()
    expect(registry.get('Grep')?.requiresApproval).toBe(false)
  })

  it('registers Glob tool', () => {
    const registry = createDefaultTools('/test/project')
    expect(registry.get('Glob')).toBeDefined()
    expect(registry.get('Glob')?.requiresApproval).toBe(false)
  })

  it('registers FileWrite tool (requires approval)', () => {
    const registry = createDefaultTools('/test/project')
    expect(registry.get('FileWrite')).toBeDefined()
    expect(registry.get('FileWrite')?.requiresApproval).toBe(true)
  })

  it('registers FileEdit tool (requires approval)', () => {
    const registry = createDefaultTools('/test/project')
    expect(registry.get('FileEdit')).toBeDefined()
    expect(registry.get('FileEdit')?.requiresApproval).toBe(true)
  })

  it('registers Bash tool (requires approval)', () => {
    const registry = createDefaultTools('/test/project')
    expect(registry.get('Bash')).toBeDefined()
    expect(registry.get('Bash')?.requiresApproval).toBe(true)
  })

  it('3 tools require approval (FileWrite, FileEdit, Bash)', () => {
    const registry = createDefaultTools('/test/project')
    expect(registry.getApprovalRequired()).toEqual(['FileWrite', 'FileEdit', 'Bash'])
  })
})

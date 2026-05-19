import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WorkspaceService } from './workspace-service.js'

describe('WorkspaceService', () => {
  let service: WorkspaceService

  beforeEach(() => {
    service = new WorkspaceService(':memory:')
  })

  afterEach(() => {
    service.close()
  })

  it('creates, lists, updates, archives, and deletes workspaces', async () => {
    const created = await service.createWorkspace({ title: '主工作区', description: 'desc' })
    expect(created.id).toBeTruthy()
    expect(created.projects).toEqual([])

    const listed = await service.listWorkspaces()
    expect(listed.map(item => item.id)).toEqual([created.id])

    const updated = await service.updateWorkspace(created.id, { title: '新标题', archived: true })
    expect(updated.title).toBe('新标题')
    expect(updated.archived).toBe(true)

    expect(await service.listWorkspaces()).toEqual([])
    expect(await service.listWorkspaces(true)).toHaveLength(1)

    await service.deleteWorkspace(created.id)
    expect(await service.listWorkspaces(true)).toEqual([])
  })

  it('adds project roots and derives session defaults', async () => {
    const workspace = await service.createWorkspace({ title: '多项目' })
    const withProject = await service.addProject(workspace.id, '/repo/app')

    expect(withProject.projects).toHaveLength(1)
    expect(withProject.projects[0]!.name).toBe('app')

    const defaults = await service.getSessionDefaults(workspace.id)
    expect(defaults.workingDirectory).toBe('/repo/app')
    expect(defaults.projectRoots).toEqual(['/repo/app'])
  })

  it('duplicate addProject is idempotent', async () => {
    const workspace = await service.createWorkspace({ title: 'dup-test' })
    await service.addProject(workspace.id, '/repo/x')
    const result = await service.addProject(workspace.id, '/repo/x')
    expect(result.projects).toHaveLength(1)
  })

  it('removes a project by ID', async () => {
    const workspace = await service.createWorkspace({ title: 'remove-test' })
    const withProject = await service.addProject(workspace.id, '/repo/y')
    const projectId = withProject.projects[0]!.id
    const after = await service.removeProject(workspace.id, projectId)
    expect(after.projects).toHaveLength(0)
  })

  it('getWorkspace returns null for unknown ID', async () => {
    const result = await service.getWorkspace('nonexistent-id')
    expect(result).toBeNull()
  })

  it('deleteWorkspace throws for unknown ID', async () => {
    await expect(service.deleteWorkspace('nonexistent-id')).rejects.toThrow('Workspace not found')
  })

  it('getSessionDefaults returns empty for unknown workspace', async () => {
    const defaults = await service.getSessionDefaults('nonexistent-id')
    expect(defaults).toEqual({})
  })

  it('getSessionDefaults returns empty when no workspaceId', async () => {
    const defaults = await service.getSessionDefaults(undefined)
    expect(defaults).toEqual({})
  })

  it('updates systemPrompt and lastSessionId', async () => {
    const workspace = await service.createWorkspace({ title: 'prompt-test' })
    const updated = await service.updateWorkspace(workspace.id, {
      systemPrompt: 'You are a test agent.',
      lastSessionId: 'sess-123',
    })
    expect(updated.systemPrompt).toBe('You are a test agent.')
    expect(updated.lastSessionId).toBe('sess-123')
  })

  it('multiple projects provide multiple projectRoots', async () => {
    const workspace = await service.createWorkspace({ title: 'multi-proj' })
    await service.addProject(workspace.id, '/repo/a')
    await service.addProject(workspace.id, '/repo/b')
    const defaults = await service.getSessionDefaults(workspace.id)
    expect(defaults.projectRoots).toEqual(['/repo/a', '/repo/b'])
  })
})
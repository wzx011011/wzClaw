import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock fs and paths before importing WorkspaceStore
vi.mock('fs')
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined)
  }
}))
vi.mock('../../paths', () => ({
  getAppDataDir: () => '/tmp/wzxclaw-test'
}))

import { WorkspaceStore } from '../workspace-store'

describe('WorkspaceStore', () => {
  let store: WorkspaceStore

  beforeEach(() => {
    store = new WorkspaceStore()
  })

  it('creates a workspace with title and description', async () => {
    const workspace = await store.createWorkspace('My Workspace', 'Some description')
    expect(workspace.id).toBeDefined()
    expect(workspace.title).toBe('My Workspace')
    expect(workspace.description).toBe('Some description')
    expect(workspace.projects).toEqual([])
    expect(workspace.archived).toBe(false)
  })

  it('lists non-archived workspaces by default', async () => {
    await store.createWorkspace('Active')
    const archived = await store.createWorkspace('Archived')
    await store.updateWorkspace(archived.id, { archived: true })

    const list = await store.listWorkspaces()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Active')
  })

  it('lists all workspaces when includeArchived is true', async () => {
    await store.createWorkspace('Active')
    const archived = await store.createWorkspace('Archived')
    await store.updateWorkspace(archived.id, { archived: true })

    const list = await store.listWorkspaces(true)
    expect(list).toHaveLength(2)
  })

  it('gets a workspace by id', async () => {
    const workspace = await store.createWorkspace('Test')
    const found = await store.getWorkspace(workspace.id)
    expect(found?.title).toBe('Test')
  })

  it('returns null for non-existent workspace', async () => {
    const found = await store.getWorkspace('nonexistent')
    expect(found).toBeNull()
  })

  it('updates a workspace', async () => {
    const workspace = await store.createWorkspace('Original')
    const updated = await store.updateWorkspace(workspace.id, { title: 'Updated' })
    expect(updated.title).toBe('Updated')
  })

  it('deletes a workspace', async () => {
    const workspace = await store.createWorkspace('To Delete')
    await store.deleteWorkspace(workspace.id)
    const found = await store.getWorkspace(workspace.id)
    expect(found).toBeNull()
  })

  it('throws when deleting non-existent workspace', async () => {
    await expect(store.deleteWorkspace('nonexistent')).rejects.toThrow('Workspace not found')
  })

  it('adds a project to a workspace', async () => {
    const workspace = await store.createWorkspace('With Project')
    const updated = await store.addProject(workspace.id, '/path/to/project')
    expect(updated.projects).toHaveLength(1)
    expect(updated.projects[0].path).toBe('/path/to/project')
    expect(updated.projects[0].name).toBe('project')
  })

  it('deduplicates project paths', async () => {
    const workspace = await store.createWorkspace('Dedup')
    await store.addProject(workspace.id, '/path/to/project')
    const updated = await store.addProject(workspace.id, '/path/to/project')
    expect(updated.projects).toHaveLength(1)
  })

  it('removes a project from a workspace', async () => {
    const workspace = await store.createWorkspace('Remove Project')
    const withProject = await store.addProject(workspace.id, '/path/to/project')
    const projectId = withProject.projects[0].id
    const updated = await store.removeProject(workspace.id, projectId)
    expect(updated.projects).toHaveLength(0)
  })
})

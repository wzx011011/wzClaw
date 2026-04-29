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

  it('creates a task with title and description', async () => {
    const task = await store.createWorkspace('My Task', 'Some description')
    expect(task.id).toBeDefined()
    expect(task.title).toBe('My Task')
    expect(task.description).toBe('Some description')
    expect(task.projects).toEqual([])
    expect(task.archived).toBe(false)
  })

  it('lists non-archived tasks by default', async () => {
    await store.createWorkspace('Active')
    const archived = await store.createWorkspace('Archived')
    await store.updateWorkspace(archived.id, { archived: true })

    const list = await store.listWorkspaces()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Active')
  })

  it('lists all tasks when includeArchived is true', async () => {
    await store.createWorkspace('Active')
    const archived = await store.createWorkspace('Archived')
    await store.updateWorkspace(archived.id, { archived: true })

    const list = await store.listWorkspaces(true)
    expect(list).toHaveLength(2)
  })

  it('gets a task by id', async () => {
    const task = await store.createWorkspace('Test')
    const found = await store.getWorkspace(task.id)
    expect(found?.title).toBe('Test')
  })

  it('returns null for non-existent task', async () => {
    const found = await store.getWorkspace('nonexistent')
    expect(found).toBeNull()
  })

  it('updates a task', async () => {
    const task = await store.createWorkspace('Original')
    const updated = await store.updateWorkspace(task.id, { title: 'Updated' })
    expect(updated.title).toBe('Updated')
  })

  it('deletes a task', async () => {
    const task = await store.createWorkspace('To Delete')
    await store.deleteWorkspace(task.id)
    const found = await store.getWorkspace(task.id)
    expect(found).toBeNull()
  })

  it('throws when deleting non-existent task', async () => {
    await expect(store.deleteWorkspace('nonexistent')).rejects.toThrow('Task not found')
  })

  it('adds a project to a task', async () => {
    const task = await store.createWorkspace('With Project')
    const updated = await store.addProject(task.id, '/path/to/project')
    expect(updated.projects).toHaveLength(1)
    expect(updated.projects[0].path).toBe('/path/to/project')
    expect(updated.projects[0].name).toBe('project')
  })

  it('deduplicates project paths', async () => {
    const task = await store.createWorkspace('Dedup')
    await store.addProject(task.id, '/path/to/project')
    const updated = await store.addProject(task.id, '/path/to/project')
    expect(updated.projects).toHaveLength(1)
  })

  it('removes a project from a task', async () => {
    const task = await store.createWorkspace('Remove Project')
    const withProject = await store.addProject(task.id, '/path/to/project')
    const projectId = withProject.projects[0].id
    const updated = await store.removeProject(task.id, projectId)
    expect(updated.projects).toHaveLength(0)
  })
})

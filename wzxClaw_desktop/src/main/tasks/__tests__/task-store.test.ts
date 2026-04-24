import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock fs and paths before importing TaskStore
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

import { TaskStore } from '../task-store'

describe('TaskStore', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  it('creates a task with title and description', async () => {
    const task = await store.createTask('My Task', 'Some description')
    expect(task.id).toBeDefined()
    expect(task.title).toBe('My Task')
    expect(task.description).toBe('Some description')
    expect(task.projects).toEqual([])
    expect(task.archived).toBe(false)
  })

  it('lists non-archived tasks by default', async () => {
    await store.createTask('Active')
    const archived = await store.createTask('Archived')
    await store.updateTask(archived.id, { archived: true })

    const list = await store.listTasks()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Active')
  })

  it('lists all tasks when includeArchived is true', async () => {
    await store.createTask('Active')
    const archived = await store.createTask('Archived')
    await store.updateTask(archived.id, { archived: true })

    const list = await store.listTasks(true)
    expect(list).toHaveLength(2)
  })

  it('gets a task by id', async () => {
    const task = await store.createTask('Test')
    const found = await store.getTask(task.id)
    expect(found?.title).toBe('Test')
  })

  it('returns null for non-existent task', async () => {
    const found = await store.getTask('nonexistent')
    expect(found).toBeNull()
  })

  it('updates a task', async () => {
    const task = await store.createTask('Original')
    const updated = await store.updateTask(task.id, { title: 'Updated' })
    expect(updated.title).toBe('Updated')
  })

  it('deletes a task', async () => {
    const task = await store.createTask('To Delete')
    await store.deleteTask(task.id)
    const found = await store.getTask(task.id)
    expect(found).toBeNull()
  })

  it('throws when deleting non-existent task', async () => {
    await expect(store.deleteTask('nonexistent')).rejects.toThrow('Task not found')
  })

  it('adds a project to a task', async () => {
    const task = await store.createTask('With Project')
    const updated = await store.addProject(task.id, '/path/to/project')
    expect(updated.projects).toHaveLength(1)
    expect(updated.projects[0].path).toBe('/path/to/project')
    expect(updated.projects[0].name).toBe('project')
  })

  it('deduplicates project paths', async () => {
    const task = await store.createTask('Dedup')
    await store.addProject(task.id, '/path/to/project')
    const updated = await store.addProject(task.id, '/path/to/project')
    expect(updated.projects).toHaveLength(1)
  })

  it('removes a project from a task', async () => {
    const task = await store.createTask('Remove Project')
    const withProject = await store.addProject(task.id, '/path/to/project')
    const projectId = withProject.projects[0].id
    const updated = await store.removeProject(task.id, projectId)
    expect(updated.projects).toHaveLength(0)
  })
})

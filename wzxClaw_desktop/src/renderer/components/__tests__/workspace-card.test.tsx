// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import WorkspaceCard from '../tasks/WorkspaceCard'
import type { Workspace } from '../../../../shared/types'

function makeTask(overrides: Partial<Workspace> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: undefined,
    projects: [],
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now(),
    archived: false,
    ...overrides,
  }
}

describe('WorkspaceCard', () => {
  const onOpen = vi.fn()
  const onArchive = vi.fn()
  const onDelete = vi.fn()
  const onRename = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders task title', () => {
    render(<WorkspaceCard task={makeTask()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('Test Task')).toBeInTheDocument()
  })

  it('renders description when present', () => {
    render(<WorkspaceCard task={makeTask({ description: 'A description' })} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('A description')).toBeInTheDocument()
  })

  it('calls onOpen when clicking card body', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard task={makeTask()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByText('Test Task'))
    expect(onOpen).toHaveBeenCalledWith('task-1')
  })

  it('calls onArchive when clicking archive button', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard task={makeTask()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByTitle('归档'))
    expect(onArchive).toHaveBeenCalledWith('task-1')
  })

  it('calls onDelete when clicking delete button', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard task={makeTask()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    // First click triggers inline confirmation; second click confirms.
    await user.click(screen.getByTitle('删除'))
    await user.click(screen.getByTitle('确认删除'))
    expect(onDelete).toHaveBeenCalledWith('task-1')
  })

  it('enters rename mode and calls onRename on Enter', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard task={makeTask()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByTitle('重命名'))
    const input = screen.getByDisplayValue('Test Task')
    await user.clear(input)
    await user.type(input, 'Renamed Task{Enter}')

    expect(onRename).toHaveBeenCalledWith('task-1', 'Renamed Task')
  })

  it('cancels rename on Escape without calling onRename', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard task={makeTask()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByTitle('重命名'))
    const input = screen.getByDisplayValue('Test Task')
    await user.type(input, '{Escape}')

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('Test Task')).toBeInTheDocument()
  })

  it('renders progress summary when present', () => {
    render(<WorkspaceCard task={makeTask({ progressSummary: '3/5 完成' })} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('3/5 完成')).toBeInTheDocument()
  })

  it('renders bound folders', () => {
    const task = makeTask({
      projects: [{ id: 'p1', path: '/home/user/project', name: 'project', addedAt: Date.now() }],
    })
    render(<WorkspaceCard task={task} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('project')).toBeInTheDocument()
  })

  it('shows no-folder hint when no projects bound', () => {
    render(<WorkspaceCard task={makeTask()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('无绑定文件夹')).toBeInTheDocument()
  })
})

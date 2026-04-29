// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import WorkspaceCard from '../tasks/WorkspaceCard'
import type { Workspace } from '../../../../shared/types'

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    title: 'Test Workspace',
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

  it('renders workspace title', () => {
    render(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('Test Workspace')).toBeInTheDocument()
  })

  it('renders description when present', () => {
    render(<WorkspaceCard workspace={makeWorkspace({ description: 'A description' })} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('A description')).toBeInTheDocument()
  })

  it('calls onOpen when clicking card body', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByText('Test Workspace'))
    expect(onOpen).toHaveBeenCalledWith('workspace-1')
  })

  it('calls onArchive when clicking archive button', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByTitle('归档'))
    expect(onArchive).toHaveBeenCalledWith('workspace-1')
  })

  it('calls onDelete when clicking delete button', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    // First click triggers inline confirmation; second click confirms.
    await user.click(screen.getByTitle('删除'))
    await user.click(screen.getByTitle('确认删除'))
    expect(onDelete).toHaveBeenCalledWith('workspace-1')
  })

  it('enters rename mode and calls onRename on Enter', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByTitle('重命名'))
    const input = screen.getByDisplayValue('Test Workspace')
    await user.clear(input)
    await user.type(input, 'Renamed Workspace{Enter}')

    expect(onRename).toHaveBeenCalledWith('workspace-1', 'Renamed Workspace')
  })

  it('cancels rename on Escape without calling onRename', async () => {
    const user = userEvent.setup()
    render(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)

    await user.click(screen.getByTitle('重命名'))
    const input = screen.getByDisplayValue('Test Workspace')
    await user.type(input, '{Escape}')

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('Test Workspace')).toBeInTheDocument()
  })

  it('renders progress summary when present', () => {
    render(<WorkspaceCard workspace={makeWorkspace({ progressSummary: '3/5 完成' })} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('3/5 完成')).toBeInTheDocument()
  })

  it('renders bound folders', () => {
    const workspace = makeWorkspace({
      projects: [{ id: 'p1', path: '/home/user/project', name: 'project', addedAt: Date.now() }],
    })
    render(<WorkspaceCard workspace={workspace} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('project')).toBeInTheDocument()
  })

  it('shows no-folder hint when no projects bound', () => {
    render(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} onArchive={onArchive} onDelete={onDelete} onRename={onRename} />)
    expect(screen.getByText('无绑定文件夹')).toBeInTheDocument()
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import CreateWorkspaceModal from '../tasks/CreateTaskModal'

describe('CreateWorkspaceModal', () => {
  const onClose = vi.fn()
  const onCreate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders modal title and form fields', () => {
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)
    expect(screen.getByText('新建工作区')).toBeInTheDocument()
    expect(screen.getByLabelText('工作区名称')).toBeInTheDocument()
    expect(screen.getByLabelText(/描述/)).toBeInTheDocument()
  })

  it('calls onCreate with title and description on submit', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('工作区名称'), 'My Task')
    await user.type(screen.getByLabelText(/描述/), 'Some description')
    await user.click(screen.getByRole('button', { name: '创建' }))

    expect(onCreate).toHaveBeenCalledWith('My Task', 'Some description')
  })

  it('does not submit with empty title', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)

    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('calls onClose when clicking cancel button', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when clicking backdrop', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)

    const backdrop = document.querySelector('.workspace-modal-backdrop')!
    await user.click(backdrop)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose on Escape key', () => {
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)
    fireEvent.keyDown(document.querySelector('.workspace-modal-backdrop')!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('submit button is disabled when title is empty', () => {
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled()
  })

  it('submit button is enabled when title has text', async () => {
    const user = userEvent.setup()
    render(<CreateWorkspaceModal onClose={onClose} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('工作区名称'), 'Task')
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled()
  })
})

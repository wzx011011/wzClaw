import React, { useState, useRef, useEffect } from 'react'

interface CreateTaskModalProps {
  onClose: () => void
  onCreate: (title: string, description?: string) => void
}

export default function CreateWorkspaceModal({ onClose, onCreate }: CreateTaskModalProps): JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    onCreate(title.trim(), description.trim() || undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="workspace-modal-backdrop" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="workspace-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="workspace-modal-title">新建工作区</h2>
        <form onSubmit={handleSubmit}>
          <div className="workspace-modal-field">
            <label htmlFor="task-title">工作区名称</label>
            <input
              ref={inputRef}
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：重构用户认证模块"
              autoComplete="off"
            />
          </div>
          <div className="workspace-modal-field">
            <label htmlFor="task-desc">描述（可选）</label>
            <textarea
              id="task-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="工作区的详细描述..."
              rows={3}
            />
          </div>
          <div className="workspace-modal-actions">
            <button type="button" className="workspace-btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="workspace-btn-primary" disabled={!title.trim()}>
              创建
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import React, { useState, useRef, useEffect } from 'react'
import { useT } from '../../i18n/useT'

interface CreateWorkspaceModalProps {
  onClose: () => void
  onCreate: (title: string, description?: string, folderPath?: string) => void
}

export default function CreateTaskModal({ onClose, onCreate }: CreateWorkspaceModalProps): JSX.Element {
  const t = useT()
  const [folderPath, setFolderPath] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [isPicking, setIsPicking] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const handlePickFolder = async () => {
    setIsPicking(true)
    try {
      const result = await window.wzxclaw.openFolder()
      if (result?.rootPath) {
        setFolderPath(result.rootPath)
        // 从路径中提取文件夹名作为工作区标题
        const folderName = result.rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
        if (!title.trim()) {
          setTitle(folderName)
        }
        titleRef.current?.focus()
      }
    } finally {
      setIsPicking(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    onCreate(title.trim(), description.trim() || undefined, folderPath || undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="workspace-modal-backdrop" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="workspace-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="workspace-modal-title">{t('createTask.title')}</h2>
        <form onSubmit={handleSubmit}>
          <div className="workspace-modal-field">
            <label>{t('createTask.projectFolder')}</label>
            <div className="workspace-modal-folder-row">
              <input
                type="text"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="点击「选择」或输入路径..."
                className="workspace-modal-folder-input"
              />
              <button
                type="button"
                className="workspace-btn-secondary workspace-modal-folder-btn"
                onClick={handlePickFolder}
                disabled={isPicking}
              >
                {isPicking ? '...' : t('createTask.select')}
              </button>
            </div>
          </div>
          <div className="workspace-modal-field">
            <label htmlFor="workspace-title">{t('createTask.workspaceName')}</label>
            <input
              ref={titleRef}
              id="workspace-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('createTask.namePlaceholder')}
              autoComplete="off"
            />
          </div>
          <div className="workspace-modal-field">
            <label htmlFor="workspace-desc">{t('createTask.description')}</label>
            <textarea
              id="workspace-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('createTask.descPlaceholder')}
              rows={3}
            />
          </div>
          <div className="workspace-modal-actions">
            <button type="button" className="workspace-btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="workspace-btn-primary" disabled={!title.trim()}>
              {t('common.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

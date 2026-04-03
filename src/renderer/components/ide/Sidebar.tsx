import React from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'

/**
 * Sidebar — file explorer panel on the left side of the IDE.
 * Shows "Open Folder" button when no workspace is loaded, or the FileExplorer tree.
 */
export default function Sidebar(): JSX.Element {
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const isLoading = useWorkspaceStore((s) => s.isLoading)
  const openFolder = useWorkspaceStore((s) => s.openFolder)

  // Extract workspace folder name from rootPath
  const workspaceName = rootPath ? rootPath.replace(/\\/g, '/').split('/').pop() : null

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>EXPLORER</span>
        {workspaceName && <span className="workspace-name">{workspaceName}</span>}
      </div>
      <div className="sidebar-content">
        {!rootPath ? (
          <button className="open-folder-btn" onClick={openFolder}>
            Open Folder
          </button>
        ) : isLoading ? (
          <div className="sidebar-loading">Loading...</div>
        ) : (
          // FileExplorer will be rendered here in Task 2
          // For now, show a placeholder that the tree loaded
          <div className="file-explorer" id="file-explorer-root" />
        )}
      </div>
    </div>
  )
}

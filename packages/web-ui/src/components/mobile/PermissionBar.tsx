import { useState, useEffect } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'

type PermissionMode = 'always-ask' | 'accept-edits' | 'plan' | 'bypass'

const MODE_LABELS: Record<PermissionMode, string> = {
  'always-ask': '总是询问',
  'accept-edits': '接受编辑',
  'plan': '计划模式',
  'bypass': '自动批准',
}

const MODES: PermissionMode[] = ['bypass', 'accept-edits', 'plan', 'always-ask']

export default function PermissionBar(): React.ReactElement {
  const ds = useDataSource()
  const [mode, setMode] = useState<PermissionMode>('bypass')

  useEffect(() => {
    if (ds?.getPermissionMode) {
      ds.getPermissionMode().then(m => setMode(m as PermissionMode)).catch(() => {})
    }
  }, [ds])

  const handleCycle = async () => {
    const idx = MODES.indexOf(mode)
    const next = MODES[(idx + 1) % MODES.length]
    if (ds?.setPermissionMode) {
      const result = await ds.setPermissionMode(next!)
      setMode(result as PermissionMode)
    }
  }

  return (
    <div className="permission-bar" onClick={handleCycle} title="点击切换权限模式">
      <span className="permission-mode-label">{MODE_LABELS[mode]}</span>
      <span className="permission-mode-value">{mode}</span>
    </div>
  )
}

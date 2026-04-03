import { useState } from 'react'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'
import SettingsModal from './SettingsModal'

/**
 * ChatPanel — chat sidebar with model selector and settings button (per D-57, D-67).
 * Full message rendering and input in Plan 02.
 * Settings modal and model switching added in Plan 03.
 */
export default function ChatPanel(): JSX.Element {
  const model = useSettingsStore((s) => s.model)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const hasApiKey = useSettingsStore((s) => s.hasApiKey)
  const [showSettings, setShowSettings] = useState(false)

  const handleModelChange = (newModel: string): void => {
    // Find the model preset to determine the provider
    const preset = DEFAULT_MODELS.find((m) => m.id === newModel)
    if (preset) {
      updateSettings({ model: newModel, provider: preset.provider })
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-header-title">Chat</span>
        <select
          className="chat-model-select"
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}
        >
          {DEFAULT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {!hasApiKey && <span className="chat-no-key-warning">!</span>}
        <button
          className="chat-settings-btn"
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          gear
        </button>
      </div>
      <div className="chat-messages">Messages will appear here</div>

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  )
}

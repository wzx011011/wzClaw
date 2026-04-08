import { useChatStore } from '../../stores/chat-store'
import { useSettingsStore } from '../../stores/settings-store'
import { DEFAULT_MODELS } from '../../../shared/constants'

// ============================================================
// TokenIndicator — Token usage bar in chat header (per UI-SPEC Component 3)
// Shows color-coded bar with usage text: "{current}K / {max}K"
// ============================================================

export default function TokenIndicator(): JSX.Element | null {
  const tokenUsage = useChatStore((s) => s.currentTokenUsage)
  const model = useSettingsStore((s) => s.model)

  const preset = DEFAULT_MODELS.find(m => m.id === model)
  const maxTokens = preset?.contextWindowSize ?? 128000

  if (!tokenUsage) {
    return (
      <div className="token-indicator" title={`-- / ${(maxTokens / 1000)}K tokens`}>
        <div className="token-bar">
          <div className="token-bar-fill healthy" style={{ width: '0%' }} />
        </div>
        <span className="token-text">-- / {maxTokens / 1000}K</span>
      </div>
    )
  }

  const currentTokens = tokenUsage.inputTokens + tokenUsage.outputTokens
  const percentage = Math.min((currentTokens / maxTokens) * 100, 100)
  const displayCurrent = (currentTokens / 1000).toFixed(1)
  const displayMax = maxTokens / 1000

  let fillClass = 'healthy'
  if (percentage > 80) fillClass = 'danger'
  else if (percentage > 60) fillClass = 'warning'

  const titleText = `${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`

  return (
    <div className="token-indicator" title={titleText}>
      <div className="token-bar">
        <div className={`token-bar-fill ${fillClass}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className={`token-text ${fillClass}`}>{displayCurrent}K / {displayMax}K</span>
    </div>
  )
}

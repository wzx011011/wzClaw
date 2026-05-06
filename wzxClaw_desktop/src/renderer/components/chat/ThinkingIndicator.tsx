import React, { useState, useEffect, useMemo } from 'react'
import { useT } from '../../i18n/useT'

// ============================================================
// ThinkingIndicator — Shimmer "Thinking..." shown while waiting
// for the first token from the agent.
// Uses CSS animations instead of JS state for opacity transitions.
// ============================================================

const CYCLE_MS = 3000

export default function ThinkingIndicator(): JSX.Element {
  const t = useT()
  const PHRASES = useMemo(() => (t('chat.thinking.phrases') as string).split(','), [t])

  const [phraseIndex, setPhraseIndex] = useState(
    () => Math.floor(Math.random() * 4)
  )

  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % PHRASES.length)
    }, CYCLE_MS)
    return () => clearInterval(interval)
  }, [PHRASES.length])

  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span className="thinking-phrase thinking-fade">
        {PHRASES[phraseIndex]}
      </span>
    </div>
  )
}

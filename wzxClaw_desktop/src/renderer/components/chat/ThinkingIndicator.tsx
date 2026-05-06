import React, { useState, useEffect } from 'react'

// ============================================================
// ThinkingIndicator — Shimmer "Thinking..." shown while waiting
// for the first token from the agent.
// Uses CSS animations instead of JS state for opacity transitions.
// ============================================================

const PHRASES = ['思考中...', '推理中...', '分析中...', '评估中...']
const CYCLE_MS = 3000

export default function ThinkingIndicator(): JSX.Element {
  const [phraseIndex, setPhraseIndex] = useState(
    () => Math.floor(Math.random() * PHRASES.length)
  )

  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % PHRASES.length)
    }, CYCLE_MS)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span className="thinking-phrase thinking-fade">
        {PHRASES[phraseIndex]}
      </span>
    </div>
  )
}

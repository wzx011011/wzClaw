import React, { useState, useEffect } from 'react'

// ============================================================
// ThinkingIndicator — Shimmer "Thinking..." shown while waiting
// for the first token from the agent.
// ============================================================

const PHRASES = ['Thinking...', 'Reasoning...', 'Analyzing...', 'Evaluating...']

export default function ThinkingIndicator(): JSX.Element {
  const [phraseIndex, setPhraseIndex] = useState(
    () => Math.floor(Math.random() * PHRASES.length)
  )

  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % PHRASES.length)
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span className="thinking-phrase" key={phraseIndex}>
        {PHRASES[phraseIndex]}
      </span>
    </div>
  )
}

import React, { useState, useEffect, useRef } from 'react'

// ============================================================
// ThinkingIndicator — Shimmer "Thinking..." shown while waiting
// for the first token from the agent.
// ============================================================

const PHRASES = ['Thinking...', 'Reasoning...', 'Analyzing...', 'Evaluating...']
const CYCLE_MS = 3000
const FADE_MS = 280

export default function ThinkingIndicator(): JSX.Element {
  const [phraseIndex, setPhraseIndex] = useState(
    () => Math.floor(Math.random() * PHRASES.length)
  )
  const [opacity, setOpacity] = useState(1)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const interval = setInterval(() => {
      // Fade out, swap text, fade in
      setOpacity(0)
      fadeTimer.current = setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % PHRASES.length)
        setOpacity(1)
      }, FADE_MS)
    }, CYCLE_MS)

    return () => {
      clearInterval(interval)
      if (fadeTimer.current !== null) clearTimeout(fadeTimer.current)
    }
  }, [])

  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span
        className="thinking-phrase"
        style={{ opacity, transition: `opacity ${FADE_MS}ms ease` }}
      >
        {PHRASES[phraseIndex]}
      </span>
    </div>
  )
}

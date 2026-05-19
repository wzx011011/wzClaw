// Minimal test: just React + zustand, no other deps
import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'

// Minimal zustand store
const useTestStore = create<{ count: number; inc: () => void }>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
}))

function TestApp() {
  const { count, inc } = useTestStore()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <div style={{ padding: 40, color: 'white', background: '#1a1a2e', minHeight: '100vh' }}>
      <h1>Zustand + React 19 Test</h1>
      <p>Count: {count}</p>
      <button onClick={inc}>Increment</button>
      <p>Mounted: {String(mounted)}</p>
      <p>React version: {React.version}</p>
    </div>
  )
}

import React from 'react'

createRoot(document.getElementById('root')!).render(
  <TestApp />
)

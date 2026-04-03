import type { Message } from '../shared/types'

function App(): JSX.Element {
  // Phase 1: Minimal shell. Verify shared types are importable.
  const _message: Message = {
    role: 'user',
    content: 'wzxClaw initialized',
    timestamp: Date.now()
  }

  return (
    <div style={{ padding: 20, fontFamily: 'sans-serif' }}>
      <h1>wzxClaw</h1>
      <p>AI Coding IDE - Phase 1 Foundation</p>
    </div>
  )
}

export default App

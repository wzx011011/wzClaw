import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Catch renderer errors that might cause silent freeze
window.addEventListener('error', (e) => {
  console.error('[RENDERER ERROR]', e.message, e.filename, e.lineno)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[RENDERER UNHANDLED REJECTION]', (e as PromiseRejectionEvent).reason)
})

// Note: React.StrictMode removed — Monaco Editor does not handle double-mount well
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)

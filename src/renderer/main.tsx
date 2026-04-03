import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Note: React.StrictMode removed — Monaco Editor does not handle double-mount well
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)

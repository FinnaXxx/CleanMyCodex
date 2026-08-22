import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './App.css'
import { PreferencesProvider } from './preferences'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreferencesProvider><App /></PreferencesProvider>
  </StrictMode>
)

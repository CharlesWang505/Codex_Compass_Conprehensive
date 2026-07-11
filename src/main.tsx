import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { RootSurface } from './RootSurface'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootSurface />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { engine } from './audio/engine'
import { getPerformer } from './audio/live'
import { analyzeUrl, compareUrl } from './audio/reference'
import { devCompareTarget, type DevCompareRequest } from './state/playlist'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// Debug handle for the dev console (not included in production builds).
// compareReference({ url, songId?, entryId?, start?, length?, referenceKind?, room?, style? }) fetches
// an audio file (e.g. a Vite /@fs/ URL), renders our version of the song or playlist entry and
// returns the Playlist comparison as JSON; analyzeUrl(url, { start?, length? }) returns its features.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __mkhuur: { engine, getPerformer, compareReference: async (req: DevCompareRequest) => compareUrl(devCompareTarget(req)), analyzeUrl }
  })
}

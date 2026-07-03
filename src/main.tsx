import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Auto-reload past stale caches: fetch the freshly-deployed build id (never
// cached) and, if it differs from the one baked into this page, reload via a
// changed query string so the browser is forced to fetch the new index.html.
function checkForNewVersion() {
  const current = __APP_VERSION__
  fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { v?: string } | null) => {
      if (!data?.v || data.v === current) return
      const url = new URL(window.location.href)
      // Guard against a reload loop if the served bundle and version.json ever
      // disagree transiently: only navigate once per target version.
      if (url.searchParams.get('v') === data.v) return
      url.searchParams.set('v', data.v)
      window.location.replace(url.toString())
    })
    .catch(() => {
      /* offline or version.json missing — keep the current page */
    })
}
checkForNewVersion()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

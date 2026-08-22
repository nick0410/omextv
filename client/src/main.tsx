import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill'
import './index.css'
import App from './App.tsx'
import { loadRuntimeConfig } from './lib/apiConfig'

/*
 * Windows ships no flag glyphs, so a regional-indicator pair renders as the
 * boxed country letters instead of a flag. This injects a small woff2 that
 * supplies them — without it roughly every Windows visitor sees "IN" where a
 * flag should be. The font is bundled, not fetched from a CDN.
 */
polyfillCountryFlagEmojis()

// Resolve the API host before the first render, so no component fires a
// request against a stale base. A missing or slow config does not block:
// loadRuntimeConfig resolves either way and falls back to the build value.
void loadRuntimeConfig().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})

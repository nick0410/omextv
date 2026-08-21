import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill'
import './index.css'
import App from './App.tsx'

/*
 * Windows ships no flag glyphs, so a regional-indicator pair renders as the
 * boxed country letters instead of a flag. This injects a small woff2 that
 * supplies them — without it roughly every Windows visitor sees "IN" where a
 * flag should be. The font is bundled, not fetched from a CDN.
 */
polyfillCountryFlagEmojis()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

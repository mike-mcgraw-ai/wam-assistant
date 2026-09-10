/**
 * Runtime configuration.
 *
 * The hub URL must match an origin listed in app.json's network whitelist —
 * the whitelist is fixed at pack time and cannot take a value typed in later,
 * so the server's real origin has to be known before you package.
 */

/**
 * Where the hub lives.
 *
 * This code runs in a WebView on the *phone*, so "localhost" means the phone —
 * which is the single most likely reason a first run shows "No data" with
 * nothing explaining why.
 *
 * During QR sideload the page is served by the dev server on the laptop, so
 * the hub is the same host on the hub's port. Deriving it from
 * `window.location` means there is nothing to configure to get a first run
 * working, and nothing to forget to change back.
 */
const HUB_PORT = 8787

/**
 * Baked in at build time from VITE_HUB_URL.
 *
 * A packed build is loaded from inside the .ehpk, so `window.location` has no
 * useful host to derive from — a packed app would otherwise fall back to
 * localhost and quietly fail to reach anything. Set this when packing:
 *
 *   VITE_HUB_URL=https://hub.example.com npm run pack
 *
 * It must also appear verbatim in app.json's network whitelist, which is
 * frozen at pack time.
 */
const BAKED = (import.meta.env?.VITE_HUB_URL as string | undefined)?.replace(/\/+$/, '')

function defaultServerUrl(): string {
  // A packed build knows where it is going; nothing should override that.
  if (BAKED) return BAKED

  try {
    const { protocol, hostname } = window.location
    // During QR sideload the dev server serves the app, so the hub is the same
    // machine. A file:// or about:blank host gives us nothing to work from.
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return `${protocol}//${hostname}:${HUB_PORT}`
    }
  } catch {
    // No window (the demo harness runs this in Node) — fall through.
  }
  return `http://localhost:${HUB_PORT}`
}

const DEFAULTS = {
  /**
   * Same machine as whatever served the app, on the hub port.
   * Override with localStorage during development, or hard-code the real
   * origin before packing a build for submission.
   */
  serverUrl: defaultServerUrl(),
  /** How often to re-poll while the app is open, in ms. */
  pollMs: 15_000,
  /** Give up on a request after this long; the glasses should never hang. */
  timeoutMs: 6_000,
  /**
   * Rows of content, between header and footer.
   * 9 visible lines total: header + blank + 6 rows + footer.
   */
  rowsPerPage: 7,
  /**
   * Hard ceilings per rendered page.
   *
   * maxLines is the binding one and it is now measured, not guessed: 9 lines
   * are visible on real hardware. The firmware will scroll past that, but a
   * row you have to scroll to find is a row you did not see.
   * maxChars is the firmware's own limit (2000 on upgrade) with room spare.
   */
  maxLines: 9,
  maxChars: 900,
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const config = {
  serverUrl: (stored('opsboard.serverUrl') || DEFAULTS.serverUrl).replace(/\/+$/, ''),
  /**
   * Read token, if the server requires one.
   * Deliberately NOT a constant in this file: anything bundled into the .ehpk
   * can be extracted by anyone who installs it. Set it once from the phone
   * console with:
   *   localStorage.setItem('opsboard.readToken', '...')
   */
  readToken: stored('opsboard.readToken') || '',
  pollMs: Number(stored('opsboard.pollMs')) || DEFAULTS.pollMs,
  timeoutMs: DEFAULTS.timeoutMs,
  rowsPerPage: DEFAULTS.rowsPerPage,
  maxLines: DEFAULTS.maxLines,
  maxChars: DEFAULTS.maxChars,
}

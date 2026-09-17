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
  /** How often Listen asks the hub for fresh transcript lines. */
  listenPollMs: 1_000,
  /** How often the foreground Coach is allowed to surface a fresh cue. */
  cueMs: 2 * 60_000,
  /** Do not interrupt active use; wait this long since the last input. */
  cueIdleMs: 25_000,
  /** Give up on a request after this long; the glasses should never hang. */
  timeoutMs: 6_000,
  /** The Even SDK does not declare the PCM sample rate; override if hardware proves otherwise. */
  audioSampleRate: 16_000,
  /** Send speech to the hub in short chunks. */
  audioChunkMs: 2_000,
  /** Ignore chunks quieter than this RMS level. */
  audioMinRms: 180,
  /** Show Listen's mic/STT counters instead of giving the transcript the room. */
  listenDebug: false,
  /**
   * Rows of content, between header and footer.
   * 9 visible lines total: header + blank + 6 rows + footer.
   */
  /**
   * Show the marker key and the click hint on the running order.
   *
   * Two rows out of nine, which is expensive — this is here because the
   * markers are new, and it is one line to turn off once they are not.
   */
  hints: true,

  /**
   * Is the Ops half of the app switched on?
   *
   * Off. Ops is the work half — boards, the index, the metric screens — and
   * none of it is what these glasses are for day to day. Sidelined rather than
   * deleted: every Ops screen, route and config file is still in the repo, and
   * this flag is the whole of what stands between them and coming back.
   *
   * With it off the app has one space, Life, and the running order is home.
   * Nothing in the Life path has to know Ops exists.
   *
   * Back on with: localStorage.setItem('opsboard.ops', 'on')
   */
  ops: false,

  /**
   * Line numbers on every rendered line.
   *
   * On by default. The screen is nine lines and the only way to describe one
   * from a walk is to point at a row; "line 4 will not select" is a bug report,
   * "the vacuum one" is three messages of guessing. It costs two characters of
   * width, which is cheaper than the round trip.
   *
   * Off by default: two characters of width on every line, on every screen,
   * is a real cost to pay all day for something only needed while describing a
   * bug. Turn it on for that, turn it off after.
   *
   * On with: localStorage.setItem('opsboard.diagnostics', 'on')
   */
  diagnostics: false,

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
  listenPollMs: Number(stored('opsboard.listenPollMs')) || DEFAULTS.listenPollMs,
  cueMs: Number(stored('opsboard.cueMs')) || DEFAULTS.cueMs,
  cueIdleMs: Number(stored('opsboard.cueIdleMs')) || DEFAULTS.cueIdleMs,
  autoCue: stored('opsboard.autoCue') !== 'off',
  audioSampleRate: Number(stored('opsboard.audioSampleRate')) || DEFAULTS.audioSampleRate,
  audioChunkMs: Number(stored('opsboard.audioChunkMs')) || DEFAULTS.audioChunkMs,
  audioMinRms: Number(stored('opsboard.audioMinRms')) || DEFAULTS.audioMinRms,
  // On with: localStorage.setItem('opsboard.listenDebug', 'on')
  listenDebug: stored('opsboard.listenDebug') === 'on' || DEFAULTS.listenDebug,
  timeoutMs: DEFAULTS.timeoutMs,
  rowsPerPage: DEFAULTS.rowsPerPage,
  // Off with: localStorage.setItem('opsboard.hints', 'off')
  hints: stored('opsboard.hints') !== 'off',
  // On with: localStorage.setItem('opsboard.ops', 'on')
  ops: stored('opsboard.ops') === 'on' || DEFAULTS.ops,
  // On with: localStorage.setItem('opsboard.diagnostics', 'on')
  diagnostics: stored('opsboard.diagnostics') === 'on' || DEFAULTS.diagnostics,
  maxLines: DEFAULTS.maxLines,
  maxChars: DEFAULTS.maxChars,
}

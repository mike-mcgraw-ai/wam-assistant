import type { Snapshot } from './types'

/**
 * Last-known snapshot, cached so a cold start has something to draw
 * immediately instead of "Loading...".
 *
 * Launching from the glasses menu is a fresh page load every time: bridge
 * handshake, then a network round trip, then first paint. That is the exact
 * moment you wanted a two-second glance, so we paint stale-but-labelled data
 * first and let the live fetch overwrite it a moment later.
 *
 * localStorage survives suspension, app kill and update — it is cleared only on
 * uninstall — which makes it the right store for this. It can still throw or
 * come back empty (private mode, cleared site data), so every access is guarded.
 */

const KEY = 'opsboard.lastSnapshot'

/**
 * Beyond this, cached values are worse than no values: you would be reading
 * yesterday's plant state as if it were current. The staleness markers already
 * cover minutes; this covers "the app has not been opened in a long time".
 */
const MAX_CACHE_AGE_MS = 60 * 60 * 1000

export function saveSnapshot(snapshot: Snapshot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot))
  } catch {
    // Quota or a blocked store: the app works fine without the cache.
  }
}

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null

    const snapshot = JSON.parse(raw) as Snapshot
    if (!snapshot || !Array.isArray(snapshot.boards)) return null

    const generated = new Date(snapshot.generatedAt).getTime()
    if (!Number.isFinite(generated)) return null
    if (Date.now() - generated > MAX_CACHE_AGE_MS) return null

    return snapshot
  } catch {
    return null
  }
}

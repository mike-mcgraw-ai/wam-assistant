import type { BlockPlan, Snapshot } from './types'

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

/**
 * Last running order, per space (v0.124.0).
 *
 * The snapshot cache never covered the plan, so every launch drew a
 * "Working it out..." placeholder across all four image tiles and then rebuilt
 * them with the real list a second later: the screen visibly built itself
 * twice, ~0.4 s per tile. With the last plan cached, the first frame is the
 * list, and the live fetch only resends rows that actually changed.
 *
 * Twelve hours: an older plan would mostly be wrong rows, which costs the same
 * rebuild as no cache at all.
 */
const PLAN_KEY = 'opsboard.lastPlan'
const MAX_PLAN_AGE_MS = 12 * 60 * 60 * 1000

export function savePlan(space: string, plan: BlockPlan): void {
  try {
    localStorage.setItem(`${PLAN_KEY}.${space}`, JSON.stringify({ at: Date.now(), plan }))
  } catch {
    // The app works without the cache.
  }
}

export function loadPlan(space: string): BlockPlan | null {
  try {
    const raw = localStorage.getItem(`${PLAN_KEY}.${space}`)
    if (!raw) return null
    const saved = JSON.parse(raw) as { at?: number; plan?: BlockPlan }
    if (!saved?.plan || typeof saved.at !== 'number') return null
    if (Date.now() - saved.at > MAX_PLAN_AGE_MS) return null
    return saved.plan
  } catch {
    return null
  }
}

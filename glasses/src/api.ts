import { config } from './config'
import type { BlockPlan, ChecklistsState, Snapshot } from './types'

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra }
  if (config.readToken) headers.Authorization = `Bearer ${config.readToken}`
  return headers
}

/**
 * Fetch the current snapshot.
 *
 * Two things this deliberately does NOT do:
 *  - retry on its own (a stuck retry loop on a dead network is worse than one
 *    honest failure you can see on the glasses)
 *  - throw past the caller (the UI must always render something)
 */
export async function fetchSnapshot(): Promise<
  { ok: true; snapshot: Snapshot } | { ok: false; error: string }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const res = await fetch(`${config.serverUrl}/state`, {
      headers: authHeaders(),
      signal: controller.signal,
      cache: 'no-store',
    })

    if (!res.ok) {
      // 401 is worth calling out by name — it is almost always the read token.
      if (res.status === 401) return { ok: false, error: 'auth failed (401)' }
      return { ok: false, error: `server ${res.status}` }
    }

    const snapshot = (await res.json()) as Snapshot
    if (!snapshot || !Array.isArray(snapshot.boards)) {
      return { ok: false, error: 'bad payload' }
    }
    return { ok: true, snapshot }
  } catch (err: unknown) {
    const message =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : 'network error'
    // A CORS rejection surfaces here as an opaque "Failed to fetch".
    return { ok: false, error: message.slice(0, 40) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Checklist writes.
 *
 * Each returns the server's fresh checklist state, so the glasses repaint from
 * what the server actually recorded rather than from an optimistic local guess.
 * A check that did not persist must not look checked.
 */
async function post(
  path: string,
  body: unknown,
): Promise<{ ok: true; checklists: ChecklistsState } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(`${config.serverUrl}${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: payload?.error ?? `server ${res.status}` }
    if (!payload?.checklists) return { ok: false, error: 'bad payload' }
    return { ok: true, checklists: payload.checklists }
  } catch (err: unknown) {
    const message =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : 'network error'
    return { ok: false, error: message.slice(0, 40) }
  } finally {
    clearTimeout(timer)
  }
}

export const checkItem = (runId: string, itemId: string, done: boolean) =>
  post('/check', { runId, itemId, done })

export const startChecklist = (checklistId: string) => post('/run/start', { checklistId })

export const finishChecklist = (runId: string) => post('/run/finish', { runId })

/**
 * Mark a step as begun, which starts its clock — and for a `wait` step arms
 * the reminder. Idempotent server-side, so calling it on every arrival is safe
 * and will not restart a cycle that is already running.
 */
export const beginStep = (runId: string, itemId: string) => post('/step/begin', { runId, itemId })

/** Put a step back to not-started, discarding a bogus elapsed time. */
export const resetStep = (runId: string, itemId: string) => post('/step/reset', { runId, itemId })

/**
 * Tick something off the shared list. Returns nothing useful, so the caller
 * refetches — the inbox is shared, and the server's view of it is the only one
 * that matters once two people are adding to it.
 */
export async function completeInboxItem(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.serverUrl}/inbox/${encodeURIComponent(id)}/done`, {
      method: 'POST',
      headers: authHeaders(),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Tick off a one-off task. Like the inbox, this returns nothing worth keeping
 * — the caller refetches the plan, because completing a task changes every
 * running total below it.
 */
export async function completeTask(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.serverUrl}/task/${encodeURIComponent(id)}/done`, {
      method: 'POST',
      headers: authHeaders(),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Ask the server to schedule a block. The maths lives there, not here. */
export async function fetchPlan(space: string): Promise<
  { ok: true; plan: BlockPlan } | { ok: false; error: string }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(`${config.serverUrl}/plan?space=${encodeURIComponent(space)}`, {
      headers: authHeaders(),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, error: `server ${res.status}` }
    const plan = (await res.json()) as BlockPlan
    if (!plan || !Array.isArray(plan.timeline)) return { ok: false, error: 'bad payload' }
    return { ok: true, plan }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'network error'
    return { ok: false, error: message.slice(0, 40) }
  } finally {
    clearTimeout(timer)
  }
}

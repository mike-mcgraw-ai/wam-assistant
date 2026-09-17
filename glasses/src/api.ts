import { config } from './config'
import type {
  BlockPlan,
  ChecklistsState,
  CoachCueResponse,
  CoachMode,
  CoachSessionResponse,
  CoachSessionWriteResponse,
  NoteTranscript,
  Snapshot,
} from './types'

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

/** Permanently remove one user-created task or chore note. */
export async function deleteNote(
  kind: 'task' | 'chore',
  subjectId: string,
  noteId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${config.serverUrl}/note/delete`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ kind, subjectId, noteId }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    const payload = await res.json().catch(() => null)
    return res.ok ? { ok: true } : { ok: false, error: payload?.error ?? `server ${res.status}` }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 40) : 'network error' }
  }
}

/** Load the original speaker-formatted session behind a Listen-created note. */
export async function fetchNoteTranscript(noteId: string): Promise<NoteTranscript | null> {
  if (!noteId.endsWith(':note')) return null
  const sessionId = noteId.slice(0, -':note'.length)
  if (!sessionId) return null
  try {
    const res = await fetch(
      `${config.serverUrl}/coach/session/${encodeURIComponent(sessionId)}/transcript`,
      { headers: authHeaders(), signal: AbortSignal.timeout(config.timeoutMs), cache: 'no-store' },
    )
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    if (!payload?.ok || !Array.isArray(payload.segments)) return null
    return {
      noteId,
      sessionId,
      title: String(payload.title || 'Transcript'),
      startedAt: Number(payload.startedAt) || 0,
      endedAt: payload.endedAt ? Number(payload.endedAt) : null,
      segments: payload.segments,
    }
  } catch {
    return null
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

export async function fetchCoachCue(space: string, since: string | null = null): Promise<CoachCueResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  const params = new URLSearchParams({ space })
  if (since) params.set('since', since)

  try {
    const res = await fetch(`${config.serverUrl}/ai/cue?${params.toString()}`, {
      headers: authHeaders(),
      signal: controller.signal,
      cache: 'no-store',
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: payload?.error ?? `server ${res.status}` }
    if (!payload?.cue) return { ok: false, error: 'bad payload' }
    return payload as CoachCueResponse
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

export async function fetchCoachSession(space: string): Promise<CoachSessionResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const res = await fetch(`${config.serverUrl}/coach/session/current?space=${encodeURIComponent(space)}`, {
      headers: authHeaders(),
      signal: controller.signal,
      cache: 'no-store',
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: payload?.error ?? `server ${res.status}` }
    if (!payload?.mode) return { ok: false, error: 'bad payload' }
    return payload as CoachSessionResponse
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

export async function activateCoachMode(
  space: string,
  modeId: string,
): Promise<{ ok: true; mode: CoachMode } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const res = await fetch(`${config.serverUrl}/coach/modes/${encodeURIComponent(modeId)}/activate`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ space }),
      signal: controller.signal,
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: payload?.error ?? `server ${res.status}` }
    if (!payload?.mode) return { ok: false, error: 'bad payload' }
    return { ok: true, mode: payload.mode as CoachMode }
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

async function postCoach(
  path: string,
  body: unknown,
): Promise<CoachSessionWriteResponse> {
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
    if (!payload?.session) return { ok: false, error: 'bad payload' }
    return payload as CoachSessionWriteResponse
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

/**
 * Start listening, and tell the hub what was on screen when you did.
 *
 * `context` is how a captured line finds its subject without you saying it.
 * Standing on "Replace car tire" and starting to talk means the line is almost
 * certainly about the tire; the hub's router uses this as the default and
 * overrides it only when the line is plainly about something else.
 *
 * It is a hint, never an instruction — the router owns the decision.
 */
export const startCoachSession = (
  space: string,
  context: { taskId?: string; choreId?: string; label: string } | null = null,
  modeId: string | null = null,
) =>
  postCoach('/coach/session/start', {
    space,
    clientId: `glasses-${Date.now().toString(36)}`,
    ...(modeId ? { modeId } : {}),
    ...(context ? { context } : {}),
  })

export const endCoachSession = (sessionId: string) =>
  postCoach(`/coach/session/${encodeURIComponent(sessionId)}/end`, {})

export async function sendCoachAudio(
  sessionId: string,
  body: {
    pcmBase64: string
    sampleRate: number
    channels: number
    source: string
    speakerRole: string
    direction: number | null
    clientId: string
    at: number
  },
): Promise<{ ok: true; skipped?: boolean; transcription?: { text: string } } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(config.timeoutMs, 20_000))

  try {
    const res = await fetch(`${config.serverUrl}/coach/session/${encodeURIComponent(sessionId)}/audio`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: payload?.error ?? `server ${res.status}` }
    return payload
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

/**
 * What the hub made of a finished Listen session.
 *
 * Separate from the transcript on purpose. The transcript is what was said;
 * this is what it amounted to — the thing actually worth reading back on a
 * nine-line screen while walking.
 *
 * Returns `null` rather than an error when the hub does not have the route or
 * has nothing to say, because a session that ends with no summary is normal
 * and must not paint an error over a transcript that is perfectly fine.
 */
export async function fetchSessionSummary(
  sessionId: string,
): Promise<{ title: string; lines: string[] } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(
      `${config.serverUrl}/coach/session/${encodeURIComponent(sessionId)}/summary`,
      { headers: authHeaders(), signal: controller.signal, cache: 'no-store' },
    )
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    const lines = Array.isArray(payload?.lines) ? payload.lines.map(String) : []
    if (lines.length === 0) return null
    return { title: String(payload?.title || 'Summary'), lines }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { coalesceTranscriptSegments } from './transcript.js'

const SPACES = new Set(['ops', 'life'])
const SPEAK_UP = new Set(['low', 'medium', 'high'])
const CUE_TYPES = ['answers', 'followups', 'explanations', 'factChecks', 'advice', 'thoughts']
const MAX_SEGMENTS_PER_SESSION = 240

const DEFAULT_MODES = [
  {
    id: 'conversation',
    name: 'Conversation',
    category: '',
    keepPrivate: false,
    behavior:
      'The user is in a normal back-and-forth conversation and wants to come across as sharp, present, and well-informed. Surface a cue when the other person asks a factual question, states something that is likely wrong, or leaves a genuinely useful follow-up hanging. Favor helpful and concise over clever.',
    cueTypes: {
      answers: true,
      followups: true,
      explanations: true,
      factChecks: true,
      advice: true,
      thoughts: true,
    },
    speakUp: 'high',
    promptLulls: true,
    periodicRecap: true,
    recapMinutes: 2,
    lullSeconds: 45,
    files: [],
  },
  {
    id: 'listening',
    name: 'Listening',
    category: 'Personal',
    keepPrivate: false,
    behavior:
      'The user wants to be a warm, fully present listener who makes others feel genuinely heard. Lean toward gentle, specific follow-up questions and concrete support when the other person is struggling. Stay silent unless a cue adds real warmth or insight.',
    cueTypes: {
      answers: false,
      followups: true,
      explanations: false,
      factChecks: false,
      advice: true,
      thoughts: true,
    },
    speakUp: 'medium',
    promptLulls: true,
    periodicRecap: true,
    recapMinutes: 2,
    lullSeconds: 60,
    files: [],
  },
  {
    id: 'meeting',
    name: 'Meeting',
    category: 'Work',
    keepPrivate: false,
    behavior:
      'The user is in a meeting and wants crisp help: track decisions, promises, open questions, risks, and factual corrections. Prefer short cues that can be read quickly without pulling attention away from the room.',
    cueTypes: {
      answers: true,
      followups: true,
      explanations: true,
      factChecks: true,
      advice: false,
      thoughts: true,
    },
    speakUp: 'medium',
    promptLulls: false,
    periodicRecap: true,
    recapMinutes: 2,
    lullSeconds: 90,
    files: [],
  },
]

function nowMs(value = Date.now()) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : Date.now()
}

function spaceId(value) {
  return SPACES.has(value) ? value : 'ops'
}

function str(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeNoteText(value) {
  return str(value, 500)
    .replace(/^(?:um+|uh+|like|okay|ok|so|yeah|well)[, ]+/i, '')
    .replace(/\b(?:um+|uh+)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function noteKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function clipNote(text, max = 82) {
  const clean = normalizeNoteText(text)
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 3)).trim()}...`
}

function splitThoughts(text) {
  const clean = normalizeNoteText(text)
  if (!clean) return []
  const parts = clean.match(/[^.!?]+[.!?]?/g) || [clean]
  return parts.map(part => normalizeNoteText(part)).filter(part => part.length >= 8)
}

function looksOpen(text) {
  return (
    text.includes('?') ||
    /^(?:who|what|when|where|why|how|can|could|would|should|is|are|did|do|does)\b/i.test(text)
  )
}

function noteKind(text) {
  if (looksOpen(text)) return 'Open'
  if (/\b(?:decided|decision|agreed|settled|plan is|we will|we're going to|i will|i'll)\b/i.test(text)) return 'Decided'
  if (/\b(?:remind me to|remember to|need to|have to|should|follow up|call|text|email|send|book|schedule|pay|check|buy|file|finish|ask|tell)\b/i.test(text)) return 'Next'
  if (/\b(?:connect|connected|dots?|because|so that|which means|means that|ties? to|related|thread|pattern|point is|trying to say|lost|tangent|back to|where we were)\b/i.test(text)) return 'Dot'
  return 'Now'
}

function runningNoteLine(label, text) {
  const prefix = `${label}: `
  // The glasses add "* " before this. Keep each compass item to one physical
  // row so all three ideas remain visible instead of one long item wrapping
  // over the rest of the note.
  return `${prefix}${clipNote(text, 42 - prefix.length)}`
}

function runningConversationNote(session) {
  const pieces = []
  for (const segment of coalesceTranscriptSegments(session?.segments)) {
    for (const text of splitThoughts(segment.text)) {
      pieces.push({ text, kind: noteKind(text), at: segment.at })
    }
  }
  if (pieces.length === 0) return null

  const latest = pieces.at(-1)
  const chosen = []
  const seen = new Set()
  const add = (label, piece) => {
    if (!piece?.text || chosen.length >= 3) return
    const key = noteKey(piece.text)
    if (!key || seen.has(key)) return
    seen.add(key)
    chosen.push(runningNoteLine(label, piece.text))
  }

  const recent = pieces.slice(-36)
  const returnsToThread = piece =>
    /\b(?:back to|where we were|main point|what i was saying|thread was|before (?:that|the) tangent)\b/i.test(piece.text)
  const tangentAt = recent.findLastIndex(piece =>
    !returnsToThread(piece) && /\b(?:tangent|aside|before i forget|by the way|separate thought|park that)\b/i.test(piece.text),
  )
  const parkedThread = tangentAt > 0 ? recent[tangentAt - 1] : null
  const connectedThread = [...recent].reverse().find(piece => piece.kind === 'Dot' || piece.kind === 'Decided')
  const thread = parkedThread || connectedThread || recent[0] || latest
  const visibleKeys = new Set([noteKey(thread?.text), noteKey(latest?.text)])
  const actionableHold = [...recent]
    .reverse()
    .find(piece =>
      !visibleKeys.has(noteKey(piece.text)) &&
      (piece.kind === 'Open' || piece.kind === 'Next' || piece.kind === 'Decided'),
    )
  const tangentHold = tangentAt >= 0 ? recent[tangentAt] : null
  const hold = actionableHold || tangentHold

  add('Thread', thread)
  add('Now', latest)
  add('Hold', hold)

  for (const piece of [...recent].reverse()) add('Hold', piece)

  return {
    title: 'Conversation compass',
    lines: chosen,
    updatedAt: latest.at,
    segmentCount: session.segments.length,
  }
}

function contextDefaults(context) {
  if (!context || typeof context !== 'object') return null
  const taskId = str(context.taskId, 80)
  const choreId = str(context.choreId, 80)
  const label = str(context.label, 120)
  if ((!taskId && !choreId) || !label) return null
  return { ...(taskId ? { taskId } : {}), ...(choreId ? { choreId } : {}), label }
}

function bool(value, fallback = false) {
  return value === undefined ? fallback : value === true
}

function modeDefaults(mode) {
  const cueTypes = {}
  for (const type of CUE_TYPES) cueTypes[type] = mode?.cueTypes?.[type] === true
  return {
    id: str(mode?.id, 40),
    name: str(mode?.name, 40),
    category: str(mode?.category, 40),
    keepPrivate: bool(mode?.keepPrivate, false),
    behavior: str(mode?.behavior, 1200),
    cueTypes,
    speakUp: SPEAK_UP.has(mode?.speakUp) ? mode.speakUp : 'medium',
    promptLulls: bool(mode?.promptLulls, true),
    periodicRecap: bool(mode?.periodicRecap, true),
    recapMinutes: Math.max(1, Math.min(15, Number(mode?.recapMinutes) || 2)),
    lullSeconds: Math.max(20, Math.min(300, Number(mode?.lullSeconds) || 60)),
    files: Array.isArray(mode?.files) ? mode.files.slice(0, 5).map(file => str(file, 80)).filter(Boolean) : [],
  }
}

function defaultModeMap() {
  return new Map(DEFAULT_MODES.map(mode => [mode.id, modeDefaults(mode)]))
}

function publicSession(session, mode = null) {
  if (!session) return null
  return {
    id: session.id,
    space: session.space,
    modeId: session.modeId,
    modeName: mode?.name ?? session.modeId,
    title: session.title,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    active: !session.endedAt,
    context: session.context ?? null,
    segmentCount: session.segments.length,
    // Raw two-second chunks are an implementation detail. The live display
    // gets speech-sized blocks; the transcript endpoint includes raw chunks
    // separately for recovery and inspection.
    recentSegments: coalesceTranscriptSegments(session.segments).slice(-24),
    runningNote: runningConversationNote(session),
    lastCueAt: session.lastCueAt ?? null,
    lastRecapAt: session.lastRecapAt ?? null,
  }
}

export class Coach {
  constructor({ storePath, logPath }) {
    this.storePath = storePath
    this.logPath = logPath
    this.modes = defaultModeMap()
    this.activeModeBySpace = { ops: 'conversation', life: 'listening' }
    /** @type {Map<string, any>} */
    this.sessions = new Map()
    this.activeSessionBySpace = { ops: null, life: null }
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      for (const mode of raw.modes || []) {
        const clean = modeDefaults(mode)
        if (clean.id && clean.name) this.modes.set(clean.id, clean)
      }
      if (raw.activeModeBySpace) {
        for (const space of SPACES) {
          const modeId = raw.activeModeBySpace[space]
          if (this.modes.has(modeId)) this.activeModeBySpace[space] = modeId
        }
      }
      for (const session of raw.sessions || []) {
        if (!session?.id) continue
        session.space = spaceId(session.space)
        session.modeId = this.modes.has(session.modeId) ? session.modeId : this.activeModeBySpace[session.space]
        session.title = str(session.title || this.modes.get(session.modeId)?.name || 'Listening', 80)
        session.startedAt = nowMs(session.startedAt)
        session.updatedAt = nowMs(session.updatedAt || session.startedAt)
        session.endedAt = session.endedAt ? nowMs(session.endedAt) : null
        session.context = contextDefaults(session.context)
        session.segments = Array.isArray(session.segments)
          ? session.segments.map(segment => this.#cleanSegment(segment)).filter(Boolean).slice(-MAX_SEGMENTS_PER_SESSION)
          : []
        this.sessions.set(session.id, session)
      }
      if (raw.activeSessionBySpace) {
        for (const space of SPACES) {
          const id = raw.activeSessionBySpace[space]
          const session = id ? this.sessions.get(id) : null
          this.activeSessionBySpace[space] = session && !session.endedAt ? id : null
        }
      }
      console.log(`[coach] restored ${this.modes.size} modes, ${this.sessions.size} sessions`)
    } catch (err) {
      console.warn(`[coach] could not read store: ${err.message}`)
    }
  }

  #persist() {
    if (!this.storePath) return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      const cutoff = Date.now() - 14 * 86400 * 1000
      const sessions = [...this.sessions.values()].filter(session => !session.endedAt || session.updatedAt > cutoff)
      writeFileSync(
        this.storePath,
        JSON.stringify(
          {
            modes: [...this.modes.values()],
            activeModeBySpace: this.activeModeBySpace,
            activeSessionBySpace: this.activeSessionBySpace,
            sessions,
          },
          null,
          2,
        ),
      )
    } catch (err) {
      console.warn(`[coach] could not write store: ${err.message}`)
    }
  }

  #log(event) {
    if (!this.logPath) return
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(event) + '\n')
    } catch {
      // best effort
    }
  }

  #cleanSegment(segment) {
    const text = str(segment?.text, 800)
    if (!text) return null
    const at = nowMs(segment?.at)
    return {
      id: str(segment?.id, 80) || randomUUID(),
      clientId: str(segment?.clientId, 120) || null,
      speaker: str(segment?.speaker || 'someone', 32),
      text,
      final: segment?.final !== false,
      at,
    }
  }

  listModes() {
    return [...this.modes.values()]
  }

  getMode(id) {
    return this.modes.get(id) ?? null
  }

  activeMode(space = 'ops') {
    const safeSpace = spaceId(space)
    return this.modes.get(this.activeModeBySpace[safeSpace]) ?? this.modes.get('conversation')
  }

  saveMode(id, patch = {}) {
    const existing = this.modes.get(id)
    if (!existing) return { ok: false, error: 'unknown mode' }
    const merged = modeDefaults({
      ...existing,
      ...patch,
      id: existing.id,
      cueTypes: { ...existing.cueTypes, ...(patch.cueTypes || {}) },
    })
    this.modes.set(existing.id, merged)
    this.#log({ type: 'mode_save', id: existing.id, at: Date.now() })
    this.#persist()
    return { ok: true, mode: merged }
  }

  activateMode(space, modeId) {
    const safeSpace = spaceId(space)
    if (!this.modes.has(modeId)) return { ok: false, error: 'unknown mode' }
    this.activeModeBySpace[safeSpace] = modeId
    this.#log({ type: 'mode_activate', space: safeSpace, modeId, at: Date.now() })
    this.#persist()
    return { ok: true, mode: this.modes.get(modeId), space: safeSpace }
  }

  currentSession(space = 'ops') {
    const safeSpace = spaceId(space)
    const id = this.activeSessionBySpace[safeSpace]
    const session = id ? this.sessions.get(id) : null
    if (!session || session.endedAt) return null
    return session
  }

  session(id) {
    return this.sessions.get(id) ?? null
  }

  removeSession(id) {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: 'unknown session' }
    if (this.activeSessionBySpace[session.space] === id) {
      this.activeSessionBySpace[session.space] = null
    }
    this.sessions.delete(id)
    this.#log({ type: 'session_deleted', id, space: session.space, at: Date.now() })
    this.#persist()
    return { ok: true }
  }

  startSession({ space = 'ops', modeId = null, title = null, clientId = null, context = null, at = Date.now() } = {}) {
    const safeSpace = spaceId(space)
    const current = this.currentSession(safeSpace)
    if (current) {
      const mode = this.getMode(current.modeId)
      return { ok: true, session: publicSession(current, mode), existing: true }
    }

    const mode = this.modes.get(modeId) ?? this.activeMode(safeSpace)
    const startedAt = nowMs(at)
    const session = {
      id: clientId ? `s-${str(clientId, 64)}` : randomUUID(),
      clientId: str(clientId, 120) || null,
      space: safeSpace,
      modeId: mode.id,
      title: str(title || mode.name || 'Listening', 80),
      context: contextDefaults(context),
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      segments: [],
      lastCueAt: null,
      lastRecapAt: null,
    }
    if (this.sessions.has(session.id)) {
      const prior = this.sessions.get(session.id)
      this.activeSessionBySpace[safeSpace] = prior.id
      return { ok: true, session: publicSession(prior, this.getMode(prior.modeId)), existing: true }
    }
    this.sessions.set(session.id, session)
    this.activeSessionBySpace[safeSpace] = session.id
    this.#log({ type: 'session_start', id: session.id, space: safeSpace, modeId: mode.id, at: startedAt })
    this.#persist()
    return { ok: true, session: publicSession(session, mode) }
  }

  endSession(id, at = Date.now()) {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, error: 'unknown session' }
    if (!session.endedAt) {
      session.endedAt = nowMs(at)
      session.updatedAt = session.endedAt
      if (this.activeSessionBySpace[session.space] === id) this.activeSessionBySpace[session.space] = null
      this.#log({ type: 'session_end', id, space: session.space, at: session.endedAt })
      this.#persist()
    }
    return { ok: true, session: publicSession(session, this.getMode(session.modeId)) }
  }

  addSegment(id, segment) {
    const session = this.sessions.get(id)
    if (!session || session.endedAt) return { ok: false, error: 'no active session' }

    if (segment?.clientId) {
      const clientId = str(segment.clientId, 120)
      const existing = session.segments.find(row => row.clientId === clientId)
      if (existing) return { ok: true, segment: existing, session: publicSession(session, this.getMode(session.modeId)), duplicate: true }
    }

    const clean = this.#cleanSegment(segment)
    if (!clean) return { ok: false, error: 'empty segment' }
    session.segments.push(clean)
    session.segments = session.segments.slice(-MAX_SEGMENTS_PER_SESSION)
    session.updatedAt = clean.at
    this.#log({ type: 'segment_add', id: session.id, segmentId: clean.id, speaker: clean.speaker, at: clean.at })
    this.#persist()
    return { ok: true, segment: clean, session: publicSession(session, this.getMode(session.modeId)) }
  }

  markCue(sessionId, { recap = false, at = Date.now() } = {}) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const stamp = nowMs(at)
    session.lastCueAt = stamp
    if (recap) session.lastRecapAt = stamp
    this.#persist()
  }

  snapshot(space = 'ops') {
    const safeSpace = spaceId(space)
    const mode = this.activeMode(safeSpace)
    const session = this.currentSession(safeSpace)
    return {
      space: safeSpace,
      mode,
      modes: this.listModes(),
      session: publicSession(session, session ? this.getMode(session.modeId) : mode),
    }
  }
}

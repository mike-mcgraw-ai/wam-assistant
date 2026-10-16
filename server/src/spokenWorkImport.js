import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { coalesceTranscriptSegments } from './transcript.js'
import { keepPastExpiry, wordCount } from './retention.js'

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function stableId(key) {
  return `sw_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

function firstLine(value) {
  return String(value || '').split('\n').map(line => line.trim()).find(Boolean) || ''
}

function sourceType(session) {
  if (session?.context?.reviewItemId) return 'amendment'
  if (session?.context?.taskId === '__day_start__') return 'start_day'
  if (session?.context?.taskId === '__assistant__') return 'assistant_voice'
  if (session?.context?.taskId || session?.context?.choreId) return 'task_voice_note'
  if (session?.modeId === 'notes') return 'solo_notes'
  if (session?.modeId === 'meeting') return 'meeting'
  if (session?.modeId === 'listening') return 'listening'
  return 'conversation'
}

function noteSessionId(note) {
  if (!String(note?.by || '').startsWith('listen')) return null
  const id = String(note?.id || '')
  if (id.endsWith(':task:note')) return id.slice(0, -10)
  if (id.endsWith(':note')) return id.slice(0, -5)
  return null
}

function mergedSegments(session, archive) {
  const seen = new Set()
  return [...(archive || []), ...(session?.segments || [])]
    .filter(segment => segment?.final !== false && segment?.text)
    .sort((left, right) => (left.at || 0) - (right.at || 0))
    .filter(segment => {
      const key = segment.clientId || segment.id || `${segment.at}:${segment.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function audioInfo(recording, transcript, now) {
  if (!recording?.available) return { sessionId: recording?.sessionId || null,
    state: recording?.expiresAt && recording.expiresAt <= now ? 'expired' : 'missing',
    kept: false, expiresAt: recording?.expiresAt || null }
  const retained = recording.kept === true || keepPastExpiry({
    words: wordCount(Array.isArray(transcript) ? transcript : [transcript]),
    seconds: recording.durationSeconds,
  })
  return {
    sessionId: recording.sessionId,
    state: retained ? 'available' : recording.expiresAt && recording.expiresAt <= now ? 'expiring' : 'available',
    kept: recording.kept === true,
    retained,
    expiresAt: retained ? null : recording.expiresAt || null,
  }
}

function recordingFiles(dataDir) {
  const root = join(dataDir, 'recordings')
  if (!existsSync(root)) return new Map()
  const result = new Map()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifest = readJson(join(dir, 'manifest.json'), null)
    if (!manifest) continue
    const pcm = join(dir, 'audio.pcm')
    const bytes = existsSync(pcm) ? statSync(pcm).size : 0
    const sampleRate = Number(manifest.sampleRate) || 16_000
    const channels = Number(manifest.channels) || 1
    result.set(entry.name, {
      manifest: { ...manifest, sessionId: entry.name, bytes, available: bytes > 0,
        durationSeconds: bytes / (sampleRate * channels * 2) },
      segments: readJsonl(join(dir, 'transcript.jsonl')),
      fullTranscript: String(readJson(join(dir, 'full-transcript.json'), {})?.text || '').trim(),
    })
  }
  return result
}

export function legacySpokenInventory(dataDir, now = Date.now()) {
  const coach = readJson(join(dataDir, 'coach.json'), { sessions: [] })
  const tasks = readJson(join(dataDir, 'tasks.json'), { notes: {}, customTasks: [] })
  const runs = readJson(join(dataDir, 'runs.json'), { notes: {}, dayStarts: {} })
  const assistant = readJson(join(dataDir, 'assistant.json'), { threads: [] })
  const recordings = recordingFiles(dataDir)
  const sessions = new Map((coach.sessions || []).filter(session => session?.id).map(session => [session.id, session]))
  const notes = new Map()
  const addNote = (key, ref) => notes.set(key, [...(notes.get(key) || []), ref])
  const noteCounts = { captured: 0, task: 0, chore: 0 }
  for (const [subjectId, rows] of Object.entries(tasks.notes || {})) {
    for (const note of Array.isArray(rows) ? rows : []) {
      if (!note?.id) continue
      const sessionId = noteSessionId(note)
      if (subjectId === 'captured-notes') noteCounts.captured += 1
      else noteCounts.task += 1
      if (sessionId) addNote(sessionId, { note, kind: 'task', subjectId })
      else if (subjectId === 'captured-notes') addNote(`legacy-note:task:${subjectId}:${note.id}`, { note, kind: 'task', subjectId })
    }
  }
  for (const [subjectId, rows] of Object.entries(runs.notes || {})) {
    for (const note of Array.isArray(rows) ? rows : []) {
      if (!note?.id) continue
      noteCounts.chore += 1
      const sessionId = noteSessionId(note)
      if (sessionId) addNote(sessionId, { note, kind: 'chore', subjectId })
    }
  }
  const assistantTurns = new Map()
  for (const thread of assistant.threads || []) {
    for (const message of thread.messages || []) {
      if (message.role !== 'user') continue
      const match = String(message.clientId || '').match(/^session:(.+)$/)
      if (match) assistantTurns.set(match[1], [...(assistantTurns.get(match[1]) || []), { thread: thread.key, message }])
    }
  }
  const dayRefs = new Map()
  const addDayRef = (sessionId, ref) => {
    if (!sessionId) return
    const rows = dayRefs.get(sessionId) || []
    if (!rows.some(row => row.draftId === ref.draftId && row.itemId === ref.itemId)) rows.push(ref)
    dayRefs.set(sessionId, rows)
  }
  for (const day of Object.values(runs.dayStarts || {})) {
    if (!day || typeof day !== 'object') continue
    const draft = day.draft
    if (draft?.id) {
      addDayRef(draft.id, { day: day.day, draftId: draft.id, itemId: null, committed: false })
      for (const item of draft.items || []) {
        const fallback = String(item.id || '').match(/^task:([^:]+):\d+$/)?.[1]
        for (const sessionId of item.sourceSessionIds?.length ? item.sourceSessionIds : fallback ? [fallback] : []) {
          addDayRef(sessionId, { day: day.day, draftId: draft.id, itemId: item.id, committed: false })
        }
      }
    }
    for (const commit of day.draftCommits || []) {
      for (const link of commit.sourceLinks || []) {
        for (const sessionId of link.sessionIds || []) {
          addDayRef(sessionId, { day: day.day, draftId: commit.id, itemId: link.itemId,
            taskId: link.taskId || null, committed: true })
        }
      }
    }
  }
  const sessionIds = new Set([...sessions.keys(), ...recordings.keys(), ...notes.keys(), ...assistantTurns.keys()])
  const items = []
  const exceptions = []
  for (const id of sessionIds) {
    const session = sessions.get(id)
    const recording = recordings.get(id)
    const linkedNotes = notes.get(id) || []
    const linked = linkedNotes[0]
    const linkedTurns = assistantTurns.get(id) || []
    const assistantTurn = linkedTurns[0]
    const days = dayRefs.get(id) || []
    const day = days[0]
    const legacyOnly = id.startsWith('legacy-note:')
    const sourceKey = legacyOnly ? id : `coach:${id}`
    const segments = mergedSegments(session, recording?.segments)
    const rawText = recording?.fullTranscript || coalesceTranscriptSegments(segments).map(segment => segment.text).join('\n\n')
    const summary = String(recording?.fullTranscript || linked?.note?.text || '').trim()
    const spokenText = rawText || (assistantTurn?.message?.text || '')
    const title = firstLine(summary || spokenText) || (recording?.manifest.available ? 'Recording needs transcript' : 'Untitled spoken work')
    const question = /\bclean the (?:cap|wheel room)\b|\borganize drawers\b/i.test(spokenText)
    const clarificationQuestions = []
    if (/\bclean the cap\b/i.test(spokenText)) clarificationQuestions.push('Did you mean “Clean the kitchen”?')
    if (/\bclean the wheel room\b/i.test(spokenText)) clarificationQuestions.push('Did you mean “Clean the living room”?')
    if (/\borganize drawers\b/i.test(spokenText)) clarificationQuestions.push('Which drawers?')
    if (!spokenText && recording?.manifest.available) clarificationQuestions.push('What was said in this recording?')
    const sourceRefs = []
    if (session) sourceRefs.push({ store: 'coach', id })
    if (recording) sourceRefs.push({ store: 'recordings', id })
    if (session?.context?.taskId && !String(session.context.taskId).startsWith('__')) sourceRefs.push({ store: 'tasks', id: session.context.taskId })
    if (session?.context?.choreId) sourceRefs.push({ store: 'runs', id: session.context.choreId })
    for (const ref of linkedNotes) sourceRefs.push({ store: ref.kind === 'chore' ? 'runs' : 'tasks', id: `${ref.subjectId}:${ref.note.id}` })
    for (const turn of linkedTurns) sourceRefs.push({ store: 'assistant', id: `${turn.thread}:${turn.message.id}` })
    for (const ref of days) if (!sourceRefs.some(row => row.store === 'runs' && row.id === ref.draftId)) sourceRefs.push({ store: 'runs', id: ref.draftId })
    const destinationRefs = []
    for (const task of tasks.customTasks || []) {
      if (task.clientId === `${id}:task` || linkedNotes.some(ref => task.clientId === `promote:${ref.note.id}`)) {
        destinationRefs.push({ kind: 'task', id: task.id, createdAt: null, syncRevision: 1 })
      }
    }
    for (const draftId of [...new Set(days.map(ref => ref.draftId))]) {
      const links = days.filter(ref => ref.draftId === draftId)
      destinationRefs.push({ kind: 'start_day', id: draftId,
        itemIds: [...new Set(links.map(ref => ref.itemId).filter(Boolean))],
        taskIds: [...new Set(links.map(ref => ref.taskId).filter(Boolean))],
        committed: links.some(ref => ref.committed), createdAt: null, syncRevision: 1 })
    }
    if (legacyOnly && !session && !recording) exceptions.push({ sourceKey, reason: 'legacy note has no session or audio' })
    if (!rawText && recording?.manifest.available) exceptions.push({ sourceKey, reason: 'recording has no archived transcript' })
    if (recording && !session && !linkedNotes.length && !assistantTurn && !day) exceptions.push({ sourceKey, reason: 'recording has no matching session or note' })
    if (linkedTurns.length > 1) exceptions.push({ sourceKey, reason: 'multiple assistant turns share one session ID' })
    if (new Set(destinationRefs.filter(ref => ref.kind === 'task').map(ref => ref.id)).size > 1) {
      exceptions.push({ sourceKey, reason: 'multiple exact task destinations need review' })
    }
    items.push({
      id: stableId(sourceKey), schemaVersion: 1, revision: 1, sourceKey,
      sourceAliases: linkedNotes.map(ref => `${ref.kind}-note:${ref.subjectId}:${ref.note.id}`),
      sourceType: legacyOnly ? 'captured_note_legacy' : session ? sourceType(session)
        : assistantTurn ? 'assistant_voice'
          : linked ? linked.subjectId === 'captured-notes' ? 'captured_note_legacy' : 'task_voice_note'
            : 'unknown',
      modeId: session?.modeId || null, space: session?.space || 'life', sessionId: legacyOnly ? null : id,
      sourceRefs, capturedAt: Number(session?.startedAt || recording?.manifest.createdAt || linked?.note?.at || assistantTurn?.message?.at) || null,
      endedAt: Number(session?.endedAt || recording?.manifest.endedAt) || null,
      ingestedAt: null, updatedAt: null,
      rawTranscript: { text: rawText, segments, complete: Boolean(recording?.fullTranscript) || Boolean(recording?.segments?.length) || Boolean(session?.segments?.length && session.segments.length < 240),
        source: recording?.fullTranscript ? 'full-recording' : recording?.segments?.length ? 'recording-transcript' : session ? 'coach' : 'unavailable' },
      audio: audioInfo(recording?.manifest, recording?.fullTranscript || (recording?.segments || []).map(segment => segment.text), now),
      cleanedTranscript: rawText || spokenText, title: title.slice(0, 80), summary: summary || spokenText.slice(0, 1_200),
      candidates: [], classification: day ? 'mixed' : 'unknown',
      confidence: { score: question ? 0.3 : 0.5, reasons: ['legacy source needs review'] },
      clarificationQuestions,
      reviewState: clarificationQuestions.length ? 'needs_clarification' : destinationRefs.length ? 'reviewed' : 'unreviewed',
      extraction: { state: 'not_processed', error: null, transcriptRevision: 1 },
      destinationRefs, parentId: session?.context?.reviewItemId || null,
      amendmentKind: session?.context?.amendmentKind || null,
      amendmentBaseRevision: session?.context?.reviewRevision ?? null,
      childIds: [], mergedInto: null,
      provenance: { ingest: 'legacy-preview', extractor: 'deterministic', modelJobId: null, modelVersion: null, humanEditedFields: [] },
    })
  }
  items.sort((left, right) => right.capturedAt - left.capturedAt || left.id.localeCompare(right.id))
  return { items, exceptions, counts: { capturedNotes: noteCounts.captured, coachSessions: sessions.size,
    recordingDirs: recordings.size, assistantVoiceTurns: assistantTurns.size, cards: items.length } }
}

export function compareSpokenCoverage(inventory, canonicalItems) {
  const legacyKeys = new Set(inventory.items.map(item => item.sourceKey))
  const primary = canonicalItems.filter(item => !item.parentId)
  const canonicalKeys = new Set(canonicalItems.filter(item => !item.parentId || legacyKeys.has(item.sourceKey)).map(item => item.sourceKey))
  return {
    legacyCards: legacyKeys.size,
    canonicalCards: primary.length,
    derivedCards: canonicalItems.filter(item => item.parentId).length,
    matchedSources: [...canonicalKeys].filter(key => legacyKeys.has(key)).length,
    legacyOnly: [...legacyKeys].filter(key => !canonicalKeys.has(key)).sort(),
    canonicalOnly: primary.map(item => item.sourceKey).filter(key => !legacyKeys.has(key)).sort(),
  }
}
